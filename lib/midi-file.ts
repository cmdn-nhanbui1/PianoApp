/**
 * Standard MIDI File writer (Type 1). Track 0 carries tempo + meter, then one track per part:
 * Live on channel 1 (with sustain pedal), Accompaniment on channel 2.
 */

import { selectNotes, type PartFilter, type RecNote, type Recording } from "@/lib/recorder";
import type { TimeSignature } from "@/lib/styles";

export const PPQ = 480;

/** [numerator, log2(denominator), MIDI clocks per click, 32nds per quarter] */
const TIME_SIG_BYTES: Record<TimeSignature, number[]> = {
  "4/4": [4, 2, 24, 8],
  "3/4": [3, 2, 24, 8],
  "12/8": [12, 3, 36, 8],
};

/**
 * The app's 12/8 bar is 4 Tone beats of triplet eighths (see lib/styles.ts), i.e. 6 real
 * quarter notes, so the MIDI quarter-note tempo is 1.5× the transport BPM.
 */
const quarterBpm = (rec: Recording) => (rec.timeSignature === "12/8" ? rec.bpm * 1.5 : rec.bpm);

/** Same-tick ordering: note-off, then controllers, then note-on (so re-triggers work). */
const ORDER_OFF = 0;
const ORDER_CC = 1;
const ORDER_ON = 2;

interface TrackEvent {
  tick: number;
  order: number;
  bytes: number[];
}

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  for (n = Math.floor(n / 128); n > 0; n = Math.floor(n / 128)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

const text = (s: string) => [...new TextEncoder().encode(s)];
const metaEvent = (type: number, data: number[]): TrackEvent => ({ tick: 0, order: ORDER_CC, bytes: [0xff, type, ...vlq(data.length), ...data] });

function chunk(id: string, body: number[]): number[] {
  const n = body.length;
  return [...text(id), (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff, ...body];
}

function track(name: string, events: TrackEvent[]): number[] {
  const sorted = [...events].sort((a, b) => a.tick - b.tick || a.order - b.order);
  const body: number[] = [0, 0xff, 0x03, ...vlq(text(name).length), ...text(name)];
  let last = 0;
  for (const e of sorted) {
    body.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  body.push(0, 0xff, 0x2f, 0);
  return chunk("MTrk", body);
}

const midiVelocity = (v: number) => Math.min(127, Math.max(1, Math.round(v * 127)));

function noteEvents(notes: RecNote[], channel: number, toTick: (sec: number) => number): TrackEvent[] {
  const sorted = notes
    .map((n) => ({ midi: n.midi, vel: midiVelocity(n.velocity), on: toTick(n.start), off: toTick(n.end) }))
    .sort((a, b) => a.on - b.on);
  const lastByPitch = new Map<number, (typeof sorted)[number]>();
  const kept: typeof sorted = [];
  for (const n of sorted) {
    const prev = lastByPitch.get(n.midi);
    if (prev && prev.off > n.on) {
      if (prev.on === n.on) {
        // Same pitch, same onset: one key can only be struck once.
        prev.off = Math.max(prev.off, n.off);
        prev.vel = Math.max(prev.vel, n.vel);
        continue;
      }
      prev.off = n.on; // ringing note is cut by the re-strike
    }
    n.off = Math.max(n.off, n.on + 1);
    kept.push(n);
    lastByPitch.set(n.midi, n);
  }
  return kept.flatMap((n) => [
    { tick: n.on, order: ORDER_ON, bytes: [0x90 | channel, n.midi, n.vel] },
    { tick: n.off, order: ORDER_OFF, bytes: [0x80 | channel, n.midi, 64] },
  ]);
}

export function writeMidi(rec: Recording, filter: PartFilter): Uint8Array<ArrayBuffer> {
  const qbpm = quarterBpm(rec);
  const toTick = (sec: number) => Math.max(0, Math.round((sec * qbpm * PPQ) / 60));
  const tempo = Math.round(60_000_000 / qbpm);

  const tracks: number[][] = [
    track("Piano Accompaniment Studio", [
      metaEvent(0x51, [(tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff]),
      metaEvent(0x58, TIME_SIG_BYTES[rec.timeSignature]),
    ]),
  ];
  if (filter.live) {
    const live = selectNotes(rec, { live: true, accomp: false });
    const pedals: TrackEvent[] = rec.pedals.map((p) => ({ tick: toTick(p.time), order: ORDER_CC, bytes: [0xb0, 64, p.down ? 127 : 0] }));
    tracks.push(track("Piano - Live", [...noteEvents(live, 0, toTick), ...pedals]));
  }
  if (filter.accomp) {
    const accomp = selectNotes(rec, { live: false, accomp: true });
    tracks.push(track("Piano - Accompaniment", noteEvents(accomp, 1, toTick)));
  }

  const header = chunk("MThd", [0, 1, 0, tracks.length, PPQ >> 8, PPQ & 0xff]);
  return Uint8Array.from([...header, ...tracks.flat()]);
}
