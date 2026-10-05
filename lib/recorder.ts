/**
 * Recorder — a plain event log of what the audio engine actually sounded.
 *
 * Every time is AudioContext time (live notes: `Tone.immediate()`, accompaniment: the scheduled
 * time from the sequencer tick), so both parts line up exactly. Stored times are relative to
 * the Rec press. MIDI and MP3 exports are both derived from the resulting `Recording`.
 */

import type { TimeSignature } from "@/lib/styles";

export type RecSource = "live" | "accomp";

export interface RecNote {
  source: RecSource;
  midi: number;
  /** 0–1, as passed to the voice. */
  velocity: number;
  /** Seconds from the Rec press. */
  start: number;
  end: number;
}

/** Sustain pedal (CC64) change, live part only. */
export interface RecPedal {
  time: number;
  down: boolean;
}

export interface Recording {
  notes: RecNote[];
  pedals: RecPedal[];
  /** Rec press → Stop press, seconds. */
  duration: number;
  /** Tempo and meter at the Rec press. */
  bpm: number;
  timeSignature: TimeSignature;
}

export interface PartFilter {
  live: boolean;
  accomp: boolean;
}

export class Recorder {
  private active = false;
  private t0 = 0;
  private meta: { bpm: number; timeSignature: TimeSignature } = { bpm: 120, timeSignature: "4/4" };
  private notes: RecNote[] = [];
  private pedals: RecPedal[] = [];
  /** Live keys currently down: midi → onset. */
  private open = new Map<number, { velocity: number; start: number }>();

  get isRecording() {
    return this.active;
  }

  start(now: number, meta: { bpm: number; timeSignature: TimeSignature }) {
    this.active = true;
    this.t0 = now;
    this.meta = meta;
    this.notes = [];
    this.pedals = [];
    this.open.clear();
  }

  noteOn(midi: number, velocity: number, time: number) {
    if (!this.active) return;
    this.closeLive(midi, time);
    this.open.set(midi, { velocity, start: time - this.t0 });
  }

  noteOff(midi: number, time: number) {
    if (!this.active) return;
    this.closeLive(midi, time);
  }

  pedal(down: boolean, time: number) {
    if (!this.active) return;
    this.pedals.push({ time: time - this.t0, down });
  }

  /** A note whose length is known up front (sequencer notes, chord previews). */
  scheduled(source: RecSource, midi: number, velocity: number, start: number, end: number) {
    if (!this.active) return;
    this.notes.push({ source, midi, velocity, start: start - this.t0, end: end - this.t0 });
  }

  /**
   * Ends the session. Keys still held are closed at `now`; sequencer notes already scheduled
   * through the look-ahead but not yet heard are dropped; everything is clamped to the stop.
   */
  stop(now: number): Recording {
    for (const midi of [...this.open.keys()]) this.closeLive(midi, now);
    this.active = false;
    const duration = Math.max(0, now - this.t0);
    const notes = this.notes
      .filter((n) => n.start < duration)
      .map((n) => ({ ...n, start: Math.max(0, n.start), end: Math.min(duration, n.end) }))
      .sort((a, b) => a.start - b.start);
    const pedals = this.pedals.filter((p) => p.time <= duration);
    return { notes, pedals, duration, ...this.meta };
  }

  private closeLive(midi: number, time: number) {
    const o = this.open.get(midi);
    if (!o) return;
    this.open.delete(midi);
    this.notes.push({ source: "live", midi, velocity: o.velocity, start: o.start, end: Math.max(o.start, time - this.t0) });
  }
}

export const recorder = new Recorder();

export const selectNotes = (rec: Recording, filter: PartFilter) =>
  rec.notes.filter((n) => (n.source === "live" ? filter.live : filter.accomp));

/** Cache key for one export of the current recording. */
export const exportKey = (format: "midi" | "mp3", filter: PartFilter) =>
  `${format}:${filter.live ? "L" : ""}${filter.accomp ? "A" : ""}`;

const pad = (n: number) => String(n).padStart(2, "0");

export const recordingFileStem = (d: Date) =>
  `piano-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
