# Recording (MIDI + MP3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user record live playing and/or accompaniment and export it as a Type-1 MIDI file or a 320 kbps MP3.

**Architecture:** The audio engine logs every note it actually sounds (AudioContext clock) into a pure `recorder`. Exports are derived from that log: a hand-written SMF writer for MIDI, and a `Tone.Offline` re-render through the same piano chain plus LAME (WASM, in a Web Worker) for MP3. A small controller owns the in-memory recording, export cache and object URLs; two React components expose it.

**Tech Stack:** Next.js 15 / React 19, Tone.js 15, Zustand 5, `wasm-media-encoders` 0.7 (LAME → WASM), vitest 5.

**Spec:** `docs/superpowers/specs/2026-10-02-recording-design.md`

## Global Constraints

- Formats: MIDI = SMF **Type 1, PPQ 480**; MP3 = **320 kbps CBR, stereo, 44.1 kHz**, LAME. No `MediaRecorder`.
- **Metronome is never recorded.**
- Rec starts immediately and is independent of the transport (play/pause/stop do not start or stop recording).
- Live/Đệm filter is applied at **export** time; at least one part must be enabled to start recording.
- MP3 render volume is independent of the volume slider (equivalent to slider = 100, i.e. `MASTER_GAIN_DB`).
- Recording and blobs live in memory only; only `recFormat`, `recLive`, `recAccomp` are persisted.
- Filenames: `piano-YYYY-MM-DD-HHmm.mid` / `.mp3`, local time of record start.
- UI copy is Vietnamese, matching the existing app ("Đệm", "Đang render…", "Đang mã hóa…", "Không có nốt nào").
- Everything client-side; no server code.

## Review Focus

1. **Same-pitch overlap in accompaniment** — pattern notes ring past the next hit of the same pitch (pedal-length `sound`); in MIDI the earlier note-off would cut the new note. Expect: earlier note truncated to the next onset. *(Test in Task 2.)*
2. **12/8 meter** — the app's 12/8 bar is 4 Tone quarter-beats of triplet eighths; written naively the DAW bar grid is wrong. Expect: MIDI tempo = `bpm × 1.5` for 12/8 so a 12/8 bar lines up. *(Test in Task 2.)*
3. **Stop while keys/pedal are held** — expect held live notes closed at stop; accompaniment notes scheduled via look-ahead but not yet heard are dropped. *(Test in Task 1.)*
4. **Format/filter switched while an MP3 render is running, or recording discarded mid-render** — expect jobs serialized, stale results discarded, no leaked object URLs. *(Covered by controller design in Task 6; verified in Task 8 E2E.)*
5. **Zero-length / sub-tick notes** (very fast taps, chord-preview edge) — expect note-off strictly after note-on in MIDI, never a stuck note. *(Test in Task 2.)*

---

## File Structure

| File | Responsibility |
|---|---|
| `lib/recorder.ts` (new) | Pure event log: types `Recording`, `RecNote`, `RecPedal`; `Recorder` class + singleton; `selectNotes`, `exportKey`, `recordingFileStem` helpers |
| `lib/midi-file.ts` (new) | `writeMidi(rec, filter): Uint8Array` — SMF writer |
| `lib/live-replay.ts` (new) | Pure: turns live notes + pedal events into attack/release commands with engine pedal semantics |
| `lib/pcm.ts` (new) | Pure: `trimTail` (cut trailing silence below −80 dBFS + 50 ms fade) |
| `lib/piano-voice.ts` (new) | Shared Tone graph: `PIANO_ENVELOPE`, `MASTER_GAIN_DB`, `buildPianoChain`, `makePianoVoice` |
| `lib/mp3.worker.ts` (new) | Web Worker: Float32 stereo → MP3 Blob via `wasm-media-encoders` |
| `lib/render-audio.ts` (new) | `renderMp3(rec, filter, samples, onPhase): Promise<Blob>` (Tone.Offline + trim + worker) |
| `lib/recording-controller.ts` (new) | Start/stop, in-memory recording, serialized export jobs, object-URL lifecycle |
| `components/RecorderPanel.tsx` (new) | Format toggle, Live/Đệm chips, Rec button, timer |
| `components/RecordingResult.tsx` (new) | Result strip: info, preview, download, discard, retry |
| `hooks/useAudioEngine.ts` (modify) | Use `piano-voice`, keep sample map, recorder hooks, `startRecording`/`stopRecording` |
| `store/useMusicStore.ts` (modify) | Recording state + persisted options |
| `components/ControlPanel.tsx`, `app/page.tsx`, `hooks/useComputerKeyboard.ts` (modify) | Mount UI, `R` shortcut |
| `vitest.config.ts`, `package.json` (modify) | Test runner, deps |

Tests live in `lib/__tests__/`.

**Refinement vs spec:** the spec's single `recState` enum (`idle|recording|rendering|done|error`) is split into `recState: idle|recording|ready` plus per-export `recJob` / `recError` / `recExports`, because one recording can have several exports (format × filter) in different states. Behaviour is unchanged.

---

### Task 0: Branch and baseline

The repo's only commit is the spec; the existing app is staged but uncommitted. Commit it as a baseline so feature commits contain only feature changes.

- [ ] **Step 1: Baseline commit of the already-staged app (on main)**

```bash
git commit -m "chore: baseline Piano Accompaniment Studio app

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Expected: commit containing the staged files listed in `git status` (no new files added).

- [ ] **Step 2: Create the feature branch**

```bash
git switch -c feature/recording
```

---

### Task 1: Test runner + event recorder

**Files:**
- Create: `vitest.config.ts`, `lib/recorder.ts`, `lib/__tests__/recorder.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces:
  ```ts
  export type RecSource = "live" | "accomp";
  export interface RecNote { source: RecSource; midi: number; velocity: number; start: number; end: number }
  export interface RecPedal { time: number; down: boolean }
  export interface Recording { notes: RecNote[]; pedals: RecPedal[]; duration: number; bpm: number; timeSignature: TimeSignature }
  export interface PartFilter { live: boolean; accomp: boolean }
  export class Recorder {
    get isRecording(): boolean;
    start(now: number, meta: { bpm: number; timeSignature: TimeSignature }): void;
    noteOn(midi: number, velocity: number, time: number): void;   // live
    noteOff(midi: number, time: number): void;                     // live
    pedal(down: boolean, time: number): void;                      // live CC64
    scheduled(source: RecSource, midi: number, velocity: number, start: number, end: number): void;
    stop(now: number): Recording;
  }
  export const recorder: Recorder;
  export function selectNotes(rec: Recording, filter: PartFilter): RecNote[];
  export function exportKey(format: "midi" | "mp3", filter: PartFilter): string;
  export function recordingFileStem(d: Date): string; // "piano-2026-10-02-1430"
  ```
  All `time`/`start`/`end` arguments are absolute AudioContext seconds; stored values are relative to `start(now)`.

- [ ] **Step 1: Install vitest and add the script**

