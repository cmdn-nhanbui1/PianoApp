/**
 * Advanced Music Theory Engine
 * ----------------------------
 * - Chord parsing (incl. slash chords) → pitch classes via interval formulas
 * - Voicing enumeration (all close-position inversions inside a hand range)
 * - Smooth voice leading solved globally with a Viterbi / dynamic-programming pass
 * - Bass-line smoothing, fingering suggestions and hand-position tips
 *
 * All pitches are MIDI numbers (C4 = 60). Pitch classes (pc) are 0..11 with C = 0.
 */

export const NOTE_NAMES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
export const NOTE_NAMES_FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"] as const;

/** 61-key controller range: C2 (36) → C7 (96). */
export const KEYBOARD_LOW = 36;
export const KEYBOARD_HIGH = 96;

/** Standard keyboard sizes and the range each one physically covers. */
export const KEYBOARD_SIZES = {
  25: { low: 48, high: 72 }, // C3 → C5
  37: { low: 48, high: 84 }, // C3 → C6
  49: { low: 36, high: 84 }, // C2 → C6
  61: { low: 36, high: 96 }, // C2 → C7
  76: { low: 28, high: 103 }, // E1 → G7
  88: { low: 21, high: 108 }, // A0 → C8
} as const;
export type KeyCount = keyof typeof KEYBOARD_SIZES;
export const KEY_COUNTS = Object.keys(KEYBOARD_SIZES).map(Number) as KeyCount[];
export const DEFAULT_KEY_COUNT: KeyCount = 61;

/** Web MIDI doesn't expose the key count — many devices put it in their name ("Keystation 88", "Oxygen 49"…). */
export function guessKeyCount(deviceName: string): KeyCount | null {
  const m = /(?:^|\D)(25|37|49|61|76|88)(?:\D|$)/.exec(deviceName);
  return m ? (Number(m[1]) as KeyCount) : null;
}

/** Smallest standard size that covers both the current range and `midi`. */
export function keyCountCovering(midi: number, current: KeyCount): KeyCount {
  const { low, high } = KEYBOARD_SIZES[current];
  const lo = Math.min(low, midi);
  const hi = Math.max(high, midi);
  return KEY_COUNTS.find((k) => KEYBOARD_SIZES[k].low <= lo && KEYBOARD_SIZES[k].high >= hi) ?? 88;
}

/** Hand ranges used by the voicing engine. */
export const RIGHT_HAND_RANGE = { low: 53, high: 81, center: 66 } as const; // F3 → A5, centred on F#4
export const LEFT_HAND_RANGE = { low: 36, high: 55, center: 45 } as const; // C2 → G3, centred on A2

const LETTER_TO_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const BLACK_PCS = new Set([1, 3, 6, 8, 10]);

export const mod12 = (n: number) => ((n % 12) + 12) % 12;
export const isBlackKey = (midi: number) => BLACK_PCS.has(mod12(midi));

