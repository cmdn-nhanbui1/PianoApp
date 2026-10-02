/**
 * Intelligent Accompaniment Sequencer (pure logic, no audio)
 * ----------------------------------------------------------
 * Turns (progression × style pattern × playhead position) into concrete notes.
 * The audio engine calls `resolveStep` once per 16th note from Tone.Transport.
 *
 * Kept free of Tone.js / React so it is deterministic and trivially testable.
 */

import { isValidChord, mod12, parseChord, prefersFlats, voiceProgression, type Chord, type Voicing } from "./music-theory";
import {
  getPattern,
  getStyle,
  patternLength,
  patternTimeSignature,
  stepsPerBar,
  stepsPerBeat,
  type HandLane,
  type NoteTarget,
  type PedalMode,
  type PatternEvent,
  type StylePattern,
} from "./styles";

/** How long a chord slot lasts: a full bar or half a bar (two chords per bar). */
export type SlotLength = "bar" | "half";

export interface SlotInput {
  symbol: string;
  /** Missing = full bar (older saved sessions). */
  length?: SlotLength;
}

export interface ScheduledNote {
  midi: number;
  lane: HandLane;
  /** Written length in steps — what the finger holds (drives the key highlight). */
  lengthSteps: number;
  /** Sounding length in steps once the sustain pedal is applied. */
  soundSteps: number;
  /** True when the pedal (not the finger) ends the note → release slightly after the pedal lift. */
  pedalReleased: boolean;
  velocity: number;
}

export interface StepResolution {
  slot: number;
  patternStep: number;
  stepInBar: number;
  /** Beat inside the current chord slot (drives the beat dots on the chord card). */
  slotBeat: number;
  /** Shuffle delay for this step, in steps (0 when straight). */
  swingSteps: number;
  isBeatStart: boolean;
  isDownbeat: boolean;
  notes: ScheduledNote[];
}

/* ------------------------------ arrangement cache ------------------------------ */

let cachedKey = "";
let cachedVoicings: Voicing[] = [];

/**
 * Voicings for the whole progression, memoised on the chord symbols. Re-voicing runs
 * only when the progression actually changes — never inside the audio callback path
 * for an unchanged progression.
 */
export function getArrangement(symbols: string[]): Voicing[] {
  const key = symbols.join("|");
  if (key === cachedKey) return cachedVoicings;
  const chords = symbols.map(parseChord).filter((c): c is Chord => c !== null);
  cachedVoicings = voiceProgression(chords, true);
  cachedKey = key;
  return cachedVoicings;
}

export const arrangementPrefersFlats = (symbols: string[]) => prefersFlats(symbols);

/* ---------------------------------- timeline ---------------------------------- */

export interface Timeline {
  /** Start step of each slot inside the loop. */
  starts: number[];
  /** End step (exclusive) of each slot. */
  ends: number[];
  /** Loop length in steps — always a whole number of bars. */
  cycle: number;
  bars: number;
  /** True when the last slot was stretched so the loop ends on a bar line. */
  padded: boolean;
}

let cachedTimelineKey = "";
let cachedTimeline: Timeline = { starts: [], ends: [], cycle: 0, bars: 0, padded: false };

export const slotSteps = (length: SlotLength | undefined, barSteps: number) => (length === "half" ? barSteps / 2 : barSteps);

/**
 * Lay the slots end to end. If the progression doesn't end on a bar line (odd number of
 * half-bar slots), the last slot is stretched to the bar line so the loop — and the
 * pattern grid, which is always bar-aligned — stays in time.
 */
export function getTimeline(slots: SlotInput[], barSteps: number): Timeline {
  const key = `${barSteps}:${slots.map((s) => s.length ?? "bar").join(",")}`;
  if (key === cachedTimelineKey) return cachedTimeline;
  const starts: number[] = [];
  const ends: number[] = [];
  let pos = 0;
  for (const s of slots) {
    starts.push(pos);
    pos += slotSteps(s.length, barSteps);
    ends.push(pos);
  }
  const cycle = Math.ceil(pos / barSteps) * barSteps;
  if (ends.length) ends[ends.length - 1] = cycle;
  cachedTimeline = { starts, ends, cycle, bars: cycle / barSteps, padded: cycle !== pos };
  cachedTimelineKey = key;
  return cachedTimeline;
}

