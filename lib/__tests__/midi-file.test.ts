import { describe, expect, it } from "vitest";
import { PPQ, writeMidi } from "@/lib/midi-file";
import type { RecNote, Recording } from "@/lib/recorder";

/* --- tiny SMF reader for assertions --- */
interface Ev { tick: number; bytes: number[] }
function readVlq(d: Uint8Array, i: number): [number, number] {
  let v = 0;
  for (;;) {
    const b = d[i++];
    v = (v << 7) | (b & 0x7f);
    if (!(b & 0x80)) return [v, i];
  }
}
function parse(d: Uint8Array) {
  const ascii = (i: number) => String.fromCharCode(...d.slice(i, i + 4));
  expect(ascii(0)).toBe("MThd");
  const format = (d[8] << 8) | d[9];
  const ntracks = (d[10] << 8) | d[11];
  const division = (d[12] << 8) | d[13];
  const tracks: Ev[][] = [];
  let i = 14;
  for (let t = 0; t < ntracks; t++) {
    expect(ascii(i)).toBe("MTrk");
    const len = (d[i + 4] << 24) | (d[i + 5] << 16) | (d[i + 6] << 8) | d[i + 7];
    const end = i + 8 + len;
    let j = i + 8;
    let tick = 0;
    const evs: Ev[] = [];
    while (j < end) {
      let delta;
      [delta, j] = readVlq(d, j);
      tick += delta;
      const status = d[j];
      let size;
      if (status === 0xff) {
        const [mlen, k] = readVlq(d, j + 2);
        size = k - j + mlen;
      } else size = 3;
      evs.push({ tick, bytes: [...d.slice(j, j + size)] });
      j += size;
    }
    expect(j).toBe(end);
    tracks.push(evs);
    i = end;
  }
  return { format, ntracks, division, tracks };
}
const channelEvents = (evs: Ev[]) => evs.filter((e) => e.bytes[0] < 0xf0);
const meta = (evs: Ev[], type: number) => evs.find((e) => e.bytes[0] === 0xff && e.bytes[1] === type)!;

const note = (source: RecNote["source"], midi: number, start: number, end: number, velocity = 1): RecNote => ({ source, midi, velocity, start, end });
const rec = (notes: RecNote[], extra: Partial<Recording> = {}): Recording => ({
  notes,
  pedals: [],
  duration: 10,
  bpm: 120,
  timeSignature: "4/4",
  ...extra,
});
const BOTH = { live: true, accomp: true };

describe("writeMidi", () => {
  it("writes a Type 1 header with one track per enabled part", () => {
    const r = rec([note("live", 60, 0, 1), note("accomp", 48, 0, 1)]);
    expect(parse(writeMidi(r, BOTH))).toMatchObject({ format: 1, ntracks: 3, division: PPQ });
    expect(parse(writeMidi(r, { live: true, accomp: false })).ntracks).toBe(2);
    expect(parse(writeMidi(r, { live: false, accomp: true })).ntracks).toBe(2);
  });

  it("writes tempo and 4/4 time signature in the conductor track", () => {
    const { tracks } = parse(writeMidi(rec([note("live", 60, 0, 1)]), BOTH));
    expect(meta(tracks[0], 0x51).bytes).toEqual([0xff, 0x51, 3, 0x07, 0xa1, 0x20]); // 500000 µs = 120 bpm
    expect(meta(tracks[0], 0x58).bytes).toEqual([0xff, 0x58, 4, 4, 2, 24, 8]);
  });

  it("writes 12/8 with a dotted-quarter-aware tempo so bars line up", () => {
    const r = rec([note("live", 60, 0, 2)], { bpm: 60, timeSignature: "12/8" });
    const { tracks } = parse(writeMidi(r, BOTH));
    expect(meta(tracks[0], 0x58).bytes).toEqual([0xff, 0x58, 4, 12, 3, 36, 8]);
    // quarter bpm = 90 → 666667 µs
    expect(meta(tracks[0], 0x51).bytes).toEqual([0xff, 0x51, 3, 0x0a, 0x2c, 0x2b]);
    // One app bar at 60 bpm = 4 s; one 12/8 bar in MIDI = 6 quarters = 2880 ticks. 2 s → 1440.
    const offs = channelEvents(tracks[1]).filter((e) => (e.bytes[0] & 0xf0) === 0x80);
    expect(offs[0].tick).toBe(1440);
  });

  it("converts seconds to ticks and scales velocity on the right channels", () => {
    const r = rec([note("live", 60, 0.5, 1, 0.5), note("accomp", 48, 1, 1.5, 0)]);
    const { tracks } = parse(writeMidi(r, BOTH));
    expect(channelEvents(tracks[1])).toEqual([
      { tick: 480, bytes: [0x90, 60, 64] },
      { tick: 960, bytes: [0x80, 60, 64] },
    ]);
    expect(channelEvents(tracks[2])).toEqual([
      { tick: 960, bytes: [0x91, 48, 1] }, // velocity clamped to ≥ 1
      { tick: 1440, bytes: [0x81, 48, 64] },
    ]);
  });

  it("writes pedal events as CC64 on the live track", () => {
    const r = rec([note("live", 60, 0, 1)], { pedals: [{ time: 0.25, down: true }, { time: 1, down: false }] });
    const cc = channelEvents(parse(writeMidi(r, BOTH)).tracks[1]).filter((e) => e.bytes[0] === 0xb0);
    expect(cc).toEqual([
      { tick: 240, bytes: [0xb0, 64, 127] },
      { tick: 960, bytes: [0xb0, 64, 0] },
    ]);
  });

  it("truncates an earlier same-pitch note at the next onset (off before on)", () => {
    const r = rec([note("accomp", 48, 0, 2), note("accomp", 48, 1, 1.5)]);
    expect(channelEvents(parse(writeMidi(r, BOTH)).tracks[2]).map((e) => [e.tick, e.bytes[0] & 0xf0])).toEqual([
      [0, 0x90],
      [960, 0x80],
      [960, 0x90],
      [1440, 0x80],
    ]);
  });

  it("merges same-pitch notes with the same onset", () => {
    const r = rec([note("accomp", 48, 0, 1, 0.5), note("accomp", 48, 0, 2, 1)]);
    expect(channelEvents(parse(writeMidi(r, BOTH)).tracks[2])).toEqual([
      { tick: 0, bytes: [0x91, 48, 127] },
      { tick: 1920, bytes: [0x81, 48, 64] },
    ]);
  });

  it("gives zero-length notes at least one tick", () => {
    const r = rec([note("live", 60, 1, 1)]);
    expect(channelEvents(parse(writeMidi(r, BOTH)).tracks[1]).map((e) => e.tick)).toEqual([960, 961]);
  });

  it("encodes long delta times as multi-byte VLQ", () => {
    const r = rec([note("live", 60, 0, 100)], { duration: 100 }); // 96000 ticks
    const offs = channelEvents(parse(writeMidi(r, BOTH)).tracks[1]);
    expect(offs[1].tick).toBe(96000);
  });

  it("ends every track with End-of-Track", () => {
    const { tracks } = parse(writeMidi(rec([note("live", 60, 0, 1)]), BOTH));
    for (const t of tracks) expect(t.at(-1)!.bytes).toEqual([0xff, 0x2f, 0]);
  });
});