```bash
pnpm add -D vitest@^5
```
In `package.json` `"scripts"`, add after `"typecheck"`:
```json
    "test": "vitest run"
```

Create `vitest.config.ts`:
```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: { include: ["lib/__tests__/**/*.test.ts"] },
});
```

- [ ] **Step 2: Write the failing tests**

`lib/__tests__/recorder.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { exportKey, Recorder, recordingFileStem, selectNotes } from "@/lib/recorder";

const META = { bpm: 100, timeSignature: "4/4" as const };

describe("Recorder", () => {
  it("ignores everything while idle", () => {
    const r = new Recorder();
    r.noteOn(60, 0.5, 1);
    r.noteOff(60, 2);
    r.pedal(true, 1);
    r.scheduled("accomp", 48, 0.5, 1, 2);
    expect(r.isRecording).toBe(false);
    r.start(10, META);
    const rec = r.stop(11);
    expect(rec.notes).toEqual([]);
    expect(rec.pedals).toEqual([]);
  });

  it("records live notes relative to the start time", () => {
    const r = new Recorder();
    r.start(10, META);
    r.noteOn(60, 0.8, 10.5);
    r.noteOff(60, 11.25);
    const rec = r.stop(12);
    expect(rec).toMatchObject({ duration: 2, bpm: 100, timeSignature: "4/4" });
    expect(rec.notes).toEqual([{ source: "live", midi: 60, velocity: 0.8, start: 0.5, end: 1.25 }]);
  });

  it("closes an open pitch before re-triggering it", () => {
    const r = new Recorder();
    r.start(0, META);
    r.noteOn(60, 0.5, 1);
    r.noteOn(60, 0.9, 2);
    r.noteOff(60, 3);
    const rec = r.stop(4);
    expect(rec.notes.map((n) => [n.start, n.end, n.velocity])).toEqual([
      [1, 2, 0.5],
      [2, 3, 0.9],
    ]);
  });

  it("closes held live notes at stop", () => {
    const r = new Recorder();
    r.start(0, META);
    r.noteOn(64, 0.7, 1);
    const rec = r.stop(3);
    expect(rec.notes).toEqual([{ source: "live", midi: 64, velocity: 0.7, start: 1, end: 3 }]);
    expect(r.isRecording).toBe(false);
  });

  it("drops scheduled notes not yet heard at stop and clamps ends", () => {
    const r = new Recorder();
    r.start(5, META);
    r.scheduled("accomp", 48, 0.6, 5.5, 9); // rings past stop → clamped
    r.scheduled("accomp", 52, 0.6, 7.05, 7.5); // look-ahead, starts after stop → dropped
    const rec = r.stop(7);
    expect(rec.notes).toEqual([{ source: "accomp", midi: 48, velocity: 0.6, start: 0.5, end: 2 }]);
  });

  it("records pedal events and drops ones after stop", () => {
    const r = new Recorder();
    r.start(1, META);
    r.pedal(true, 1.5);
    r.pedal(false, 2.5);
    r.pedal(true, 3.5); // after the stop below
    const rec = r.stop(3);
    expect(rec.pedals).toEqual([
      { time: 0.5, down: true },
      { time: 1.5, down: false },
    ]);
  });

  it("sorts notes by start time", () => {
    const r = new Recorder();
    r.start(0, META);
    r.noteOn(60, 0.5, 1);
    r.scheduled("accomp", 48, 0.5, 0.5, 1.5);
    r.noteOff(60, 2);
    const rec = r.stop(3);
    expect(rec.notes.map((n) => n.midi)).toEqual([48, 60]);
  });

  it("starts a fresh log on every start()", () => {
    const r = new Recorder();
    r.start(0, META);
    r.noteOn(60, 0.5, 0.1);
    r.stop(1);
    r.start(5, META);
    expect(r.stop(6).notes).toEqual([]);
  });
});

describe("helpers", () => {
  const rec = {
    notes: [
      { source: "live" as const, midi: 60, velocity: 1, start: 0, end: 1 },
      { source: "accomp" as const, midi: 48, velocity: 1, start: 0, end: 1 },
    ],
    pedals: [],
    duration: 1,
    bpm: 120,
    timeSignature: "4/4" as const,
  };

  it("selectNotes filters by part", () => {
    expect(selectNotes(rec, { live: true, accomp: false }).map((n) => n.midi)).toEqual([60]);
    expect(selectNotes(rec, { live: false, accomp: true }).map((n) => n.midi)).toEqual([48]);
    expect(selectNotes(rec, { live: true, accomp: true })).toHaveLength(2);
  });

  it("exportKey is distinct per format and filter", () => {
    expect(exportKey("mp3", { live: true, accomp: false })).toBe("mp3:L");
    expect(exportKey("midi", { live: true, accomp: true })).toBe("midi:LA");
  });

  it("recordingFileStem uses local time", () => {
    expect(recordingFileStem(new Date(2026, 9, 2, 14, 5))).toBe("piano-2026-10-02-1405");
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test`
Expected: FAIL — cannot resolve `@/lib/recorder`.

- [ ] **Step 4: Implement `lib/recorder.ts`**

```ts
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
```

- [ ] **Step 5: Run tests**

Run: `pnpm test`
Expected: all `recorder.test.ts` tests PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts lib/recorder.ts lib/__tests__/recorder.test.ts
git commit -m "feat(recording): event recorder + vitest

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: MIDI file writer

**Files:**
- Create: `lib/midi-file.ts`, `lib/__tests__/midi-file.test.ts`

**Interfaces:**
- Consumes: `Recording`, `PartFilter`, `selectNotes` from `lib/recorder.ts`.
- Produces: `export function writeMidi(rec: Recording, filter: PartFilter): Uint8Array`, `export const PPQ = 480`.