function slotAt(tl: Timeline, cyclePos: number): number {
  // Few slots → linear scan is faster than a binary search here.
  for (let i = 0; i < tl.ends.length; i++) if (cyclePos < tl.ends[i]) return i;
  return tl.ends.length - 1;
}

/* ---------------------------- text ⇄ progression ---------------------------- */

/**
 * Parse musician's bar notation:
 *   "G D/F# Em C"          → four full bars (no bar lines = one chord per bar)
 *   "C G/B | Am Am/G | F"  → two chords in each of the first two bars, then F for a full bar
 */
export function parseProgressionText(text: string): { slots: { symbol: string; length: SlotLength }[]; invalid: string[]; error?: string } {
  const invalid: string[] = [];
  const slots: { symbol: string; length: SlotLength }[] = [];
  const hasBarLines = text.includes("|");
  const bars = hasBarLines ? text.split("|") : text.split(/[\s,]+/);
  for (const bar of bars) {
    const tokens = bar.split(/[\s,]+/).filter(Boolean);
    if (tokens.length === 0) continue;
    tokens.filter((t) => !isValidChord(t)).forEach((t) => invalid.push(t));
    if (tokens.length > 2) return { slots: [], invalid, error: `Mỗi ô nhịp tối đa 2 hợp âm: "${tokens.join(" ")}"` };
    const length: SlotLength = tokens.length === 2 ? "half" : "bar";
    tokens.forEach((symbol) => slots.push({ symbol, length }));
  }
  return { slots, invalid };
}

/* ------------------------------ pattern indexing ------------------------------ */

const stepIndex = new WeakMap<StylePattern, Map<number, PatternEvent[]>>();

function eventsAt(pattern: StylePattern, step: number): PatternEvent[] {
  let index = stepIndex.get(pattern);
  if (!index) {
    index = new Map();
    for (const ev of pattern.events) {
      const list = index.get(ev.step) ?? [];
      list.push(ev);
      index.set(ev.step, list);
    }
    stepIndex.set(pattern, index);
  }
  return index.get(step) ?? [];
}

/* ------------------------------ target resolution ------------------------------ */

export function resolveTarget(target: NoteTarget, v: Voicing): number[] {
  const rh = v.rightHand;
  const voice = (index: number) => {
    const n = rh.length;
    if (index < 0) return rh[Math.max(0, n + index)];
    return rh[index % n] + 12 * Math.floor(index / n);
  };
  switch (target.kind) {
    case "bass":
      return [v.bass];
    case "fifth":
      return [v.fifth];
    case "octave":
      return [v.octave];
    case "chord":
      return rh;
    case "voice":
      return [voice(target.index)];
    case "voices":
      return target.indices.map(voice).filter((m, i, a) => a.indexOf(m) === i);
    case "bassInterval": {
      // Root in the bass register (for slash chords: the root just below the written bass).
      const root = v.bass - mod12(v.bass - v.chord.root);
      const iv = v.chord.formula.intervals;
      let semis = target.semitones;
      if (semis === 4 && iv.includes(3) && !iv.includes(4)) semis = 3; // minor 3rd on minor chords
      if (semis === 10 && iv.includes(11)) semis = 11; // major 7th on maj7 chords
      return [root + semis];
    }
  }
}

/* ---------------------------------- pedal ---------------------------------- */

function pedalInterval(mode: PedalMode, barSteps: number, beatSteps: number): number | null {
  switch (mode) {
    case "bar":
      return barSteps;
    case "half-bar":
      return barSteps / 2;
    case "beat":
      return beatSteps;
    case "none":
      return null;
  }
}

/**
 * Legato ("syncopated") pedalling: the pedal is lifted just *after* each change point,
 * so notes struck on the change point are caught by the new pedal while the previous
 * harmony is cleared. Change points are the pattern's pedal grid *and* every chord
 * change — a half-bar chord must never ring into the next chord.
 */
