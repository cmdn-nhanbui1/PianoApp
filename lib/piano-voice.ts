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