Encoding rules:
- Header `MThd`, length 6, format 1, ntracks = 1 + enabled parts, division 480.
- Track 0: name "Piano Accompaniment Studio", tempo, time signature, end-of-track.
- Live track: name "Piano - Live", channel 0 (MIDI ch 1), notes + CC64 (127 down / 0 up).
- Accomp track: name "Piano - Accompaniment", channel 1 (MIDI ch 2), notes.
- Quarter-note BPM written to MIDI: `bpm` for 4/4 and 3/4, `bpm × 1.5` for 12/8 (the app's 12/8 bar = 4 Tone beats of triplet eighths = 6 MIDI quarters). Tempo meta = `round(60_000_000 / quarterBpm)` µs.
- Time signature meta `FF 58 04 nn dd cc bb`: 4/4 → `4 2 24 8`, 3/4 → `3 2 24 8`, 12/8 → `12 3 36 8`.
- Ticks: `round(sec × quarterBpm / 60 × 480)`.
- Velocity: `clamp(round(v × 127), 1, 127)`; note-off velocity 64.
- Same-pitch overlap within a track: earlier note truncated to the next onset; identical onsets merged (longer end, louder velocity).
- Every note lasts ≥ 1 tick. Same-tick ordering: note-off < CC < note-on.

- [ ] **Step 1: Write the failing tests**

`lib/__tests__/midi-file.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test lib/__tests__/midi-file.test.ts`
Expected: FAIL — cannot resolve `@/lib/midi-file`.

- [ ] **Step 3: Implement `lib/midi-file.ts`**

```ts
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

export function writeMidi(rec: Recording, filter: PartFilter): Uint8Array {
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
```

- [ ] **Step 4: Run tests**

Run: `pnpm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/midi-file.ts lib/__tests__/midi-file.test.ts
git commit -m "feat(recording): Type-1 MIDI file writer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Pure render helpers (live replay + PCM tail trim)

**Files:**
- Create: `lib/live-replay.ts`, `lib/pcm.ts`, `lib/__tests__/live-replay.test.ts`, `lib/__tests__/pcm.test.ts`

**Interfaces:**
- Consumes: `RecNote`, `RecPedal` from `lib/recorder.ts`.
- Produces:
  ```ts
  // lib/live-replay.ts
  export type VoiceCommand = { type: "attack"; midi: number; time: number; velocity: number } | { type: "release"; midi: number; time: number };
  export function liveVoiceCommands(notes: RecNote[], pedals: RecPedal[], releaseAllAt: number): VoiceCommand[];
  // lib/pcm.ts
  export function trimTail(channels: Float32Array[], sampleRate: number, thresholdDb?: number, fadeMs?: number): Float32Array[];
  ```

Live replay must match `AudioEngine.liveNoteOn/liveNoteOff/setPedal`: key-up while pedal is down keeps the note sounding; pedal-up releases every note whose key is no longer held; re-striking a sustained key removes it from the sustained set. Any note still sounding after the last event is released at `releaseAllAt`.

- [ ] **Step 1: Write the failing tests**

`lib/__tests__/live-replay.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { liveVoiceCommands } from "@/lib/live-replay";
import type { RecNote } from "@/lib/recorder";

const n = (midi: number, start: number, end: number, velocity = 0.5): RecNote => ({ source: "live", midi, velocity, start, end });
const brief = (cmds: ReturnType<typeof liveVoiceCommands>) => cmds.map((c) => `${c.type[0]}${c.midi}@${c.time}`);

describe("liveVoiceCommands", () => {
  it("attacks and releases with no pedal", () => {
    expect(brief(liveVoiceCommands([n(60, 0, 1)], [], 9))).toEqual(["a60@0", "r60@1"]);
  });

  it("holds released keys while the pedal is down, damps them on pedal up", () => {
    const cmds = liveVoiceCommands([n(60, 0, 1), n(64, 0.5, 3)], [{ time: 0.2, down: true }, { time: 2, down: false }], 9);
    // 60 released at key-up 1 is held; on pedal up at 2 only 60 is damped (64 still held); 64 released at 3.
    expect(brief(cmds)).toEqual(["a60@0", "a64@0.5", "r60@2", "r64@3"]);
  });

  it("re-striking a sustained key keeps it out of the damp list", () => {
    const cmds = liveVoiceCommands([n(60, 0, 1), n(60, 1.5, 3)], [{ time: 0, down: true }, { time: 2, down: false }], 9);
    expect(brief(cmds)).toEqual(["a60@0", "a60@1.5", "r60@3"]);
  });

  it("releases notes still sustained at the end", () => {
    const cmds = liveVoiceCommands([n(60, 0, 1)], [{ time: 0, down: true }], 5);
    expect(brief(cmds)).toEqual(["a60@0", "r60@5"]);
  });

  it("keeps velocity on attacks", () => {
    expect(liveVoiceCommands([n(60, 0, 1, 0.9)], [], 9)[0]).toEqual({ type: "attack", midi: 60, time: 0, velocity: 0.9 });
  });
});
```

`lib/__tests__/pcm.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { trimTail } from "@/lib/pcm";

const SR = 1000; // 1 kHz keeps the numbers readable

describe("trimTail", () => {
  it("cuts trailing silence below the threshold on all channels", () => {
    const l = new Float32Array(3000);
    const r = new Float32Array(3000);
    l.fill(0.5, 0, 1000);
    r.fill(0.5, 0, 1500); // right channel rings longer → keep up to 1500
    const [tl, tr] = trimTail([l, r], SR);
    expect(tl.length).toBe(1500);
    expect(tr.length).toBe(1500);
  });

  it("applies a linear fade over the last fadeMs", () => {
    const l = new Float32Array(1000).fill(1);
    const [out] = trimTail([l], SR, -80, 50);
    expect(out.length).toBe(1000);
    expect(out[949]).toBeCloseTo(1, 5);
    expect(out[999]).toBeCloseTo(0, 1);
    expect(out[975]).toBeGreaterThan(0.3);
    expect(out[975]).toBeLessThan(0.7);
  });

  it("does not modify the input arrays", () => {
    const l = new Float32Array(100).fill(1);
    trimTail([l], SR);
    expect(l[99]).toBe(1);
  });

  it("returns empty channels for complete silence", () => {
    const [out] = trimTail([new Float32Array(500)], SR);
    expect(out.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test`
Expected: FAIL — cannot resolve `@/lib/live-replay` / `@/lib/pcm`.

- [ ] **Step 3: Implement `lib/live-replay.ts`**

```ts
/**
 * Turns the recorded live part back into voice commands, with the same sustain-pedal rules as
 * AudioEngine.liveNoteOn/liveNoteOff/setPedal — so the offline render damps exactly like the
 * real-time engine did.
 */

import type { RecNote, RecPedal } from "@/lib/recorder";

export type VoiceCommand =
  | { type: "attack"; midi: number; time: number; velocity: number }
  | { type: "release"; midi: number; time: number };

type Event =
  | { time: number; order: number; kind: "on"; midi: number; velocity: number }
  | { time: number; order: number; kind: "off"; midi: number }
  | { time: number; order: number; kind: "pedal"; down: boolean };

export function liveVoiceCommands(notes: RecNote[], pedals: RecPedal[], releaseAllAt: number): VoiceCommand[] {
  const events: Event[] = [
    ...notes.flatMap((n): Event[] => [
      { time: n.start, order: 2, kind: "on", midi: n.midi, velocity: n.velocity },
      { time: n.end, order: 0, kind: "off", midi: n.midi },
    ]),
    ...pedals.map((p): Event => ({ time: p.time, order: 1, kind: "pedal", down: p.down })),
  ].sort((a, b) => a.time - b.time || a.order - b.order);

  const out: VoiceCommand[] = [];
  const held = new Set<number>();
  const sustained = new Set<number>();
  let pedalDown = false;

  for (const e of events) {
    if (e.kind === "on") {
      held.add(e.midi);
      sustained.delete(e.midi);
      out.push({ type: "attack", midi: e.midi, time: e.time, velocity: e.velocity });
    } else if (e.kind === "off") {
      held.delete(e.midi);
      if (pedalDown) sustained.add(e.midi);
      else out.push({ type: "release", midi: e.midi, time: e.time });
    } else {
      pedalDown = e.down;
      if (e.down) continue;
      for (const midi of sustained) if (!held.has(midi)) out.push({ type: "release", midi, time: e.time });
      sustained.clear();
    }
  }
  for (const midi of sustained) out.push({ type: "release", midi, time: releaseAllAt });
  return out;
}
```

- [ ] **Step 4: Implement `lib/pcm.ts`**

```ts
/** Cuts the silent tail of a render (any channel above the threshold counts) and fades out. */
export function trimTail(channels: Float32Array[], sampleRate: number, thresholdDb = -80, fadeMs = 50): Float32Array[] {
  const threshold = Math.pow(10, thresholdDb / 20);
  let end = 0;
  for (const ch of channels) {
    for (let i = ch.length - 1; i >= end; i--) {
      if (Math.abs(ch[i]) > threshold) {
        end = i + 1;
        break;
      }
    }
  }
  const fade = Math.min(end, Math.round((fadeMs / 1000) * sampleRate));
  return channels.map((ch) => {
    const out = ch.slice(0, end);
    for (let i = 0; i < fade; i++) out[end - fade + i] *= 1 - (i + 1) / fade;
    return out;
  });
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/live-replay.ts lib/pcm.ts lib/__tests__/live-replay.test.ts lib/__tests__/pcm.test.ts
git commit -m "feat(recording): live pedal replay + PCM tail trim

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Store state, shared piano chain, engine hooks

**Files:**
- Create: `lib/piano-voice.ts`
- Modify: `hooks/useAudioEngine.ts`, `store/useMusicStore.ts`

**Interfaces:**
- Consumes: `recorder`, `Recording` (Task 1).
- Produces:
  ```ts
  // lib/piano-voice.ts
  export const PIANO_ENVELOPE: { attack; decay; sustain; release };
  export const MASTER_GAIN_DB = 8;
  export type PianoVoice = ToneNS.Sampler | ToneNS.PolySynth;
  export type SampleMap = Record<string, ToneNS.ToneAudioBuffer>;
  export function buildPianoChain(Tone: typeof ToneNS, volumeDb: number): { input: ToneNS.InputNode; master: ToneNS.Volume; ready: Promise<void> };
  export function makePianoVoice(Tone: typeof ToneNS, samples: SampleMap | null, output: ToneNS.InputNode): PianoVoice;
  // AudioEngine (hooks/useAudioEngine.ts)
  get renderSamples(): SampleMap | null;   // null = synth fallback
  startRecording(): void;                  // requires unlock() first
  stopRecording(): Recording;
  // store
  export type RecFormat = "midi" | "mp3";
  export type RecPhase = "render" | "encode";
  export interface RecInfo { duration: number; liveNotes: number; accompNotes: number; synth: boolean; fileStem: string }
  state: recState: "idle" | "recording" | "ready"; recStartedAt: number; recFormat: RecFormat; recLive: boolean; recAccomp: boolean;
         recInfo: RecInfo | null; recExports: Record<string, string>; recJob: { key: string; phase: RecPhase } | null; recError: { key: string; message: string } | null;
  actions: setRec(p: Partial<RecordingState>): void; setRecFormat(f: RecFormat): void; setRecLive(on: boolean): void; setRecAccomp(on: boolean): void;
  ```

No unit tests for this task (Tone graph + store wiring); verified by typecheck, existing app behaviour, and Task 8 E2E.

- [ ] **Step 1: Create `lib/piano-voice.ts`** (moves the constants and graph out of the engine unchanged)

```ts
/**
 * The piano's audio graph, shared by the real-time engine and the offline MP3 render so both
 * sound identical: voice → EQ → Reverb → Compressor → Volume → Limiter → destination.
 * Built in whatever Tone context is current (Tone.Offline swaps it in for its callback).
 */

import type * as ToneNS from "tone";

type Tone = typeof ToneNS;
export type PianoVoice = ToneNS.Sampler | ToneNS.PolySynth;
/** Note name → trimmed sample buffer. */
export type SampleMap = Record<string, ToneNS.ToneAudioBuffer>;

/**
 * Piano envelope. A sampled piano already carries its natural decay/sustain curve in the
 * recording, so the Sampler only shapes attack (click-free onset) and release (damper
 * fall-off). The full ADSR is used by the synth fallback when samples can't load.
 */
export const PIANO_ENVELOPE = {
  attack: 0.004,
  decay: 0.9,
  sustain: 0.18,
  release: 1.15,
} as const;

/**
 * Make-up gain on top of the volume slider (dB). The samples peak around −9 dBFS, so there is
 * headroom; the −1 dB limiter at the end of the chain catches any peaks this pushes over.
 */
export const MASTER_GAIN_DB = 8;

export function buildPianoChain(Tone: Tone, volumeDb: number) {
  const limiter = new Tone.Limiter(-1).toDestination();
  const master = new Tone.Volume(volumeDb).connect(limiter);
  const compressor = new Tone.Compressor({
    threshold: -20,
    ratio: 2.5,
    attack: 0.01,
    release: 0.2,
  }).connect(master);
  const reverb = new Tone.Reverb({
    decay: 2.6,
    preDelay: 0.015,
    wet: 0.2,
  }).connect(compressor);
  // Gentle high-shelf cut tames the brightness of the upper samples.
  const eq = new Tone.EQ3({ low: 1, mid: 0, high: -2.5 }).connect(reverb);
  return { input: eq, master, ready: reverb.ready };
}

/** Sampled grand when samples are available, else the synth fallback. */
export function makePianoVoice(Tone: Tone, samples: SampleMap | null, output: ToneNS.InputNode): PianoVoice {
  if (samples)
    return new Tone.Sampler({
      urls: samples,
      attack: PIANO_ENVELOPE.attack,
      release: PIANO_ENVELOPE.release,
      curve: "exponential",
    }).connect(output);
  return new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: "fattriangle", count: 2, spread: 12 },
    envelope: { ...PIANO_ENVELOPE, attackCurve: "exponential" },
    volume: -10,
  }).connect(output);
}
```

- [ ] **Step 2: Rewire `hooks/useAudioEngine.ts`**

Imports — replace the `PianoVoice` type alias line and add:
```ts
import { buildPianoChain, makePianoVoice, MASTER_GAIN_DB, type PianoVoice, type SampleMap } from "@/lib/piano-voice";
import { recorder, type Recording } from "@/lib/recorder";
```
Delete from this file: `type PianoVoice = …`, `PIANO_ENVELOPE` (with its doc comment), `MASTER_GAIN_DB` (with its doc comment) — they now live in `lib/piano-voice.ts`.

Add a field next to `private master`:
```ts
  /** Trimmed sample buffers, reused by the offline MP3 render; null = synth fallback. */
  private samples: SampleMap | null = null;
```

Replace the body of the `this.loading = (async () => { … })();` block from `const limiter = …` through the end of the `catch` block with:
```ts
      const chain = buildPianoChain(Tone, this.volumeToDb(store.volume));
      this.master = chain.master;

      this.click = new Tone.Synth({
        oscillator: { type: "triangle" },
        envelope: { attack: 0.001, decay: 0.045, sustain: 0, release: 0.01 },
        volume: -8,
      }).connect(this.master);

      try {
        const buffers = await new Promise<ToneNS.ToneAudioBuffers>(
          (resolve, reject) => {
            const b: ToneNS.ToneAudioBuffers = new Tone.ToneAudioBuffers({
              urls: Object.fromEntries(
                SAMPLE_NOTES.map((n) => [n, `${n.replace("#", "s")}.mp3`]),
              ),
              baseUrl: SAMPLE_BASE_URL,
              onload: () => resolve(b),
              onerror: reject,
            });
          },
        );
        this.samples = Object.fromEntries(
          SAMPLE_NOTES.map((n) => [n, trimLeadingSilence(buffers.get(n))]),
        );
        this.accomp = makePianoVoice(Tone, this.samples, chain.input);
        this.live = makePianoVoice(Tone, this.samples, chain.input);
        await chain.ready;
        useMusicStore.getState().setAudioStatus("ready");
      } catch (err) {
        console.warn(
          "[audio] piano samples failed to load — using synth fallback",
          err,
        );
        this.samples = null;
        this.accomp = makePianoVoice(Tone, null, chain.input);
        this.live = makePianoVoice(Tone, null, chain.input);
        useMusicStore.getState().setAudioStatus("error");
      }
```
(The transport setup lines after the `catch` stay unchanged.)

In `volumeToDb`, `MASTER_GAIN_DB` now comes from the import — no change to the expression.

In `tick()`, replace the `this.accomp?.triggerAttackRelease(…)` call with:
```ts
      const at = Math.max(t, Tone.now());
      this.accomp?.triggerAttackRelease(name, sound, at, velocity);
      recorder.scheduled("accomp", note.midi, velocity, at, at + sound);
```
(Do **not** touch the metronome `this.click` call — the metronome is never recorded.)

In `liveNoteOn`, inside the `else` branch after `this.live.triggerAttack(…)`:
```ts
      recorder.noteOn(midi, velocity, this.tone.immediate());
```

In `liveNoteOff`, inside `if (this.tone && this.live) {`, as its first line:
```ts
      recorder.noteOff(midi, this.tone.immediate());
```

In `setPedal`, directly after `this.pedalDown = down;`:
```ts
    if (this.tone) recorder.pedal(down, this.tone.immediate());
```

In `previewChord`, after `this.live?.triggerAttackRelease(midiToNoteName(midi), 1.6, t, 0.62);`:
```ts
      recorder.scheduled("live", midi, 0.62, t, t + 1.6);
```

Add a new section before the closing brace of the class (after `previewChord`):
```ts
  /* ------------------------------- recording ------------------------------ */

  get renderSamples() {
    return this.samples;
  }

  /** Call after `unlock()`, so the audio clock exists. */
  startRecording() {
    const s = useMusicStore.getState();
    recorder.start(this.tone!.immediate(), { bpm: s.bpm, timeSignature: s.timeSignature });
  }

  stopRecording(): Recording {
    return recorder.stop(this.tone!.immediate());
  }
```

- [ ] **Step 3: Add recording state to `store/useMusicStore.ts`**

After the `MidiStatus` type:
```ts
export type RecFormat = "midi" | "mp3";
export type RecPhase = "render" | "encode";

export interface RecInfo {
  duration: number;
  liveNotes: number;
  accompNotes: number;
  /** Rendered with the synth fallback (samples failed to load). */
  synth: boolean;
  /** File name without extension, e.g. "piano-2026-10-02-1430". */
  fileStem: string;
}
```

After `interface DeviceState { … }`:
```ts
/** Recording — driven by lib/recording-controller.ts; the Recording itself lives there, not here. */
interface RecordingState {
  recState: "idle" | "recording" | "ready";
  /** performance.now() at Rec press, for the timer. */
  recStartedAt: number;
  recFormat: RecFormat;
  recLive: boolean;
  recAccomp: boolean;
  recInfo: RecInfo | null;
  /** exportKey → object URL of a finished export. */
  recExports: Record<string, string>;
  /** Export currently being built. */
  recJob: { key: string; phase: RecPhase } | null;
  recError: { key: string; message: string } | null;
}
```

In `interface Actions`, add:
```ts
  setRec: (p: Partial<RecordingState>) => void;
  setRecFormat: (f: RecFormat) => void;
  setRecLive: (on: boolean) => void;
  setRecAccomp: (on: boolean) => void;
```

Change the state type:
```ts
export type MusicState = TransportState & ArrangementState & PlayheadState & DeviceState & RecordingState & Actions;
```

In the initial state, after `detectedKeyCount: DEFAULT_KEY_COUNT,`:
```ts
        // recording
        recState: "idle",
        recStartedAt: 0,
        recFormat: "mp3",
        recLive: true,
        recAccomp: true,
        recInfo: null,
        recExports: {},
        recJob: null,
        recError: null,
```

After `setDetectedKeyCount: …,`:
```ts
        setRec: (p) => set(p),
        setRecFormat: (recFormat) => set({ recFormat }),
        setRecLive: (recLive) => set({ recLive }),
        setRecAccomp: (recAccomp) => set({ recAccomp }),
```

In `partialize`, after `keyboardSize: s.keyboardSize,`:
```ts
          recFormat: s.recFormat,
          recLive: s.recLive,
          recAccomp: s.recAccomp,
```

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm test`
Expected: no type errors; all tests PASS.

Run: `pnpm dev`, open http://localhost:3000, press Play and a few QWERTY keys (A S D).
Expected: accompaniment and live play sound exactly as before; status badge shows "Grand Piano · sẵn sàng".

- [ ] **Step 5: Commit**

```bash
git add lib/piano-voice.ts hooks/useAudioEngine.ts store/useMusicStore.ts
git commit -m "feat(recording): shared piano chain, engine recorder hooks, store state

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Offline render + MP3 worker

**Files:**
- Create: `lib/mp3.worker.ts`, `lib/render-audio.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `Recording`, `PartFilter`, `selectNotes` (Task 1); `liveVoiceCommands` (Task 3); `trimTail` (Task 3); `buildPianoChain`, `makePianoVoice`, `MASTER_GAIN_DB`, `SampleMap` (Task 4); `midiToNoteName` from `lib/music-theory.ts`.
- Produces:
  ```ts
  export const RENDER_SAMPLE_RATE = 44100;
  export async function renderMp3(rec: Recording, filter: PartFilter, samples: SampleMap | null, onPhase: (p: RecPhase) => void): Promise<Blob>;
  ```
  Worker protocol: in `{ left: Float32Array; right: Float32Array; sampleRate: number }` (buffers transferred); out `{ ok: true; mp3: ArrayBuffer } | { ok: false; error: string }`.

No unit tests (needs a real AudioContext + WASM); verified in Task 8 E2E.

- [ ] **Step 1: Install the encoder**

```bash
pnpm add wasm-media-encoders@^0.7.0
```

- [ ] **Step 2: Create `lib/mp3.worker.ts`**

```ts
/**
 * MP3 encoding off the main thread: LAME (WASM) at 320 kbps CBR. The WASM binary is inlined in
 * the package, so nothing is fetched at runtime.
 */

import { createMp3Encoder } from "wasm-media-encoders";

export type Mp3Request = { left: Float32Array; right: Float32Array; sampleRate: number };
export type Mp3Response = { ok: true; mp3: ArrayBuffer } | { ok: false; error: string };

/** Samples per encode() call — a multiple of the 1152-sample MP3 frame. */
const CHUNK = 1152 * 64;

// The project tsconfig uses the DOM lib; describe just the worker surface we use.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Mp3Request>) => void) | null;
  postMessage(msg: Mp3Response, transfer?: Transferable[]): void;
};

ctx.onmessage = async (e: MessageEvent<Mp3Request>) => {
  try {
    const { left, right, sampleRate } = e.data;
    const encoder = await createMp3Encoder();
    encoder.configure({ channels: 2, sampleRate, bitrate: 320, outputSampleRate: 44100 });

    const parts: Uint8Array[] = [];
    for (let i = 0; i < left.length; i += CHUNK) {
      // encode()/finalize() return views into WASM memory — copy before the next call.
      parts.push(encoder.encode([left.subarray(i, i + CHUNK), right.subarray(i, i + CHUNK)]).slice());
    }
    parts.push(encoder.finalize().slice());

    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    ctx.postMessage({ ok: true, mp3: out.buffer } satisfies Mp3Response, [out.buffer]);
  } catch (err) {
    ctx.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Mp3Response);
  }
};
```

- [ ] **Step 3: Create `lib/render-audio.ts`**

```ts
/**
 * MP3 export: re-render the recording offline through the same piano chain as the live engine
 * (sample-accurate, immune to CPU hiccups during recording), trim the tail, then encode in a worker.
 */

import { liveVoiceCommands } from "@/lib/live-replay";
import type { Mp3Request, Mp3Response } from "@/lib/mp3.worker";
import { midiToNoteName } from "@/lib/music-theory";
import { trimTail } from "@/lib/pcm";
import { buildPianoChain, makePianoVoice, MASTER_GAIN_DB, type SampleMap } from "@/lib/piano-voice";
import { selectNotes, type PartFilter, type Recording } from "@/lib/recorder";
import type { RecPhase } from "@/store/useMusicStore";

export const RENDER_SAMPLE_RATE = 44100;
/** Room after the stop for releases and the reverb tail; trimmed afterwards. */
const TAIL_SECONDS = 4;
/** Notes still under the pedal at the stop are damped here (release completes inside the tail). */
const DAMP_AFTER_STOP = 2.5;
/** Shortest note the offline voice is asked to play. */
const MIN_NOTE_SECONDS = 0.01;

export async function renderMp3(
  rec: Recording,
  filter: PartFilter,
  samples: SampleMap | null,
  onPhase: (p: RecPhase) => void,
): Promise<Blob> {
  const Tone = await import("tone");
  onPhase("render");

  const live = filter.live ? selectNotes(rec, { live: true, accomp: false }) : [];
  const accomp = filter.accomp ? selectNotes(rec, { live: false, accomp: true }) : [];

  const buffer = await Tone.Offline(
    async () => {
      const chain = buildPianoChain(Tone, MASTER_GAIN_DB);
      await chain.ready;
      if (live.length) {
        const voice = makePianoVoice(Tone, samples, chain.input);
        for (const c of liveVoiceCommands(live, rec.pedals, rec.duration + DAMP_AFTER_STOP)) {
          const name = midiToNoteName(c.midi);
          if (c.type === "attack") voice.triggerAttack(name, c.time, c.velocity);
          else voice.triggerRelease(name, c.time);
        }
      }
      if (accomp.length) {
        const voice = makePianoVoice(Tone, samples, chain.input);
        for (const n of accomp)
          voice.triggerAttackRelease(midiToNoteName(n.midi), Math.max(MIN_NOTE_SECONDS, n.end - n.start), n.start, n.velocity);
      }
    },
    rec.duration + TAIL_SECONDS,
    2,
    RENDER_SAMPLE_RATE,
  );

  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const [l, r] = trimTail([left, right], buffer.sampleRate);

  onPhase("encode");
  return encodeMp3({ left: l, right: r, sampleRate: buffer.sampleRate });
}

function encodeMp3(req: Mp3Request): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./mp3.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<Mp3Response>) => {
      worker.terminate();
      if (e.data.ok) resolve(new Blob([e.data.mp3], { type: "audio/mpeg" }));
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "MP3 encoder failed"));
    };
    // `left` and `right` may share a buffer (mono render); transfer each distinct buffer once.
    const transfer = [...new Set([req.left.buffer, req.right.buffer])] as ArrayBuffer[];
    worker.postMessage(req, transfer);
  });
}
```

- [ ] **Step 4: Verify types and build**

Run: `pnpm typecheck && pnpm build`
Expected: no errors; build output lists a separate worker chunk.


- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml lib/mp3.worker.ts lib/render-audio.ts
git commit -m "feat(recording): offline render + LAME MP3 worker (320 kbps)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Recording controller

**Files:**
- Create: `lib/recording-controller.ts`

**Interfaces:**
- Consumes: `audioEngine` (`unlock`, `startRecording`, `stopRecording`, `renderSamples`); `writeMidi`; `renderMp3`; `selectNotes`, `exportKey`, `recordingFileStem`; store `setRec`.
- Produces:
  ```ts
  export const recordingController: {
    toggle(): Promise<void>;
    start(): Promise<void>;
    stop(): void;
    /** Build the export for the current format + filter if missing. Serialized; safe to call repeatedly. */
    prepare(): Promise<void>;
    discard(): void;
  };
  ```

Design notes:
- Jobs run one at a time through a promise queue; each job re-reads format/filter when it starts and skips if that export already exists or has no notes.
- `generation` increments on start/discard; a job whose generation is stale throws its result away (no URL created → nothing leaks).
- Object URLs are revoked on discard and on a new recording.

- [ ] **Step 1: Create `lib/recording-controller.ts`**

```ts
"use client";