export function noteNameToPc(name: string): number | null {
  const m = /^([A-Ga-g])([#b♯♭]*)$/.exec(name.trim());
  if (!m) return null;
  let pc = LETTER_TO_PC[m[1].toUpperCase()];
  for (const acc of m[2]) pc += acc === "#" || acc === "♯" ? 1 : -1;
  return mod12(pc);
}

export function pcToName(pc: number, preferFlats = false): string {
  return (preferFlats ? NOTE_NAMES_FLAT : NOTE_NAMES_SHARP)[mod12(pc)];
}

export function midiToNoteName(midi: number, preferFlats = false): string {
  return `${pcToName(midi, preferFlats)}${Math.floor(midi / 12) - 1}`;
}

/** "C#4" → 61 */
export function noteNameToMidi(name: string): number | null {
  const m = /^([A-Ga-g][#b]*)(-?\d)$/.exec(name.trim());
  if (!m) return null;
  const pc = noteNameToPc(m[1]);
  if (pc === null) return null;
  return (parseInt(m[2], 10) + 1) * 12 + pc;
}

/** Solfège names — handy for Vietnamese learners. */
const SOLFEGE = ["Đô", "Đô#", "Rê", "Rê#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"];
export const pcToSolfege = (pc: number) => SOLFEGE[mod12(pc)];

/* -------------------------------------------------------------------------- */
/*                               Chord formulas                               */
/* -------------------------------------------------------------------------- */

export interface ChordFormula {
  /** Canonical suffix, e.g. "m7". */
  suffix: string;
  label: string;
  /** Full chord spelling as semitone intervals from the root. */
  intervals: number[];
  /**
   * Intervals the right hand actually plays. Extended chords drop the root (left hand
   * covers it) and/or the 5th/11th so the voicing stays playable (≤ 4 notes).
   */
  rightHand: number[];
  aliases: string[];
}

export const CHORD_FORMULAS: ChordFormula[] = [
  { suffix: "", label: "Major", intervals: [0, 4, 7], rightHand: [0, 4, 7], aliases: ["", "M", "maj", "major"] },
  { suffix: "m", label: "Minor", intervals: [0, 3, 7], rightHand: [0, 3, 7], aliases: ["m", "min", "-", "minor"] },
  { suffix: "dim", label: "Diminished", intervals: [0, 3, 6], rightHand: [0, 3, 6], aliases: ["dim", "°", "o"] },
  { suffix: "aug", label: "Augmented", intervals: [0, 4, 8], rightHand: [0, 4, 8], aliases: ["aug", "+", "#5"] },
  { suffix: "sus2", label: "Suspended 2nd", intervals: [0, 2, 7], rightHand: [0, 2, 7], aliases: ["sus2", "2"] },
  { suffix: "sus4", label: "Suspended 4th", intervals: [0, 5, 7], rightHand: [0, 5, 7], aliases: ["sus4", "sus", "4"] },
  { suffix: "6", label: "Major 6th", intervals: [0, 4, 7, 9], rightHand: [0, 4, 7, 9], aliases: ["6", "maj6"] },
  { suffix: "m6", label: "Minor 6th", intervals: [0, 3, 7, 9], rightHand: [0, 3, 7, 9], aliases: ["m6", "min6"] },
  { suffix: "7", label: "Dominant 7th", intervals: [0, 4, 7, 10], rightHand: [0, 4, 7, 10], aliases: ["7", "dom7"] },
  { suffix: "m7", label: "Minor 7th", intervals: [0, 3, 7, 10], rightHand: [0, 3, 7, 10], aliases: ["m7", "min7", "-7"] },
  { suffix: "maj7", label: "Major 7th", intervals: [0, 4, 7, 11], rightHand: [0, 4, 7, 11], aliases: ["maj7", "M7", "Δ", "Δ7", "ma7"] },
  { suffix: "mMaj7", label: "Minor-major 7th", intervals: [0, 3, 7, 11], rightHand: [0, 3, 7, 11], aliases: ["mMaj7", "mM7", "m(maj7)"] },
  { suffix: "dim7", label: "Diminished 7th", intervals: [0, 3, 6, 9], rightHand: [0, 3, 6, 9], aliases: ["dim7", "°7", "o7"] },
  { suffix: "m7b5", label: "Half-diminished", intervals: [0, 3, 6, 10], rightHand: [0, 3, 6, 10], aliases: ["m7b5", "ø", "ø7", "-7b5"] },
  { suffix: "7sus4", label: "Dominant 7 sus4", intervals: [0, 5, 7, 10], rightHand: [0, 5, 7, 10], aliases: ["7sus4", "7sus"] },
  { suffix: "add9", label: "Add 9", intervals: [0, 4, 7, 14], rightHand: [0, 4, 7, 14], aliases: ["add9", "add2"] },
  { suffix: "madd9", label: "Minor add 9", intervals: [0, 3, 7, 14], rightHand: [0, 3, 7, 14], aliases: ["madd9", "m(add9)"] },
  // Extended chords: root lives in the left hand, right hand plays a 4-note rootless voicing.
  { suffix: "9", label: "Dominant 9th", intervals: [0, 4, 7, 10, 14], rightHand: [4, 7, 10, 14], aliases: ["9", "dom9"] },
  { suffix: "maj9", label: "Major 9th", intervals: [0, 4, 7, 11, 14], rightHand: [4, 7, 11, 14], aliases: ["maj9", "M9", "Δ9"] },
  { suffix: "m9", label: "Minor 9th", intervals: [0, 3, 7, 10, 14], rightHand: [3, 7, 10, 14], aliases: ["m9", "min9", "-9"] },
  // 11th: the 3rd clashes with the 11th, so it is omitted (≈ "Bb/C" sound for C11).
  { suffix: "11", label: "Dominant 11th", intervals: [0, 4, 7, 10, 14, 17], rightHand: [7, 10, 14, 17], aliases: ["11", "dom11"] },
  { suffix: "m11", label: "Minor 11th", intervals: [0, 3, 7, 10, 14, 17], rightHand: [3, 10, 14, 17], aliases: ["m11", "min11"] },
  // 13th: classic 3-7-9-13 voicing (5th and 11th omitted).
  { suffix: "13", label: "Dominant 13th", intervals: [0, 4, 7, 10, 14, 17, 21], rightHand: [4, 10, 14, 21], aliases: ["13", "dom13"] },
];

const ALIAS_LOOKUP = new Map<string, ChordFormula>();
for (const f of CHORD_FORMULAS) for (const a of f.aliases) ALIAS_LOOKUP.set(a, f);

/** Suffixes offered in the chord builder UI. */
export const QUICK_QUALITIES = ["", "m", "7", "m7", "maj7", "sus2", "sus4", "dim", "aug", "add9", "9", "11", "13"];

/* -------------------------------------------------------------------------- */
/*                                Chord parsing                               */
/* -------------------------------------------------------------------------- */

export interface Chord {
  symbol: string;
  root: number;
  rootName: string;
  formula: ChordFormula;
  /** Bass pitch class (differs from root for slash chords). */
  bass: number;
  bassName: string;
  isSlash: boolean;
  /** Full chord pitch classes in interval order (root first). */
  pitchClasses: number[];
  /** Pitch classes the right hand plays, in interval order. */
  rightHandPcs: number[];
}

const CHORD_RE = /^([A-G](?:#|b|♯|♭)?)([^/]*)(?:\/([A-G](?:#|b|♯|♭)?))?$/;

export function parseChord(input: string): Chord | null {
  const symbol = input.trim().replace(/\s+/g, "");
  const m = CHORD_RE.exec(symbol);
  if (!m) return null;
  const root = noteNameToPc(m[1]);
  if (root === null) return null;
  const formula = ALIAS_LOOKUP.get(m[2]);
  if (!formula) return null;
  const bass = m[3] ? noteNameToPc(m[3]) : root;
  if (bass === null) return null;

  const uniq = (xs: number[]) => xs.filter((x, i) => xs.indexOf(x) === i);
  return {
    symbol,
    root,
    rootName: m[1].replace("♯", "#").replace("♭", "b"),
    formula,
    bass,
    bassName: m[3] ? m[3].replace("♯", "#").replace("♭", "b") : m[1],
    isSlash: bass !== root,
    pitchClasses: uniq(formula.intervals.map((i) => mod12(root + i))),
    rightHandPcs: uniq(formula.rightHand.map((i) => mod12(root + i))),
  };
}

export const isValidChord = (s: string) => parseChord(s) !== null;

/** Conventional root spellings: Db/Eb/F#/Ab/Bb for major-type chords, C#m/Ebm/F#m/G#m/Bbm for minor. */
const MAJOR_SPELLING = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const MINOR_SPELLING = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"];

/** Transpose a chord symbol by `semitones`, preserving quality and slash bass. */
export function transposeChordSymbol(symbol: string, semitones: number, preferFlats = false): string {
  const chord = parseChord(symbol);
  if (!chord) return symbol;
  const quality = CHORD_RE.exec(chord.symbol)![2];
  const minor = chord.formula.intervals.includes(3) && !chord.formula.intervals.includes(4);
  const spell = (pc: number, table: string[]) => (preferFlats ? pcToName(pc, true) : table[mod12(pc)]);
  const root = spell(chord.root + semitones, minor ? MINOR_SPELLING : MAJOR_SPELLING);
  const bass = chord.isSlash ? `/${spell(chord.bass + semitones, MAJOR_SPELLING)}` : "";
  return `${root}${quality}${bass}`;
}

/** Heuristic: use flats when the progression is written with flats. */
export function prefersFlats(symbols: string[]): boolean {
  let flats = 0;
  let sharps = 0;
  for (const s of symbols) {
    flats += (s.match(/[A-G]b/g) ?? []).length;
    sharps += (s.match(/#/g) ?? []).length;
  }
  return flats > sharps;
}

/* -------------------------------------------------------------------------- */
/*                         Voicing & voice leading                            */
/* -------------------------------------------------------------------------- */

export interface Voicing {
  chord: Chord;
  /** Right-hand notes, ascending. */
  rightHand: number[];
  /** Left-hand bass note (respects slash bass). */
  bass: number;
  /** Chord 5th placed above the bass (for alternating bass patterns). */
  fifth: number;
  /** Bass + octave. */
  octave: number;
  /** 0 = root position, 1 = 1st inversion … (relative to the right-hand chord). */
  inversion: number;
}

/**
 * Enumerate every close-position voicing of `pcs` inside [low, high].
 * For n pitch classes there are n rotations (inversions) × every octave that fits.
 */
export function enumerateVoicings(pcs: number[], low: number = RIGHT_HAND_RANGE.low, high: number = RIGHT_HAND_RANGE.high): number[][] {
  const out: number[][] = [];
  // Sort by pitch class so every rotation stacks upward within one octave (true close position).
  const sorted = [...pcs].sort((a, b) => a - b);
  const n = sorted.length;
  for (let r = 0; r < n; r++) {
    const rotation = [...sorted.slice(r), ...sorted.slice(0, r)];
    // First note: every octave instance in range.
    for (let start = low; start <= high; start++) {
      if (mod12(start) !== rotation[0]) continue;
      const notes = [start];
      for (let i = 1; i < n; i++) {
        let next = notes[i - 1] + 1;
        while (mod12(next) !== rotation[i]) next++;
        notes.push(next);
      }
      if (notes[n - 1] <= high) out.push(notes);
    }
  }
  return out;
}

/** Total semitone movement between two voicings (lower = smoother). */
export function voiceLeadingDistance(a: number[], b: number[]): number {
  if (a.length === b.length) {
    // Both ascending: pairing voice-by-voice is optimal for close voicings.
    let d = 0;
    for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
    return d;
  }
  // Different sizes (triad ↔ 7th): symmetric nearest-neighbour distance.
  const nearest = (x: number, set: number[]) => Math.min(...set.map((y) => Math.abs(x - y)));
  let d = 0;
  for (const x of a) d += nearest(x, b);
  for (const y of b) d += nearest(y, a);
  return d / 2;
}

const center = (notes: number[]) => notes.reduce((s, n) => s + n, 0) / notes.length;

/** Static cost of a voicing: keeps the hand near the centre of the keyboard and away from the bass. */
function registerCost(notes: number[], bass: number): number {
  const drift = Math.abs(center(notes) - RIGHT_HAND_RANGE.center) * 0.35;
  const mud = notes[0] - bass < 7 ? 6 : 0; // RH crowding into the LH register sounds muddy
  const span = notes[notes.length - 1] - notes[0] > 12 ? 4 : 0; // unplayable stretch penalty
  return drift + mud + span;
}

function chooseBass(pc: number, prev: number | null): number {
  const candidates: number[] = [];
  for (let m = LEFT_HAND_RANGE.low; m <= LEFT_HAND_RANGE.high - 5; m++) if (mod12(m) === pc) candidates.push(m);
  let best = candidates[0];
  let bestCost = Infinity;
  for (const c of candidates) {
    const cost = (prev === null ? 0 : Math.abs(c - prev)) + Math.abs(c - LEFT_HAND_RANGE.center) * 0.6;
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  return best;
}

function inversionOf(notes: number[], chord: Chord): number {
  const idx = chord.rightHandPcs.indexOf(mod12(notes[0]));
  return idx < 0 ? 0 : idx;
}

/**
 * Voice a whole progression with globally-minimal hand movement.
 *
 * A greedy "closest next chord" approach tends to drift up or down the keyboard.
 * Instead we run a Viterbi pass: each chord's candidate voicings are states, the
 * transition cost is the voice-leading distance, and the node cost keeps the hand
 * in a comfortable register. `loop` also accounts for the wrap-around from the last
 * chord back to the first, which matters for a looping accompaniment.
 */
export function voiceProgression(chords: Chord[], loop = true): Voicing[] {
  if (chords.length === 0) return [];

  // Bass line first (greedy smoothing is enough for a single voice).
  const basses: number[] = [];
  chords.forEach((c, i) => basses.push(chooseBass(c.bass, i === 0 ? null : basses[i - 1])));

  const candidates = chords.map((c) => enumerateVoicings(c.rightHandPcs));

  const solve = (firstFixed: number | null) => {
    const cost: number[][] = [];
    const back: number[][] = [];
    candidates.forEach((cands, i) => {
      cost.push([]);
      back.push([]);
      cands.forEach((v, j) => {
        const node = registerCost(v, basses[i]) + (inversionOf(v, chords[i]) === 0 ? 0 : 0.5);
        if (i === 0) {
          cost[0][j] = firstFixed === null || firstFixed === j ? node : Infinity;
          back[0][j] = -1;
          return;
        }
        let best = Infinity;
        let arg = 0;
        candidates[i - 1].forEach((pv, k) => {
          const c = cost[i - 1][k] + voiceLeadingDistance(pv, v);
          if (c < best) {
            best = c;
            arg = k;
          }
        });
        cost[i][j] = best + node;
        back[i][j] = arg;
      });
    });
    const last = candidates.length - 1;
    let end = 0;
    let total = Infinity;
    cost[last].forEach((c, j) => {
      const wrap = loop && firstFixed !== null && chords.length > 1 ? voiceLeadingDistance(candidates[last][j], candidates[0][firstFixed]) : 0;
      if (c + wrap < total) {
        total = c + wrap;
        end = j;
      }
    });
    const path: number[] = new Array(candidates.length);
    path[last] = end;
    for (let i = last; i > 0; i--) path[i - 1] = back[i][path[i]];
    return { path, total };
  };

  // For looping progressions, try every starting voicing so the wrap-around is smooth too.
  let best = loop && chords.length > 1 ? solve(0) : solve(null);
  if (loop && chords.length > 1) {
    for (let s = 1; s < candidates[0].length; s++) {
      const r = solve(s);
      if (r.total < best.total) best = r;
    }
  }

  return chords.map((chord, i) => {
    const rightHand = candidates[i][best.path[i]];
    const bass = basses[i];
    let fifth = bass + 1;
    const iv = chord.formula.intervals;
    const fifthPc = mod12(chord.root + (iv.includes(7) ? 7 : iv.includes(6) ? 6 : iv.includes(8) ? 8 : 7));
    while (mod12(fifth) !== fifthPc) fifth++;
    return { chord, rightHand, bass, fifth, octave: bass + 12, inversion: inversionOf(rightHand, chord) };
  });
}

/** Voice a single chord in isolation (e.g. for previews). */
export function voiceChord(chord: Chord, previous?: number[]): Voicing {
  if (!previous) return voiceProgression([chord], false)[0];
  const cands = enumerateVoicings(chord.rightHandPcs);
  const bass = chooseBass(chord.bass, null);
  const rh = cands.reduce((best, v) =>
    voiceLeadingDistance(previous, v) + registerCost(v, bass) < voiceLeadingDistance(previous, best) + registerCost(best, bass) ? v : best,
  );
  const base = voiceProgression([chord], false)[0];
  return { ...base, rightHand: rh, inversion: inversionOf(rh, chord) };
}

/* -------------------------------------------------------------------------- */
/*                         Fingering & hand guidance                          */
/* -------------------------------------------------------------------------- */

export const INVERSION_NAMES = ["Thế gốc", "Đảo 1", "Đảo 2", "Đảo 3"];

/** Right-hand fingers for an ascending close voicing. 1 = thumb … 5 = pinky. */
export function rightHandFingering(notes: number[]): number[] {
  switch (notes.length) {
    case 1:
      return [1];
    case 2:
      return [1, 5];
    case 3: {
      // Root position & 2nd inversion → 1-3-5. 1st inversion (4th on top) → 1-2-5.
      const upperGap = notes[2] - notes[1];
      return upperGap >= 5 ? [1, 2, 5] : [1, 3, 5];
    }
    case 4: {
      // Put finger 4 where the widest gap is NOT — the gap goes between 3 and 5 or 1 and 2.
      const gaps = [notes[1] - notes[0], notes[2] - notes[1], notes[3] - notes[2]];
      const widest = gaps.indexOf(Math.max(...gaps));
      if (widest === 2) return [1, 2, 3, 5];
      if (widest === 0) return [1, 3, 4, 5];
      return [1, 2, 4, 5];
    }
    default:
      return notes.map((_, i) => Math.min(i + 1, 5));
  }
}

/** Left-hand fingers for ascending notes (bass first). */
export function leftHandFingering(notes: number[]): number[] {
  if (notes.length === 1) return [5];
  if (notes.length === 2) return notes[1] - notes[0] >= 10 ? [5, 1] : [5, 2];
  if (notes.length === 3) return [5, notes[1] - notes[0] <= 4 ? 3 : 2, 1];
  return notes.map((_, i) => Math.max(5 - i, 1));
}

export interface HandGuide {
  leftNotes: number[];
  leftFingers: number[];
  rightNotes: number[];
  rightFingers: number[];
  inversionName: string;
  tips: string[];
}

export function buildHandGuide(current: Voicing, next?: Voicing, preferFlats = false): HandGuide {
  const leftNotes = [current.bass, current.fifth, current.octave].filter((n, i, a) => a.indexOf(n) === i).sort((a, b) => a - b);
  const leftFingers = leftHandFingering(leftNotes);
  const rightNotes = current.rightHand;
  const rightFingers = rightHandFingering(rightNotes);
  const name = (m: number) => chordToneName(m, current.chord, preferFlats);
  const tips: string[] = [];

  tips.push(
    `Tay phải (${INVERSION_NAMES[current.inversion] ?? `Đảo ${current.inversion}`}): ${rightNotes
      .map((n, i) => `${name(n)} (ngón ${rightFingers[i]})`)
      .join(" – ")}.`,
  );
  tips.push(
    current.chord.isSlash
      ? `Hợp âm chồng bass: tay trái đánh ${current.chord.bassName} (${name(current.bass)}) thay vì nốt gốc ${current.chord.rootName} — tạo đường bass đi liền bậc.`
      : `Tay trái: ngón 5 giữ nốt gốc ${name(current.bass)}, ngón 2 ở quãng 5 ${name(current.fifth)}, ngón 1 ở quãng 8 ${name(current.octave)}.`,
  );

  const blackThumb = rightNotes.some((n, i) => rightFingers[i] === 1 && isBlackKey(n));
  if (blackThumb) tips.push("Ngón cái đang ở phím đen: đưa bàn tay vào sâu hơn về phía nắp đàn để các ngón còn lại không bị gò.");

  if (next) {
    const common = rightNotes.filter((n) => next.rightHand.includes(n));
    const move = Math.round(center(next.rightHand) - center(rightNotes));
    if (common.length > 0) {
      tips.push(`Chuyển sang ${next.chord.symbol}: giữ nguyên ${common.map(name).join(", ")} (nốt chung) và chỉ di chuyển các ngón còn lại.`);
    } else if (move !== 0) {
      tips.push(`Chuyển sang ${next.chord.symbol}: dịch cả bàn tay ${move > 0 ? "lên" : "xuống"} khoảng ${Math.abs(move)} nửa cung.`);
    }
    const bassMove = next.bass - current.bass;
    if (Math.abs(bassMove) <= 2 && bassMove !== 0) tips.push(`Bass đi liền bậc ${name(current.bass)} → ${name(next.bass)}: dùng ngón 5 → 4 (hoặc 4 → 5) để nối legato.`);
  }
  return { leftNotes, leftFingers, rightNotes, rightFingers, inversionName: INVERSION_NAMES[current.inversion] ?? "", tips };
}

/**
 * Spell a chord tone by its function, not by the nearest black key: in C7 the ♭7 is B♭,
 * not A#; in E major the 3rd is G#, not Ab. The letter comes from the chord degree
 * (root letter + 0…6), the accidental from the actual pitch.
 */
const LETTERS = ["C", "D", "E", "F", "G", "A", "B"];
// semitones above the root (mod 12) → scale degree (0 = root … 6 = 7th)
const INTERVAL_DEGREE = [0, 1, 1, 2, 2, 3, 4, 4, 4, 5, 6, 6];

export function chordToneName(midi: number, chord: Chord, preferFlats = false): string {
  const pc = mod12(midi);
  if (chord.isSlash && pc === chord.bass) return spellWithLetter(midi, chord.bassName[0]);
  if (!chord.pitchClasses.includes(pc)) return midiToNoteName(midi, preferFlats);
  const interval = mod12(pc - chord.root);
  let degree = INTERVAL_DEGREE[interval];
  if (interval === 8 && !chord.formula.intervals.includes(8)) degree = 5; // ♭13, not #5
  const letter = LETTERS[(LETTERS.indexOf(chord.rootName[0]) + degree) % 7];
  return spellWithLetter(midi, letter);
}

function spellWithLetter(midi: number, letter: string): string {
  const natural = LETTER_TO_PC[letter];
  let diff = mod12(midi) - natural;
  if (diff > 6) diff -= 12;
  if (diff < -6) diff += 12;
  if (Math.abs(diff) > 2) return midiToNoteName(midi);
  const accidental = diff > 0 ? "#".repeat(diff) : "b".repeat(-diff);
  // Octave follows the letter (B#3 sounds as C4, Cb4 sounds as B3).
  const octave = Math.floor((midi - diff) / 12) - 1;
  return `${letter}${accidental}${octave}`;
}

/** Human-readable chord spelling, e.g. "G – B – D". */
export function spellChord(chord: Chord, preferFlats = false): string {
  return chord.pitchClasses.map((pc) => chordToneName(60 + pc, chord, preferFlats).replace(/-?\d+$/, "")).join(" – ");
}

/* -------------------------------------------------------------------------- */
/*                              Chord recognition                             */
/* -------------------------------------------------------------------------- */

export interface DetectedChord {
  /** e.g. "Am7/G" — parseable by `parseChord`. */
  symbol: string;
  chord: Chord;
  /** Index into INVERSION_NAMES when the bass is a chord tone (0 = root position), else null. */
  inversion: number | null;
}

/** Tones that may be left out of a voicing without changing the chord's name. */
const OMITTABLE = new Set([7, 17]); // perfect 5th, 11th

/**
 * Name the chord formed by the held keys (needs ≥ 3 distinct pitch classes).
 * Every root/formula pair that explains *all* played pitch classes is scored:
 * fewer omitted tones first, then root in the bass, then the simpler formula
 * (CHORD_FORMULAS is ordered simple → extended). So C-E-G-A over C is C6, over A it's Am7.
 */
export function detectChord(midis: Iterable<number>): DetectedChord | null {
  const notes = [...new Set(midis)].sort((a, b) => a - b);
  const pcs = [...new Set(notes.map(mod12))];
  if (pcs.length < 3) return null;
  const bass = mod12(notes[0]);

  let best: { root: number; formula: ChordFormula; score: number } | null = null;
  for (const root of pcs) {
    CHORD_FORMULAS.forEach((formula, order) => {
      const tones = new Map(formula.intervals.map((i) => [mod12(root + i), i]));
      if (!pcs.every((pc) => tones.has(pc))) return;
      const missing = [...tones].filter(([pc]) => !pcs.includes(pc)).map(([, i]) => i);
      if (!missing.every((i) => OMITTABLE.has(i))) return;
      const score = missing.length * 10 + (root === bass ? 0 : 5) + order * 0.1;
      if (!best || score < best.score) best = { root, formula, score };
    });
  }
  if (!best) return null;

  const { root, formula } = best as { root: number; formula: ChordFormula };
  const minor = formula.intervals.includes(3) && !formula.intervals.includes(4);
  const rootName = (minor ? MINOR_SPELLING : MAJOR_SPELLING)[root];
  const slash = bass !== root ? `/${MAJOR_SPELLING[bass]}` : "";
  const symbol = `${rootName}${formula.suffix}${slash}`;
  const chord = parseChord(symbol);
  if (!chord) return null;
  // Stacking order (root, 3rd, 5th, 7th) → position of the bass = inversion number.
  const stack = formula.intervals.slice(0, 4).map(mod12);
  const inversion = stack.indexOf(mod12(bass - root));
  return { symbol, chord, inversion: inversion >= 0 && inversion < INVERSION_NAMES.length ? inversion : null };
}
