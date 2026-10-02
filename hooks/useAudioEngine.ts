"use client";

import { useEffect } from "react";
import type * as ToneNS from "tone";
import { keyBus } from "@/lib/key-bus";
import {
  DEFAULT_KEY_COUNT,
  guessKeyCount,
  KEYBOARD_SIZES,
  keyCountCovering,
  midiToNoteName,
  type KeyCount,
} from "@/lib/music-theory";
import { getTimeline, resolveStep } from "@/lib/sequencer";
import {
  BEATS_PER_BAR,
  stepSubdivision,
  stepsPerBar,
  type TimeSignature,
} from "@/lib/styles";
import { useMusicStore, type MidiDeviceInfo } from "@/store/useMusicStore";

type Tone = typeof ToneNS;
type PianoVoice = ToneNS.Sampler | ToneNS.PolySynth;

/* -------------------------------------------------------------------------- */
/*                                  Settings                                  */
/* -------------------------------------------------------------------------- */

/** Salamander Grand Piano (CC-BY 3.0, Alexander Holm), hosted by the Tone.js project. */
const SAMPLE_BASE_URL = "https://tonejs.github.io/audio/salamander/";
/** One sample every minor third is enough — the Sampler repitches ±1.5 semitones. */
const SAMPLE_NOTES = [
  "A1",
  "C2",
  "D#2",
  "F#2",
  "A2",
  "C3",
  "D#3",
  "F#3",
  "A3",
  "C4",
  "D#4",
  "F#4",
  "A4",
  "C5",
  "D#5",
  "F#5",
  "A5",
  "C6",
  "D#6",
  "F#6",
  "A6",
  "C7",
  "D#7",
  "F#7",
  "A7",
  "C8",
];

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
const MASTER_GAIN_DB = 8;

/** Humanize ranges: ±5 ms timing, ±10 % velocity. */
const HUMANIZE_TIME = 0.005;
const HUMANIZE_VELOCITY = 0.1;
/** Samples start with a few ms of MP3 padding / pre-onset silence; trim up to this level. */
const ONSET_THRESHOLD = 0.001;
/** Keep a little pre-roll before the onset so the hammer transient stays intact. */
const ONSET_PREROLL = 0.001;
/** How long after a pedal change point the damper actually falls (legato pedalling). */
const PEDAL_LIFT_DELAY = 0.04;

const rand = () => Math.random() * 2 - 1;

/* -------------------------------------------------------------------------- */
/*                                Audio engine                                */
/* -------------------------------------------------------------------------- */

class AudioEngine {
  private tone: Tone | null = null;
  private loading: Promise<void> | null = null;

  /** Accompaniment and live-play voices are separate so a live note-off never cuts the sequencer. */
  private accomp: PianoVoice | null = null;
  private live: PianoVoice | null = null;
  private click: ToneNS.Synth | null = null;
  private master: ToneNS.Volume | null = null;

  private repeatId: number | null = null;
  /** Absolute 16th-note position since playback started; -1 = before the first step. */
  private pos = -1;
  private barSteps = 16;
  /** Grid clock: "16n" for simple meters, "8t" (triplets) for 12/8. */
  private subdivision: "16n" | "8t" = "16n";

  // live-play sustain pedal state (MIDI CC64)
  private pedalDown = false;
  private heldKeys = new Set<number>();
  private sustainedKeys = new Set<number>();