/**
 * Owns the current recording: start/stop, the in-memory `Recording`, and its exports
 * (one per format × part filter), built one at a time and exposed as object URLs in the store.
 */

import { audioEngine } from "@/hooks/useAudioEngine";
import { writeMidi } from "@/lib/midi-file";
import { exportKey, recordingFileStem, selectNotes, type Recording } from "@/lib/recorder";
import { renderMp3 } from "@/lib/render-audio";
import { useMusicStore } from "@/store/useMusicStore";

let current: Recording | null = null;
let generation = 0;
let queue: Promise<void> = Promise.resolve();

const store = () => useMusicStore.getState();

function revokeExports() {
  Object.values(store().recExports).forEach((url) => URL.revokeObjectURL(url));
}

async function buildExport() {
  const rec = current;
  const gen = generation;
  const { recFormat, recLive, recAccomp, recExports } = store();
  const filter = { live: recLive, accomp: recAccomp };
  const key = exportKey(recFormat, filter);
  if (!rec || recExports[key] || selectNotes(rec, filter).length === 0) return;

  store().setRec({ recError: null, recJob: { key, phase: recFormat === "mp3" ? "render" : "encode" } });
  try {
    const blob =
      recFormat === "midi"
        ? new Blob([writeMidi(rec, filter)], { type: "audio/midi" })
        : await renderMp3(rec, filter, audioEngine.renderSamples, (phase) => {
            if (gen === generation) store().setRec({ recJob: { key, phase } });
          });
    if (gen !== generation) return; // discarded or replaced while building
    store().setRec({ recJob: null, recExports: { ...store().recExports, [key]: URL.createObjectURL(blob) } });
  } catch (err) {
    if (gen !== generation) return;
    console.error("[recording] export failed", err);
    store().setRec({ recJob: null, recError: { key, message: err instanceof Error ? err.message : String(err) } });
  }
}

