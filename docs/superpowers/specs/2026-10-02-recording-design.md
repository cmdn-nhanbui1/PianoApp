# Recording (MIDI + MP3) — Design

**Date:** 2026-10-02
**Status:** Approved in chat, pending spec review

## Goal

Let the user record a session and export it as either a **MIDI file (.mid)** or a **high-quality MP3 (.mp3)**.

### Agreed requirements

- Two export formats, chosen in the UI: **MIDI** and **MP3**.
- The user chooses which parts are included: **Live** (what they play via MIDI / QWERTY / mouse / chord preview) and/or **Accompaniment** (sequencer). At least one must be on.
- The **metronome is never recorded**.
- **Rec starts immediately** when pressed and stops when pressed again. It is independent of the transport — the user can play/pause/stop the accompaniment freely while recording.
- After stopping: a result strip with preview (MP3 only), Download and Discard. The recording lives in memory only until the next recording replaces it.
- MP3 quality: **320 kbps CBR, stereo, 44.1 kHz**, encoded by LAME. No `MediaRecorder` (lossy webm/opus).
- Everything runs in the browser; no server.

## Approach: event log + offline render

While recording we log every note the engine actually sounds (time, pitch, velocity, length, source) plus sustain-pedal changes. Both exports are derived from this one log:

- **MIDI** — the log is serialized to a Standard MIDI File.
- **MP3** — the log is re-rendered with `Tone.Offline` through the exact same piano chain, then encoded to MP3 in a Web Worker.

Rejected alternatives:
- *Real-time PCM capture (AudioWorklet)* — any CPU hiccup during recording lands in the file; needs a second always-on FX chain; MIDI would still need its own log.
- *MediaRecorder* — lossy webm/opus only; converting to MP3 is a double lossy encode.

Trade-off accepted: MP3 export takes a few seconds to render, and the result is a re-render (identical notes, timing and velocities; reverb tail may differ imperceptibly) rather than a tap of the speaker output.

## 1. Event capture

### `lib/recorder.ts` (pure TS, no Tone dependency)

```ts
type RecSource = "live" | "accomp";
interface RecNote  { source: RecSource; midi: number; velocity: number; start: number; end: number } // seconds from Rec press
interface RecPedal { time: number; down: boolean }   // live part only
interface Recording {
  notes: RecNote[];
  pedals: RecPedal[];
  duration: number;            // seconds, Rec press → Stop press
  bpm: number;                 // at record start
  timeSignature: TimeSignature; // at record start
}
```

API (singleton `recorder`):
- `start(now, { bpm, timeSignature })` — begins a session; `now` is AudioContext time.
- `stop(now): Recording` — closes any still-open live notes at `now`; drops accompaniment notes whose start is ≥ `now` (already scheduled via look-ahead but not yet heard); clamps note ends to `now`.
- `noteOn(midi, velocity, time)` / `noteOff(midi, time)` — live notes. A second `noteOn` for an already-open pitch closes the open one first.
- `pedal(down, time)` — live CC64.
- `scheduled(midi, velocity, start, end)` — accompaniment notes (complete at schedule time).
- `isRecording` getter. All calls are no-ops when not recording.

### Clock

All times use the AudioContext clock: live events use `Tone.immediate()`, accompaniment uses the scheduled time `t` from `tick()` (swing + humanize already applied). Stored times are relative to the Rec press. This keeps live and accompaniment sample-aligned regardless of UI latency.

### Hooks in `AudioEngine` (`hooks/useAudioEngine.ts`)

| Location | Records |
|---|---|
| `tick()` | accompaniment note: `start = t`, `end = t + sound` (actual sounding length incl. pattern pedal), humanized velocity |
| `liveNoteOn` / `liveNoteOff` | live note open/close |
| `setPedal` | CC64 |
| `previewChord` | each chord note as live (it is heard through the live voice) |
| metronome click | **not recorded** |

Live events are recorded only when the audio context is available (same condition as sounding).

The Live/Accompaniment filter is applied **at export time**, so toggling after recording re-exports with the new selection.

### Store (`store/useMusicStore.ts`)

New state:
- `recState: "idle" | "recording" | "rendering" | "done" | "error"`
- `recStartedAt: number` (performance.now, for the mm:ss display)
- `recFormat: "midi" | "mp3"`, `recLive: boolean`, `recAccomp: boolean` — **persisted**.
- `recError: string | null`

The `Recording` object itself and generated blobs live outside the store (module-level in the recording controller), never persisted.

### Known limitation

The MIDI file uses the BPM and time signature at record start. If BPM changes mid-recording, notes stay at the correct real-time positions but the DAW bar grid will drift. Accepted.

## 2. Export

### MIDI — `lib/midi-file.ts`