  /** Import Tone lazily (browser only), build the audio graph and fetch the samples. */
  load(): Promise<void> {
    if (this.loading) return this.loading;
    const store = useMusicStore.getState();
    store.setAudioStatus("loading");

    this.loading = (async () => {
      const Tone = await import("tone");
      this.tone = Tone;

      const limiter = new Tone.Limiter(-1).toDestination();
      this.master = new Tone.Volume(this.volumeToDb(store.volume)).connect(
        limiter,
      );
      const compressor = new Tone.Compressor({
        threshold: -20,
        ratio: 2.5,
        attack: 0.01,
        release: 0.2,
      }).connect(this.master);
      const reverb = new Tone.Reverb({
        decay: 2.6,
        preDelay: 0.015,
        wet: 0.2,
      }).connect(compressor);
      // Gentle high-shelf cut tames the brightness of the upper samples.
      const eq = new Tone.EQ3({ low: 1, mid: 0, high: -2.5 }).connect(reverb);

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
        const urls = Object.fromEntries(
          SAMPLE_NOTES.map((n) => [n, trimLeadingSilence(buffers.get(n))]),
        );
        const makeSampler = () =>
          new Tone.Sampler({
            urls,
            attack: PIANO_ENVELOPE.attack,
            release: PIANO_ENVELOPE.release,
            curve: "exponential",
          }).connect(eq);
        this.accomp = makeSampler();
        this.live = makeSampler();
        await reverb.ready;
        useMusicStore.getState().setAudioStatus("ready");
      } catch (err) {
        console.warn(
          "[audio] piano samples failed to load — using synth fallback",
          err,
        );
        const makeSynth = () =>
          new Tone.PolySynth(Tone.Synth, {
            oscillator: { type: "fattriangle", count: 2, spread: 12 },
            envelope: { ...PIANO_ENVELOPE, attackCurve: "exponential" },
            volume: -10,
          }).connect(eq);
        this.accomp = makeSynth();
        this.live = makeSynth();
        useMusicStore.getState().setAudioStatus("error");
      }

      const transport = Tone.getTransport();
      transport.bpm.value = store.bpm;
      transport.timeSignature = BEATS_PER_BAR[store.timeSignature];
      this.barSteps = stepsPerBar(store.timeSignature);
      this.subdivision = stepSubdivision(store.timeSignature);
    })();
    return this.loading;
  }

  /** Must run inside a user gesture the first time (browser autoplay policy). */
  async unlock() {
    await this.load();
    if (this.tone && this.tone.getContext().state !== "running")
      await this.tone.start();
  }

  get isReady() {
    return this.accomp !== null;
  }

  /* ------------------------------- transport ------------------------------ */

  async play() {
    const store = useMusicStore.getState();
    if (store.progression.length === 0) return;
    await this.unlock();
    const Tone = this.tone!;
    const transport = Tone.getTransport();
    if (this.repeatId === null)
      this.scheduleClock(stepSubdivision(store.timeSignature));
    transport.start("+0.05");
    store.setPlaying(true);
  }

  pause() {
    if (!this.tone) return;
    this.tone.getTransport().pause();
    this.accomp?.releaseAll(this.tone.now() + 0.15);
    keyBus.clear();
    useMusicStore.getState().setPlaying(false);
  }

  stop() {
    if (this.tone) {
      const transport = this.tone.getTransport();
      transport.stop();
      if (this.repeatId !== null) transport.clear(this.repeatId);
      this.repeatId = null;
      this.tone.getDraw().cancel(0);
      this.accomp?.releaseAll(this.tone.now() + 0.1);
    }
    this.pos = -1;
    keyBus.clear();
    const store = useMusicStore.getState();
    store.setPlaying(false);
    store.resetPlayhead();
  }

  toggle() {
    return useMusicStore.getState().isPlaying ? this.pause() : this.play();
  }

  /** Continue playback from the start of a given chord slot (click on the timeline). */
  jumpTo(slot: number) {
    const state = useMusicStore.getState();
    const tl = getTimeline(state.progression, stepsPerBar(state.timeSignature));
    this.pos = (tl.starts[slot] ?? 0) - 1;
    useMusicStore.getState().jumpToSlot(slot);
    if (!useMusicStore.getState().isPlaying) {
      useMusicStore
        .getState()
        .setPlayhead({ currentStep: -1, currentBeat: -1 });
    }
  }

  setBpm(bpm: number) {
    this.tone?.getTransport().bpm.rampTo(bpm, 0.1);
  }

  setVolume(v: number) {
    this.master?.volume.rampTo(this.volumeToDb(v), 0.05);
  }

  setTimeSignature(ts: TimeSignature) {
    if (!this.tone) return;
    this.tone.getTransport().timeSignature = BEATS_PER_BAR[ts];
    // Re-map the position onto the new bar grid, restarting at the current bar's downbeat.
    const bar = Math.floor(Math.max(this.pos, 0) / this.barSteps);
    this.barSteps = stepsPerBar(ts);
    this.pos = bar * this.barSteps - 1;
    // 16th grid ⇄ triplet grid needs a different clock.
    const subdivision = stepSubdivision(ts);
    if (this.repeatId !== null && subdivision !== this.subdivision)
      this.scheduleClock(subdivision);
  }

  private scheduleClock(subdivision: "16n" | "8t") {
    const transport = this.tone!.getTransport();
    if (this.repeatId !== null) transport.clear(this.repeatId);
    this.subdivision = subdivision;
    this.repeatId = transport.scheduleRepeat(
      (time) => this.tick(time),
      subdivision,
    );
  }

  private volumeToDb(v: number) {
    return v <= 0
      ? -Infinity
      : 20 * Math.log10(Math.pow(v / 100, 2)) + MASTER_GAIN_DB;
  }

  /* ------------------------------ sequencer ------------------------------ */

  /** Called by Tone.Transport ahead of time for every 16th note. `time` is the exact audio time. */
  private tick(time: number) {
    const Tone = this.tone!;
    const state = useMusicStore.getState();
    this.barSteps = stepsPerBar(state.timeSignature);
    this.pos++;

    const res = resolveStep({
      slots: state.progression,
      styleId: state.styleId,
      patternId: state.patternId,
      pos: this.pos,
      sustain: state.sustain,
    });
    if (!res) {
      Tone.getDraw().schedule(() => this.stop(), time);
      return;
    }

    const stepSec = Tone.Time(this.subdivision).toSeconds();
    const swung = time + res.swingSteps * stepSec;

    for (const note of res.notes) {
      const t = state.humanize ? swung + rand() * HUMANIZE_TIME : swung;
      const velocity = Math.min(
        1,
        Math.max(
          0.05,
          note.velocity * (state.humanize ? 1 + rand() * HUMANIZE_VELOCITY : 1),
        ),
      );
      const sound =
        note.soundSteps * stepSec + (note.pedalReleased ? PEDAL_LIFT_DELAY : 0);
      const name = midiToNoteName(note.midi);
      this.accomp?.triggerAttackRelease(
        name,
        sound,
        Math.max(t, Tone.now()),
        velocity,
      );

      const fingerLength = note.lengthSteps * stepSec * 0.92;
      Tone.getDraw().schedule(
        () => keyBus.on(note.midi, note.lane, velocity),
        t,
      );
      Tone.getDraw().schedule(
        () => keyBus.off(note.midi, note.lane),
        t + fingerLength,
      );
    }

    if (state.metronome && res.isBeatStart) {
      this.click?.triggerAttackRelease(
        res.isDownbeat ? 1760 : 1175,
        0.03,
        time,
        res.isDownbeat ? 0.9 : 0.55,
      );
    }

    Tone.getDraw().schedule(() => {
      const s = useMusicStore.getState();
      const update: {
        currentStep: number;
        currentBeat: number;
        currentSlot?: number;
      } = { currentStep: res.patternStep, currentBeat: res.slotBeat };
      if (res.slot !== s.currentSlot) update.currentSlot = res.slot;
      s.setPlayhead(update);
    }, time);
  }

  /* ------------------------------- live play ------------------------------ */

  /*
   * Live notes use `Tone.immediate()` (= AudioContext.currentTime), NOT `Tone.now()`:
   * now() adds the context's lookAhead (100 ms by default), which is only useful for the
   * sequencer's pre-scheduled notes and would be heard as lag on every key press.
   * Audio is triggered before the key highlight, whose DOM work can force a layout.
   */
  liveNoteOn(midi: number, velocity = 0.8) {
    this.heldKeys.add(midi);
    this.sustainedKeys.delete(midi);
    if (!this.tone || !this.live) {
      void this.unlock();
    } else {
      if (this.tone.getContext().state !== "running") void this.tone.start();
      this.live.triggerAttack(
        midiToNoteName(midi),
        this.tone.immediate(),
        velocity,
      );
    }
    keyBus.on(midi, "user", velocity);
  }

  liveNoteOff(midi: number) {
    this.heldKeys.delete(midi);
    if (this.tone && this.live) {
      if (this.pedalDown) {
        this.sustainedKeys.add(midi);
      } else {
        this.live.triggerRelease(midiToNoteName(midi), this.tone.immediate());
      }
    }
    keyBus.off(midi, "user");
  }

  /** Sustain pedal (CC64): on release, damp every note that is no longer held by a finger. */
  setPedal(down: boolean) {
    this.pedalDown = down;
    if (down || !this.tone || !this.live) return;
    const now = this.tone.immediate();
    for (const midi of this.sustainedKeys) {
      if (!this.heldKeys.has(midi))
        this.live.triggerRelease(midiToNoteName(midi), now);
    }
    this.sustainedKeys.clear();
  }

  /** One-shot preview of a chord (click on a chord card). */
  async previewChord(notes: number[], lanes: ("left" | "right")[]) {
    await this.unlock();
    const Tone = this.tone!;
    const now = Tone.immediate() + 0.005;
    notes.forEach((midi, i) => {
      const t = now + i * 0.012; // tiny roll so it sounds played, not triggered
      this.live?.triggerAttackRelease(midiToNoteName(midi), 1.6, t, 0.62);
      Tone.getDraw().schedule(
        () => keyBus.on(midi, lanes[i] ?? "right", 0.62),
        t,
      );
      Tone.getDraw().schedule(
        () => keyBus.off(midi, lanes[i] ?? "right"),
        t + 0.9,
      );
    });
  }
}