export const recordingController = {
  async toggle() {
    if (store().recState === "recording") this.stop();
    else await this.start();
  },

  async start() {
    const s = store();
    if (s.recState === "recording" || (!s.recLive && !s.recAccomp)) return;
    await audioEngine.unlock();
    this.discard();
    audioEngine.startRecording();
    store().setRec({ recState: "recording", recStartedAt: performance.now() });
  },

  stop() {
    if (store().recState !== "recording") return;
    const rec = audioEngine.stopRecording();
    current = rec;
    const count = (source: "live" | "accomp") => rec.notes.filter((n) => n.source === source).length;
    store().setRec({
      recState: "ready",
      recInfo: {
        duration: rec.duration,
        liveNotes: count("live"),
        accompNotes: count("accomp"),
        synth: audioEngine.renderSamples === null,
        fileStem: recordingFileStem(new Date(Date.now() - rec.duration * 1000)),
      },
    });
  },

  prepare() {
    queue = queue.then(buildExport, buildExport);
    return queue;
  },

  discard() {
    generation++;
    revokeExports();
    current = null;
    store().setRec({ recState: "idle", recInfo: null, recExports: {}, recJob: null, recError: null });
  },
};
```

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm test`
Expected: no type errors; tests PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/recording-controller.ts
git commit -m "feat(recording): controller with serialized exports and URL lifecycle

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: UI — Rec controls, result strip, R shortcut