function applyPedal(length: number, stepInBar: number, interval: number | null, stepsToChordChange: number, sustain: boolean) {
  if (!sustain || interval === null) return { soundSteps: length, pedalReleased: false };
  const toGrid = (Math.floor(stepInBar / interval) + 1) * interval - stepInBar;
  const pedalSteps = Math.min(toGrid, stepsToChordChange);
  return pedalSteps > length ? { soundSteps: pedalSteps, pedalReleased: true } : { soundSteps: length, pedalReleased: false };
}

/* --------------------------------- resolve --------------------------------- */

export interface ResolveInput {
  slots: SlotInput[];
  styleId: string;
  patternId: string;
  /** Absolute 16th-note position since playback started (bar-aligned at 0). */
  pos: number;
  sustain: boolean;
}

export function resolveStep({ slots, styleId, patternId, pos, sustain }: ResolveInput): StepResolution | null {
  const voicings = getArrangement(slots.map((s) => s.symbol));
  if (voicings.length === 0 || voicings.length !== slots.length) return null;

  const style = getStyle(styleId);
  const pattern = getPattern(styleId, patternId);
  const ts = patternTimeSignature(style, pattern);
  const barSteps = stepsPerBar(ts);
  const beatSteps = stepsPerBeat(ts);
  const tl = getTimeline(slots, barSteps);

  const bar = Math.floor(pos / barSteps);
  const stepInBar = pos - bar * barSteps;
  const cyclePos = pos % tl.cycle;
  const slot = slotAt(tl, cyclePos);
  const patternStep = ((bar % pattern.bars) * barSteps + stepInBar) % patternLength(pattern, ts);
  const interval = pedalInterval(pattern.pedal, barSteps, beatSteps);

  const notes: ScheduledNote[] = [];
  for (const ev of eventsAt(pattern, patternStep)) {
    // An anticipated ("pushed") event plays the chord that sounds on the next bar line.
    const lead = ev.anticipate ? barSteps - stepInBar : 0;
    const targetPos = (cyclePos + lead) % tl.cycle;
    const targetSlot = slotAt(tl, targetPos);
    const stepsToChordChange = tl.ends[targetSlot] - targetPos + lead;
    // A finger can't hold a note past its chord: cut written lengths at the chord change.
    const length = Math.min(ev.length, stepsToChordChange);
    const pedal = applyPedal(length, stepInBar, interval, stepsToChordChange, sustain);
    for (const midi of resolveTarget(ev.target, voicings[targetSlot])) {
      notes.push({ midi, lane: ev.lane, lengthSteps: length, velocity: ev.velocity, ...pedal });
    }
  }

  const inSlot = cyclePos - tl.starts[slot];
  return {
    slot,
    patternStep,
    stepInBar,
    slotBeat: Math.floor(inSlot / beatSteps),
    // Off-beat 8th of a 16th grid moves from 2/4 to 2/3 of the beat at swing = 1.
    swingSteps: pattern.swing && beatSteps === 4 && stepInBar % 4 === 2 ? pattern.swing * (4 / 6) : 0,
    isBeatStart: stepInBar % beatSteps === 0,
    isDownbeat: stepInBar === 0,
    notes,
  };
}

/** Lane-separated grid for the pattern visualiser: rows = lanes, cells = hit velocity. */
export function patternGrid(styleId: string, patternId: string) {
  const style = getStyle(styleId);
  const pattern = getPattern(styleId, patternId);
  const ts = patternTimeSignature(style, pattern);
  const length = patternLength(pattern, ts);
  const left = new Array<number>(length).fill(0);
  const right = new Array<number>(length).fill(0);
  const leftHold = new Array<boolean>(length).fill(false);
  const rightHold = new Array<boolean>(length).fill(false);
  for (const ev of pattern.events) {
    const hits = ev.lane === "left" ? left : right;
    const hold = ev.lane === "left" ? leftHold : rightHold;
    hits[ev.step] = Math.max(hits[ev.step], ev.velocity);
    for (let s = ev.step + 1; s < Math.min(length, ev.step + ev.length); s++) hold[s] = true;
  }
  return { length, barSteps: stepsPerBar(ts), beatSteps: stepsPerBeat(ts), timeSignature: ts, swing: pattern.swing ?? 0, left, right, leftHold, rightHold };
}