/** Drop the silent lead-in so the sample's attack lands right at trigger time. */
function trimLeadingSilence(
  buffer: ToneNS.ToneAudioBuffer,
): ToneNS.ToneAudioBuffer {
  const data = buffer.getChannelData(0);
  let i = 0;
  while (i < data.length && Math.abs(data[i]) < ONSET_THRESHOLD) i++;
  const start = Math.max(0, i / buffer.sampleRate - ONSET_PREROLL);
  return start > 0 && i < data.length ? buffer.slice(start) : buffer;
}

export const audioEngine = new AudioEngine();

/* -------------------------------------------------------------------------- */
/*                                  Web MIDI                                  */
/* -------------------------------------------------------------------------- */

function handleMidiMessage(e: MIDIMessageEvent) {
  const data = e.data;
  if (!data || data.length < 2) return;
  const [status, d1, d2 = 0] = data;
  const command = status & 0xf0;
  if (command === 0x90 && d2 > 0) {
    audioEngine.liveNoteOn(d1, d2 / 127);
    const s = useMusicStore.getState();
    s.pingMidi();
    // The piano played a key we don't show → it's bigger than we guessed; grow to fit.
    const { low, high } = KEYBOARD_SIZES[s.detectedKeyCount];
    if (d1 < low || d1 > high)
      s.setDetectedKeyCount(keyCountCovering(d1, s.detectedKeyCount));
  } else if (command === 0x80 || (command === 0x90 && d2 === 0)) {
    audioEngine.liveNoteOff(d1);
  } else if (command === 0xb0 && d1 === 64) {
    audioEngine.setPedal(d2 >= 64);
  }
}