**Files:**
- Create: `components/RecorderPanel.tsx`, `components/RecordingResult.tsx`
- Modify: `components/ControlPanel.tsx`, `app/page.tsx`, `hooks/useComputerKeyboard.ts`

**Interfaces:**
- Consumes: `recordingController` (Task 6); store recording state/actions (Task 4); `exportKey` (Task 1); `Button` from `components/ui/button`; `cn` from `lib/utils`.
- Produces: `export function RecorderPanel()`, `export function RecordingResult()`.

- [ ] **Step 1: Create `components/RecorderPanel.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { Circle, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { recordingController } from "@/lib/recording-controller";
import { cn } from "@/lib/utils";
import { useMusicStore, type RecFormat } from "@/store/useMusicStore";

const formatTime = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

function RecTimer() {
  const startedAt = useMusicStore((s) => s.recStartedAt);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="flex items-center gap-1.5 font-mono text-sm tabular-nums text-destructive" aria-live="off">
      <span className="size-2 animate-pulse rounded-full bg-destructive" />
      {formatTime(Math.max(0, (now - startedAt) / 1000))}
    </span>
  );
}

function PartChip({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "rounded-md border px-2.5 py-1 text-sm transition-colors",
        checked ? "border-primary/60 bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

export function RecorderPanel() {
  const recState = useMusicStore((s) => s.recState);
  const format = useMusicStore((s) => s.recFormat);
  const live = useMusicStore((s) => s.recLive);
  const accomp = useMusicStore((s) => s.recAccomp);
  const setFormat = useMusicStore((s) => s.setRecFormat);
  const setLive = useMusicStore((s) => s.setRecLive);
  const setAccomp = useMusicStore((s) => s.setRecAccomp);
  const recording = recState === "recording";

  return (
    <div className="flex items-center gap-2">
      <div className="flex rounded-md border border-border p-0.5" role="radiogroup" aria-label="Định dạng ghi">
        {(["midi", "mp3"] as RecFormat[]).map((value) => (
          <button
            key={value}
            role="radio"
            aria-checked={format === value}
            onClick={() => setFormat(value)}
            className={cn(
              "rounded px-2.5 py-1 font-mono text-sm uppercase transition-colors",
              format === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {value}
          </button>
        ))}
      </div>
      <PartChip label="Live" checked={live} onChange={setLive} />
      <PartChip label="Đệm" checked={accomp} onChange={setAccomp} />
      <Button
        variant={recording ? "destructive" : "outline"}
        size="icon"
        disabled={!recording && !live && !accomp}
        onClick={() => void recordingController.toggle()}
        aria-pressed={recording}
        aria-label={recording ? "Dừng ghi" : "Ghi"}
        title={!live && !accomp ? "Chọn ít nhất Live hoặc Đệm" : "Ghi (phím tắt: R)"}
      >
        {recording ? <Square className="size-3.5 fill-current" /> : <Circle className="size-3.5 fill-destructive text-destructive" />}
      </Button>
      {recording && <RecTimer />}
    </div>
  );
}
```

