"use client";

import { create } from "zustand";
import { createJSONStorage, persist, subscribeWithSelector } from "zustand/middleware";
import { DEFAULT_KEY_COUNT, isValidChord, prefersFlats, transposeChordSymbol, type KeyCount } from "@/lib/music-theory";
import type { SlotLength } from "@/lib/sequencer";
import { STYLES, getStyle, patternTimeSignature, styleTimeSignatures, type TimeSignature } from "@/lib/styles";

export type { SlotLength };

export interface ChordSlot {
  id: string;
  symbol: string;
  /** Full bar, or half a bar (two chords in one bar). */
  length: SlotLength;
}

export interface MidiDeviceInfo {
  id: string;
  name: string;
  manufacturer: string;
  connected: boolean;
}

export type AudioStatus = "idle" | "loading" | "ready" | "error";
export type MidiStatus = "unsupported" | "pending" | "denied" | "ready";

interface TransportState {
  isPlaying: boolean;
  bpm: number;
  /** Master volume, 0–100. */
  volume: number;
  metronome: boolean;
  timeSignature: TimeSignature;
  humanize: boolean;
  sustain: boolean;
}

interface ArrangementState {
  styleId: string;
  patternId: string;
  progression: ChordSlot[];
}

/**
 * Playhead — written by the audio engine via Tone.Draw (in sync with what you hear).
 * Components subscribe to these with narrow selectors so only the timeline cursor and
 * pattern grid re-render per step; the keyboard never re-renders (see Keyboard.tsx).
 */
interface PlayheadState {
  currentSlot: number;
  /** Step inside the current *pattern* (0 … bars × stepsPerBar − 1). */
  currentStep: number;
  /** Beat inside the current chord slot (0-based). */
  currentBeat: number;
}

interface DeviceState {
  audioStatus: AudioStatus;
  midiStatus: MidiStatus;
  midiDevices: MidiDeviceInfo[];
  /** A device id, or the special values "all" (listen to every input, hot-plug aware) / "off". */
  selectedMidiId: string;
  /** Last received MIDI note (for the activity LED). */
  midiActivity: number;
  /** On-screen keyboard size: fixed, or "auto" = follow the connected piano. */
  keyboardSize: "auto" | KeyCount;
  /** Size inferred from the device name / notes received (used when keyboardSize is "auto"). */
  detectedKeyCount: KeyCount;
}

interface Actions {
  /** Written by the audio engine only — UI calls `audioEngine.play()/pause()/stop()`. */
  setPlaying: (playing: boolean) => void;
  resetPlayhead: () => void;
  setBpm: (bpm: number) => void;
  setVolume: (v: number) => void;
  setMetronome: (on: boolean) => void;
  setHumanize: (on: boolean) => void;
  setSustain: (on: boolean) => void;
  setTimeSignature: (ts: TimeSignature) => void;
  setStyle: (styleId: string) => void;
  setPattern: (patternId: string) => void;

  addChord: (symbol: string, length?: SlotLength, index?: number) => boolean;
  setChordLength: (id: string, length: SlotLength) => void;
  updateChord: (id: string, symbol: string) => boolean;
  removeChord: (id: string) => void;
  moveChord: (fromIndex: number, toIndex: number) => void;
  setProgression: (slots: { symbol: string; length?: SlotLength }[]) => void;
  transpose: (semitones: number) => void;

  setPlayhead: (p: Partial<PlayheadState>) => void;
  jumpToSlot: (slot: number) => void;

  setAudioStatus: (s: AudioStatus) => void;
  setMidiStatus: (s: MidiStatus) => void;
  setMidiDevices: (d: MidiDeviceInfo[]) => void;
  selectMidiDevice: (id: string) => void;
  pingMidi: () => void;
  setKeyboardSize: (size: "auto" | KeyCount) => void;
  setDetectedKeyCount: (count: KeyCount) => void;
}

export type MusicState = TransportState & ArrangementState & PlayheadState & DeviceState & Actions;

let slotCounter = 0;
const newSlot = (symbol: string, length: SlotLength = "bar"): ChordSlot => ({
  id: `slot-${Date.now().toString(36)}-${slotCounter++}`,
  symbol,
  length,
});

const clampBpm = (bpm: number) => Math.min(220, Math.max(40, Math.round(bpm)));
const DEFAULT_STYLE = STYLES[0];