function useWebMidi() {
  useEffect(() => {
    const store = useMusicStore.getState();
    if (
      typeof navigator === "undefined" ||
      !("requestMIDIAccess" in navigator)
    ) {
      store.setMidiStatus("unsupported");
      return;
    }

    let access: MIDIAccess | null = null;
    let cancelled = false;

    const bind = () => {
      if (!access) return;
      const selected = useMusicStore.getState().selectedMidiId;
      access.inputs.forEach((input) => {
        const listen = selected === "all" || selected === input.id;
        input.onmidimessage = listen ? handleMidiMessage : null;
      });
    };

    const refresh = () => {
      if (!access) return;
      const devices: MidiDeviceInfo[] = [];
      access.inputs.forEach((input) =>
        devices.push({
          id: input.id,
          name: input.name ?? "MIDI Input",
          manufacturer: input.manufacturer ?? "",
          connected: input.state === "connected",
        }),
      );
      const s = useMusicStore.getState();
      s.setMidiDevices(devices);
      // A previously-selected device that disappeared falls back to auto ("all").
      if (
        s.selectedMidiId !== "all" &&
        s.selectedMidiId !== "off" &&
        !devices.some((d) => d.id === s.selectedMidiId && d.connected)
      ) {
        s.selectMidiDevice("all");
      }
      bind();
      detectKeyCount(devices);
    };

    /** Guess the size from the listened-to device names; the largest match wins. */
    const detectKeyCount = (devices: MidiDeviceInfo[]) => {
      const selected = useMusicStore.getState().selectedMidiId;
      const guesses = devices
        .filter((d) => d.connected && (selected === "all" || selected === d.id))
        .map((d) => guessKeyCount(d.name) ?? guessKeyCount(d.manufacturer))
        .filter((k): k is KeyCount => k !== null);
      useMusicStore
        .getState()
        .setDetectedKeyCount(
          guesses.length
            ? (Math.max(...guesses) as KeyCount)
            : DEFAULT_KEY_COUNT,
        );
    };

    navigator
      .requestMIDIAccess({ sysex: false })
      .then((a) => {
        if (cancelled) return;
        access = a;
        access.onstatechange = refresh; // hot-plug: USB keyboards plugged in later are picked up
        useMusicStore.getState().setMidiStatus("ready");
        refresh();
      })
      .catch(() => useMusicStore.getState().setMidiStatus("denied"));

    const unsub = useMusicStore.subscribe(
      (s) => s.selectedMidiId,
      () => {
        bind();
        detectKeyCount(useMusicStore.getState().midiDevices);
      },
    );

    return () => {
      cancelled = true;
      unsub();
      if (access) {
        access.onstatechange = null;
        access.inputs.forEach((input) => (input.onmidimessage = null));
      }
    };
  }, []);
}

/* -------------------------------------------------------------------------- */
/*                                    Hook                                    */
/* -------------------------------------------------------------------------- */

/**
 * Mount once at the app root. Wires the Zustand store to the singleton engine and
 * sets up Web MIDI. Components talk to the engine through `audioEngine` directly.
 */
export function useAudioEngine() {
  useEffect(() => {
    // Preload samples right away; decoding works on a suspended AudioContext.
    void audioEngine.load();

    const unsubs = [
      useMusicStore.subscribe(
        (s) => s.bpm,
        (bpm) => audioEngine.setBpm(bpm),
      ),
      useMusicStore.subscribe(
        (s) => s.volume,
        (v) => audioEngine.setVolume(v),
      ),
      useMusicStore.subscribe(
        (s) => s.timeSignature,
        (ts) => audioEngine.setTimeSignature(ts),
      ),
    ];

    // Unlock audio on the first interaction anywhere on the page.
    const unlock = () => void audioEngine.unlock();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });

    return () => {
      unsubs.forEach((u) => u());
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useWebMidi();

  return audioEngine;
}