Hand-written SMF writer (no dependency):
- **Type 1**, PPQ 480.
- Track 0: tempo (from `bpm`), time signature, sequence name.
- Track 1 "Piano – Live", channel 1: notes + CC64 pedal events.
- Track 2 "Piano – Accompaniment", channel 2: notes.
- Disabled parts are omitted (not written as empty tracks).
- Velocity: `clamp(round(v × 127), 1, 127)`.
- Ticks: `round(sec × bpm / 60 × 480)`.
- Events sorted by tick; at equal ticks, note-off before note-on. Delta times as VLQ. Each track ends with End-of-Track.

Signature: `writeMidi(rec: Recording, opts: { live: boolean; accomp: boolean }): Uint8Array`.

### MP3 — `lib/render-audio.ts` + `lib/mp3.worker.ts`

1. **Refactor:** extract the FX chain construction from `AudioEngine.load()` into `buildPianoChain(Tone, output)` returning the chain input node (EQ → Reverb → Compressor → Limiter → output, identical parameters). The real-time engine and the offline render both use it, so the timbre is identical. The engine also keeps the trimmed sample buffers (`urls` map) so offline rendering does not re-download them.
2. **`Tone.Offline`**: 44.1 kHz, 2 channels, length `duration + 4 s` (reverb tail).
   - One Sampler per part built from the cached trimmed buffers (synth fallback if the engine is in fallback mode).
   - Live part replayed with `triggerAttack` / `triggerRelease`, applying the same pedal logic as the engine (on pedal-up, release every note no longer held).
   - Accompaniment replayed with `triggerAttackRelease(name, end − start, start, velocity)`.
   - Output gain fixed at 0 dB slider-equivalent + `MASTER_GAIN_DB` — **independent of the volume slider**; the −1 dB limiter protects against clipping.
3. **Trim:** cut trailing audio below −80 dBFS, then apply a 50 ms fade-out.
4. **Encode** in a Web Worker with `wasm-media-encoders` (LAME → WASM, MIT, ~130 KB, lazy-loaded on first MP3 export): 320 kbps CBR, stereo, 44.1 kHz. Interleaved Float32 channel data is transferred (not copied) to the worker.
5. Progress states shown in UI: "Đang render…" → "Đang mã hóa…".

Signature: `renderMp3(rec: Recording, opts, onPhase): Promise<Blob>`.

### Error handling

- Engine in synth fallback (samples failed to load): render with synth, show a warning in the result strip.
- Render/encode failure: `recState = "error"`, show message, **keep the Recording** and offer Retry.
- Empty export (no notes after filtering): Download disabled, hint "Không có nốt nào".

### Filenames

`piano-YYYY-MM-DD-HHmm.mid` / `.mp3` (local time of record start).

## 3. UI

### `components/RecorderPanel.tsx`

Placed in the top control bar, after Transport:

```
[ MIDI | MP3 ]   ☑ Live  ☑ Đệm    (● REC)  00:42
```

- Segmented control for format.
- Two toggle chips Live / Đệm; Rec is disabled when both are off.
- Rec button: press → recording starts immediately (unlocks audio if needed); button turns into a pulsing red ■ with a running mm:ss timer. Press again → stop.
- Keyboard shortcut **R** (unused by the QWERTY piano map; ignored while typing or with modifiers).

### Result strip (below the control bar, shown when a recording exists)

```
✓ Bản ghi 01:12 · 184 nốt   [▶ preview (MP3)]  [⬇ Tải .mp3]  [✕ Bỏ]
```

- **MP3:** rendering starts automatically on stop; when done, an `<audio controls>` preview plus Download.
- **MIDI:** generated instantly; Download only.
- Changing format or Live/Đệm after recording re-exports from the kept Recording (MP3 re-renders; result cached per (format, live, accomp) combination for the current recording).
- Starting a new recording replaces the previous one; object URLs are revoked on replace/discard.

## 4. Testing

- Add **vitest** as a dev dependency (`pnpm test`).
- Unit tests:
  - `recorder.ts`: open/close notes, re-trigger of an open pitch, closing held notes on stop, dropping not-yet-heard accompaniment notes, pedal events, no-ops when idle.
  - `midi-file.ts`: MThd/MTrk headers, track count per filter, seconds→ticks, VLQ encoding, note-off-before-note-on ordering, velocity clamping, CC64 events.
- End-to-end check with Playwright on the dev server: record a few QWERTY notes with accompaniment playing, export `.mid` and `.mp3`, verify file headers (`MThd`, MP3 frame sync / ID3) and approximate MP3 duration.
- `pnpm typecheck` and `pnpm build` pass.

## Files

New: `lib/recorder.ts`, `lib/midi-file.ts`, `lib/render-audio.ts`, `lib/mp3.worker.ts`, `components/RecorderPanel.tsx`, tests under `lib/__tests__/`.
Changed: `hooks/useAudioEngine.ts` (chain extraction, recorder hooks, cached buffers), `store/useMusicStore.ts` (rec state), `components/ControlPanel.tsx` (mount panel), `hooks/useComputerKeyboard.ts` (R shortcut), `package.json` (vitest, wasm-media-encoders).