- [ ] **Step 2: Create `components/RecordingResult.tsx`**

```tsx
"use client";

import { useEffect } from "react";
import { CircleCheck, Download, Loader2, RotateCcw, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { exportKey } from "@/lib/recorder";
import { recordingController } from "@/lib/recording-controller";
import { useMusicStore } from "@/store/useMusicStore";

const formatTime = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

export function RecordingResult() {
  const recState = useMusicStore((s) => s.recState);
  const info = useMusicStore((s) => s.recInfo);
  const format = useMusicStore((s) => s.recFormat);
  const live = useMusicStore((s) => s.recLive);
  const accomp = useMusicStore((s) => s.recAccomp);
  const exports = useMusicStore((s) => s.recExports);
  const job = useMusicStore((s) => s.recJob);
  const error = useMusicStore((s) => s.recError);

  const key = exportKey(format, { live, accomp });
  useEffect(() => {
    if (recState === "ready") void recordingController.prepare();
  }, [recState, key]);

  if (recState !== "ready" || !info) return null;

  const notes = (live ? info.liveNotes : 0) + (accomp ? info.accompNotes : 0);
  const url = exports[key];
  const busy = job?.key === key;
  const failed = error?.key === key ? error.message : null;
  const ext = format === "mp3" ? "mp3" : "mid";

  return (
    <section className="panel flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 text-sm" aria-label="Bản ghi">
      <span className="flex items-center gap-2">
        <CircleCheck className="size-4 text-user" />
        Bản ghi {formatTime(info.duration)} · {notes} nốt
      </span>

      {notes === 0 && <span className="text-muted-foreground">Không có nốt nào</span>}

      {busy && (
        <span className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {job.phase === "render" ? "Đang render…" : "Đang mã hóa…"}
        </span>
      )}

      {failed && (
        <span className="flex items-center gap-2 text-destructive">
          <TriangleAlert className="size-4" /> Xuất file lỗi: {failed}
          <Button variant="outline" size="sm" onClick={() => {
            useMusicStore.getState().setRec({ recError: null });
            void recordingController.prepare();
          }}>
            <RotateCcw /> Thử lại
          </Button>
        </span>
      )}

      {url && format === "mp3" && <audio controls src={url} className="h-8" />}

      {format === "mp3" && info.synth && (
        <span className="text-xs text-muted-foreground">Render bằng synth dự phòng (không tải được sample piano)</span>
      )}

      <div className="ml-auto flex items-center gap-2">
        <Button asChild={!!url} size="sm" disabled={!url}>
          {url ? (
            <a href={url} download={`${info.fileStem}.${ext}`}>
              <Download /> Tải .{ext}
            </a>
          ) : (
            <span>
              <Download /> Tải .{ext}
            </span>
          )}
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => recordingController.discard()} aria-label="Bỏ bản ghi" title="Bỏ bản ghi">
          <X />
        </Button>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Mount the components**

`components/ControlPanel.tsx` — add import:
```ts
import { RecorderPanel } from "@/components/RecorderPanel";
```
and in `ControlPanel()` render, directly after `<Transport />`:
```tsx
      <RecorderPanel />