export const useMusicStore = create<MusicState>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        // transport
        isPlaying: false,
        bpm: DEFAULT_STYLE.defaultBpm,
        volume: 80,
        metronome: false,
        timeSignature: DEFAULT_STYLE.timeSignature,
        humanize: true,
        sustain: true,
        // arrangement
        styleId: DEFAULT_STYLE.id,
        patternId: DEFAULT_STYLE.patterns[0].id,
        progression: ["G", "D/F#", "Em", "C"].map((c) => newSlot(c)),
        // playhead
        currentSlot: 0,
        currentStep: -1,
        currentBeat: -1,
        // devices
        audioStatus: "idle",
        midiStatus: "pending",
        midiDevices: [],
        selectedMidiId: "all",
        midiActivity: 0,
        keyboardSize: "auto",
        detectedKeyCount: DEFAULT_KEY_COUNT,

        setPlaying: (isPlaying) => set({ isPlaying }),
        resetPlayhead: () => set({ currentSlot: 0, currentStep: -1, currentBeat: -1 }),
        setBpm: (bpm) => set({ bpm: clampBpm(bpm) }),
        setVolume: (volume) => set({ volume: Math.min(100, Math.max(0, volume)) }),
        setMetronome: (metronome) => set({ metronome }),
        setHumanize: (humanize) => set({ humanize }),
        setSustain: (sustain) => set({ sustain }),

        setTimeSignature: (ts) => {
          if (ts === get().timeSignature) return;
          // Meter belongs to the pattern: prefer a pattern in the current style, else the first style offering it.
          const current = getStyle(get().styleId);
          const style = styleTimeSignatures(current).includes(ts) ? current : STYLES.find((s) => styleTimeSignatures(s).includes(ts));
          if (!style) return;
          const pattern = style.patterns.find((p) => patternTimeSignature(style, p) === ts)!;
          if (style.id !== current.id) get().setStyle(style.id);
          get().setPattern(pattern.id);
        },
        setStyle: (styleId) => {
          const style = getStyle(styleId);
          const first = style.patterns[0];
          set({
            styleId: style.id,
            patternId: first.id,
            timeSignature: patternTimeSignature(style, first),
            bpm: first.defaultBpm ?? style.defaultBpm,
          });
        },
        setPattern: (patternId) => {
          const style = getStyle(get().styleId);
          const pattern = style.patterns.find((p) => p.id === patternId);
          if (!pattern) return;
          const ts = patternTimeSignature(style, pattern);
          // Only suggest a new tempo when the meter changes (e.g. shuffle 4/4 → slow blues 12/8).
          const bpm = ts !== get().timeSignature ? (pattern.defaultBpm ?? style.defaultBpm) : get().bpm;
          set({ patternId, timeSignature: ts, bpm });
        },

        addChord: (symbol, length = "bar", index) => {
          if (!isValidChord(symbol)) return false;
          const progression = [...get().progression];
          progression.splice(index ?? progression.length, 0, newSlot(symbol.trim(), length));
          set({ progression });
          return true;
        },
        updateChord: (id, symbol) => {
          if (!isValidChord(symbol)) return false;
          set({ progression: get().progression.map((s) => (s.id === id ? { ...s, symbol: symbol.trim() } : s)) });
          return true;
        },
        removeChord: (id) => {
          const progression = get().progression.filter((s) => s.id !== id);
          set({
            progression,
            currentSlot: Math.min(get().currentSlot, Math.max(0, progression.length - 1)),
          });
        },
        moveChord: (from, to) => {
          const progression = [...get().progression];
          const [moved] = progression.splice(from, 1);
          progression.splice(to, 0, moved);
          set({ progression });
        },
        setChordLength: (id, length) => set({ progression: get().progression.map((s) => (s.id === id ? { ...s, length } : s)) }),
        setProgression: (slots) =>
          set({ progression: slots.filter((s) => isValidChord(s.symbol)).map((s) => newSlot(s.symbol, s.length)), currentSlot: 0 }),
        transpose: (semitones) => {
          const flats = prefersFlats(get().progression.map((s) => s.symbol));
          set({ progression: get().progression.map((s) => ({ ...s, symbol: transposeChordSymbol(s.symbol, semitones, flats) })) });
        },

        setPlayhead: (p) => set(p),
        jumpToSlot: (slot) => set({ currentSlot: slot }),

        setAudioStatus: (audioStatus) => set({ audioStatus }),
        setMidiStatus: (midiStatus) => set({ midiStatus }),
        setMidiDevices: (midiDevices) => set({ midiDevices }),
        selectMidiDevice: (selectedMidiId) => set({ selectedMidiId }),
        pingMidi: () => set({ midiActivity: performance.now() }),
        setKeyboardSize: (keyboardSize) => set({ keyboardSize }),
        setDetectedKeyCount: (detectedKeyCount) => set({ detectedKeyCount }),
      }),
      {
        name: "piano-studio-pro",
        version: 2,
        // v1 slots had no length → every chord was a full bar.
        migrate: (persisted, version) => {
          const state = persisted as { progression?: Partial<ChordSlot>[] };
          if (version < 2 && state.progression) {
            state.progression = state.progression.map((s) => ({ ...s, length: s.length ?? "bar" })) as ChordSlot[];
          }
          return state as MusicState;
        },
        storage: createJSONStorage(() => localStorage),
        // Rehydrated manually on mount (see app/page.tsx) to avoid SSR hydration mismatches.
        skipHydration: true,
        partialize: (s) => ({
          bpm: s.bpm,
          volume: s.volume,
          metronome: s.metronome,
          humanize: s.humanize,
          sustain: s.sustain,
          timeSignature: s.timeSignature,
          styleId: s.styleId,
          patternId: s.patternId,
          progression: s.progression,
          selectedMidiId: s.selectedMidiId,
          keyboardSize: s.keyboardSize,
        }),
      },
    ),
  ),
);

/** Number of keys the on-screen keyboard should show. */
export const useKeyCount = () => useMusicStore((s) => (s.keyboardSize === "auto" ? s.detectedKeyCount : s.keyboardSize));