```

`app/page.tsx` — add import:
```ts
import { RecordingResult } from "@/components/RecordingResult";
```
and directly after `<ControlPanel />`:
```tsx
      <RecordingResult />
```

- [ ] **Step 4: Add the R shortcut in `hooks/useComputerKeyboard.ts`**

Add import:
```ts
import { recordingController } from "@/lib/recording-controller";
```
Update the header comment line `* Z / X shift the octave, Space toggles play/pause.` to:
```ts
 * Z / X shift the octave, Space toggles play/pause, R toggles recording.
```
In `onKeyDown`, directly after the `KeyX` line:
```ts
      if (e.code === "KeyR") {
        e.preventDefault();
        if (!e.repeat) void recordingController.toggle();
        return;
      }
```

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all pass. If lucide reports a missing icon name, use the name the installed version exports (`grep -o "CircleCheck\|TriangleAlert" node_modules/lucide-react/dist/lucide-react.d.ts | sort -u`).

- [ ] **Step 6: Commit**

```bash
git add components/RecorderPanel.tsx components/RecordingResult.tsx components/ControlPanel.tsx app/page.tsx hooks/useComputerKeyboard.ts
git commit -m "feat(recording): Rec controls, result strip, R shortcut

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: End-to-end verification (Playwright)

**Files:** none (verification only; fix any defects found in the owning task's files and commit them with a `fix(recording): …` message).

- [ ] **Step 1: Start the dev server**

Run (background): `pnpm dev`
Expected: "Ready" on http://localhost:3000.

- [ ] **Step 2: Record live + accompaniment as MP3**

With the Playwright MCP tools: navigate to `http://localhost:3000`, wait for the text "Grand Piano · sẵn sàng". Make sure the MP3 radio is checked and both Live and Đệm are pressed. Then:
1. Press `r` (recording starts; a red mm:ss timer appears).
2. Press and release `a`, `s`, `d` with ~300 ms gaps (`browser_press_key`).
3. Click "Phát" (Play), wait 4 s, click the Pause button.
4. Press `r` (stop).

Expected: the result strip shows "Bản ghi 00:0x · N nốt" with N > 3, then "Đang render…" → "Đang mã hóa…" → an `<audio>` player and an enabled "Tải .mp3" link.

- [ ] **Step 3: Validate the MP3 bytes and duration**

`browser_evaluate`:
```js
async () => {
  const a = document.querySelector('a[download$=".mp3"]');
  const buf = await (await fetch(a.href)).arrayBuffer();
  const b = new Uint8Array(buf);
  const ctx = new AudioContext();
  const audio = await ctx.decodeAudioData(buf.slice(0));
  return { name: a.download, bytes: b.length, head: [...b.slice(0, 3)], duration: audio.duration, channels: audio.numberOfChannels, sampleRate: audio.sampleRate };
}
```
Expected: `name` matches `piano-YYYY-MM-DD-HHmm.mp3`; `head` is `[73,68,51]` ("ID3") or starts with `255` (frame sync); `channels` 2; `duration` ≈ recording length + reverb tail (≤ +4 s); `bytes / duration` ≈ 40 000 (320 kbps).

- [ ] **Step 4: Switch to MIDI and validate**

Click the "MIDI" radio. Expected: "Tải .mid" enabled immediately, no audio player.

`browser_evaluate`:
```js
async () => {
  const a = document.querySelector('a[download$=".mid"]');
  const b = new Uint8Array(await (await fetch(a.href)).arrayBuffer());
  const s = (i) => String.fromCharCode(...b.slice(i, i + 4));
  let tracks = 0;
  for (let i = 0; i + 4 <= b.length; i++) if (s(i) === "MTrk") tracks++;
  return { name: a.download, magic: s(0), format: b[9], ntracks: b[11], tracks };
}
```
Expected: `magic` "MThd", `format` 1, `ntracks` 3, `tracks` 3.

- [ ] **Step 5: Filter changes and edge cases**

1. Toggle "Đệm" off → MIDI export rebuilt with `ntracks` 2 (re-run Step 4 script).
2. Switch back to MP3 with only Live → new render runs; the earlier Live+Đệm MP3 is reused when toggling Đệm back on (no "Đang render…" shown).
3. While an MP3 render is in progress, click "Bỏ bản ghi" → strip disappears, no console errors (`browser_console_messages`).
4. Turn both Live and Đệm off → Rec button disabled.
5. Record with no notes (press `r`, wait 1 s, press `r`) → "Không có nốt nào", download disabled.
6. Metronome on, Live on / Đệm off, press `r`, click Play, wait 2 s, Pause, press `r` without touching any key → "Không có nốt nào" (the click and the accompaniment never appear in the Live part).

- [ ] **Step 6: Final checks and commit any fixes**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: all pass.

```bash
git status --short   # should be clean, or only intentional fixes
```
