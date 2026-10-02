/**
 * Style Pattern Library
 * ---------------------
 * Every pattern is a list of events on a step grid:
 *   - 4/4 → 16 steps per bar, 3/4 → 12 steps per bar (16th notes, 4 steps per beat)
 *   - 12/8 → 12 steps per bar (8th-note triplets, 3 steps per dotted-quarter beat)
 *   - multi-bar patterns (e.g. Bossa Nova, 2 bars = 32 steps) set `bars`
 *   - `swing` delays the off-beat 8ths of a 16th grid towards the triplet (shuffle feel)
 *
 * Events never contain absolute pitches. They reference *roles* (bass, 5th, voice n of
 * the right-hand voicing…), so one pattern works for any chord and any voicing that the
 * music-theory engine produces. Left hand (bass line) and right hand (comping) are
 * separate lanes.
 */

export type TimeSignature = "4/4" | "3/4" | "12/8";
export type HandLane = "left" | "right";

export type NoteTarget =
  | { kind: "bass" } // LH bass (slash bass respected)
  | { kind: "fifth" } // LH chord 5th above the bass
  | { kind: "octave" } // LH bass + 12
  | { kind: "chord" } // full RH voicing (block chord)
  | { kind: "voice"; index: number } // one RH voice; index ≥ n wraps up an octave, negative counts from the top
  | { kind: "voices"; indices: number[] } // subset of RH voices
  /**
   * LH note a fixed interval above the chord root (bass register). The 3rd (4) follows the
   * chord quality (minor → 3) and the 7th (10) becomes 11 on maj7 chords — used for
   * boogie / walking lines such as 1-3-5-6-♭7-6-5-3.
   */
  | { kind: "bassInterval"; semitones: number };

export interface PatternEvent {
  step: number;
  lane: HandLane;
  target: NoteTarget;
  /** Written length in grid steps. */
  length: number;
  /** 0..1 */
  velocity: number;
  /** Play the *next* bar's chord (anticipation / "push"), common in pop & bossa. */
  anticipate?: boolean;
}

export type PedalMode = "bar" | "half-bar" | "beat" | "none";
export type PatternKind = "arpeggio" | "block" | "fingerpick";

export interface StylePattern {
  id: string;
  name: string;
  kind: PatternKind;
  description: string;
  bars: 1 | 2;
  /** Where the sustain pedal is changed (legato / syncopated pedalling). */
  pedal: PedalMode;
  /** Overrides the style's meter (e.g. a 12/8 slow blues inside a 4/4 blues style). */
  timeSignature?: TimeSignature;
  /**
   * Shuffle amount for 16th grids: 0 = straight 8ths, 1 = off-beats land exactly on the
   * last 8th-note triplet (hard shuffle). ~0.6 is a lazy swing.
   */
  swing?: number;
  /** Tempo suggested when switching to this pattern changes the meter (e.g. slow blues). */
  defaultBpm?: number;
  events: PatternEvent[];
}

export interface MusicStyle {
  id: string;
  name: string;
  description: string;
  timeSignature: TimeSignature;
  defaultBpm: number;
  patterns: StylePattern[];
}

export const PATTERN_KIND_LABEL: Record<PatternKind, string> = {
  arpeggio: "Rải",
  block: "Dậm khối",
  fingerpick: "Láy ngón",
};

export const BEATS_PER_BAR: Record<TimeSignature, number> = { "4/4": 4, "3/4": 3, "12/8": 4 };
/** 16th grid (4 per beat) for simple meters, triplet grid (3 per beat) for 12/8. */
export const stepsPerBeat = (ts: TimeSignature) => (ts === "12/8" ? 3 : 4);
export const stepsPerBar = (ts: TimeSignature) => BEATS_PER_BAR[ts] * stepsPerBeat(ts);
/** Tone.js subdivision of one grid step. */
export const stepSubdivision = (ts: TimeSignature) => (ts === "12/8" ? "8t" : "16n");
export const patternLength = (p: StylePattern, ts: TimeSignature) => p.bars * stepsPerBar(ts);
export const patternTimeSignature = (style: MusicStyle, p: StylePattern): TimeSignature => p.timeSignature ?? style.timeSignature;
/** Every meter a style offers (a style can mix meters across patterns). */
export const styleTimeSignatures = (style: MusicStyle): TimeSignature[] =>
  [...new Set(style.patterns.map((p) => patternTimeSignature(style, p)))];

/* ------------------------------ event helpers ----------------------------- */

const BASS: NoteTarget = { kind: "bass" };
const FIFTH: NoteTarget = { kind: "fifth" };
const OCTAVE: NoteTarget = { kind: "octave" };
const CHORD: NoteTarget = { kind: "chord" };
const V = (index: number): NoteTarget => ({ kind: "voice", index });
const BI = (semitones: number): NoteTarget => ({ kind: "bassInterval", semitones });
const VS = (...indices: number[]): NoteTarget => ({ kind: "voices", indices });

const L = (step: number, target: NoteTarget, length: number, velocity = 0.78, anticipate = false): PatternEvent => ({
  step,
  lane: "left",
  target,
  length,
  velocity,
  ...(anticipate ? { anticipate } : {}),
});
const R = (step: number, target: NoteTarget, length: number, velocity = 0.62, anticipate = false): PatternEvent => ({
  step,
  lane: "right",
  target,
  length,
  velocity,
  ...(anticipate ? { anticipate } : {}),
});

/* --------------------------------- Ballad --------------------------------- */

const ballad: MusicStyle = {
  id: "ballad",
  name: "Ballad",
  description: "Nhẹ nhàng, sâu lắng — hợp với nhạc trữ tình, nhạc Việt 4/4 chậm.",
  timeSignature: "4/4",
  defaultBpm: 72,
  patterns: [
    {
      id: "ballad-arpeggio",
      name: "Arpeggio 1-5-8",
      kind: "arpeggio",
      description: "Tay trái rải 1-5-8, tay phải nối tiếp đi lên theo móc đơn — dòng chảy liền mạch.",
      bars: 1,
      pedal: "bar",
      events: [
        L(0, BASS, 16, 0.8),
        L(2, FIFTH, 14, 0.5),
        L(4, OCTAVE, 12, 0.52),
        R(6, V(0), 10, 0.5),
        R(8, V(1), 8, 0.58),
        R(10, V(2), 6, 0.52),
        R(12, V(3), 4, 0.6),
        R(14, V(1), 2, 0.46),
      ],
    },
    {
      id: "ballad-block-sync",
      name: "Block Syncopation 3-3-2",
      kind: "block",
      description: "Hợp âm khối theo nhịp 3-3-2 (đảo phách) — cảm giác ballad hiện đại, có lực đẩy.",
      bars: 1,
      pedal: "bar",
      events: [
        L(0, BASS, 6, 0.82),
        L(6, OCTAVE, 6, 0.55),
        L(12, BASS, 4, 0.62),
        R(0, CHORD, 6, 0.64),
        R(6, CHORD, 6, 0.56),
        R(12, CHORD, 4, 0.6),
        R(14, V(-1), 2, 0.4),
      ],
    },
    {
      id: "ballad-block-2",
      name: "Dậm khối 2 lần",
      kind: "block",
      description: "Dậm 2 lần mỗi ô nhịp (phách 1 và phách 3), bass nốt gốc rồi quãng 8. Dùng với hợp âm 1 ô nhịp.",
      bars: 1,
      pedal: "bar",
      events: [
        L(0, BASS, 8, 0.82),
        L(8, OCTAVE, 8, 0.66),
        R(0, CHORD, 8, 0.66),
        R(8, CHORD, 8, 0.56),
      ],
    },
    {
      id: "ballad-block-beats",
      name: "Dậm khối từng phách",
      kind: "block",
      description: "Dậm hợp âm ở cả 4 phách. Hợp âm nửa ô nhịp (½) → mỗi hợp âm dậm 2 lần rồi chuyển ở phách 3; hợp âm 1 ô → dậm 4 lần.",
      bars: 1,
      pedal: "half-bar",
      events: [
        L(0, BASS, 8, 0.82),
        L(8, BASS, 8, 0.74),
        R(0, CHORD, 4, 0.66),
        R(4, CHORD, 4, 0.5),
        R(8, CHORD, 4, 0.6),
        R(12, CHORD, 4, 0.5),
      ],
    },
    {
      id: "ballad-fingerpick",
      name: "Láy ngón (Alberti 16th)",
      kind: "fingerpick",
      description: "Tay phải láy 16th theo kiểu Alberti (thấp–cao–giữa–cao), tay trái giữ bass dài.",
      bars: 1,
      pedal: "half-bar",
      events: [
        L(0, BASS, 8, 0.78),
        L(8, FIFTH, 8, 0.55),
        ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((s) =>
          R(s, V([0, 2, 1, 2][s % 4]), 1, s % 4 === 0 ? 0.52 : 0.38),
        ),
      ],
    },
  ],
};

/* ----------------------------------- Pop ---------------------------------- */

const pop: MusicStyle = {
  id: "pop",
  name: "Pop",
  description: "Nhịp đều, sáng — phù hợp đa số bài pop/ V-pop tiết tấu vừa.",
  timeSignature: "4/4",
  defaultBpm: 96,
  patterns: [
    {
      id: "pop-8beat",
      name: "8-Beat",
      kind: "block",
      description: "Hợp âm móc đơn đều, nhấn phách mạnh, bass dậm phách 1 và 3.",
      bars: 1,
      pedal: "half-bar",
      events: [
        L(0, BASS, 6, 0.84),
        L(6, BASS, 2, 0.55),
        L(8, BASS, 6, 0.74),
        L(14, OCTAVE, 2, 0.5),
        ...[0, 2, 4, 6, 8, 10, 12, 14].map((s) => R(s, CHORD, 2, s % 4 === 0 ? 0.64 : 0.44)),
      ],
    },
    {
      id: "pop-16beat",
      name: "16-Beat Syncopated",
      kind: "block",
      description: "Tiết tấu 16th có đảo phách và móc sớm (anticipation) sang hợp âm kế tiếp.",
      bars: 1,
      pedal: "beat",
      events: [
        L(0, BASS, 3, 0.84),
        L(6, BASS, 2, 0.6),
        L(8, BASS, 3, 0.74),
        L(11, BASS, 3, 0.56),
        R(0, CHORD, 3, 0.66),
        R(3, CHORD, 3, 0.5),
        R(6, CHORD, 2, 0.56),
        R(8, CHORD, 2, 0.62),
        R(10, VS(1, 2), 1, 0.4),
        R(11, CHORD, 3, 0.55),
        R(14, CHORD, 4, 0.6, true),
      ],
    },
    {
      id: "pop-arpeggio",
      name: "Pop Arpeggio 16th",
      kind: "arpeggio",
      description: "Rải 16th lên–xuống qua các nốt tay phải, tay trái bass móc đơn chấm.",
      bars: 1,
      pedal: "half-bar",
      events: [
        L(0, BASS, 6, 0.8),
        L(6, BASS, 2, 0.55),
        L(8, OCTAVE, 6, 0.66),
        L(14, FIFTH, 2, 0.5),
        ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((s) =>
          R(s, V([0, 1, 2, 3, 2, 1, 0, 1][s % 8]), 1, s % 4 === 0 ? 0.56 : 0.4),
        ),
      ],
    },
  ],
};

/* ------------------------------- Valse (3/4) ------------------------------ */

const valse: MusicStyle = {
  id: "valse",
  name: "Valse 3/4",
  description: "Bùm – chát – chát. Nhịp 3/4 uyển chuyển, bass luân phiên nốt gốc / quãng 5.",
  timeSignature: "3/4",
  defaultBpm: 132,
  patterns: [
    {
      id: "valse-oompah",
      name: "Oom-pah-pah",
      kind: "block",
      description: "Phách 1 bass (luân phiên gốc/quãng 5 mỗi ô nhịp), phách 2–3 hợp âm ngắn.",
      bars: 2,
      pedal: "bar",
      events: [
        L(0, BASS, 4, 0.82),
        R(4, CHORD, 3, 0.52),
        R(8, CHORD, 3, 0.48),
        L(12, FIFTH, 4, 0.74),
        R(16, CHORD, 3, 0.52),
        R(20, CHORD, 3, 0.48),
      ],
    },
    {
      id: "valse-arpeggio",
      name: "Valse Arpeggio",
      kind: "arpeggio",
      description: "Rải móc đơn 1-5-8 rồi tay phải nối lên — kiểu valse trữ tình.",
      bars: 1,
      pedal: "bar",
      events: [
        L(0, BASS, 12, 0.8),
        L(2, FIFTH, 10, 0.5),
        L(4, OCTAVE, 8, 0.5),
        R(6, V(1), 6, 0.56),
        R(8, V(2), 4, 0.52),
        R(10, V(3), 2, 0.5),
      ],
    },
    {
      id: "valse-fingerpick",
      name: "Láy ngón Valse",
      kind: "fingerpick",
      description: "Bass dài ở phách 1, tay phải láy 16th xoay vòng qua các nốt hợp âm ở phách 2–3.",
      bars: 1,
      pedal: "bar",
      events: [
        L(0, BASS, 12, 0.8),
        R(0, V(-1), 4, 0.5),
        ...[4, 5, 6, 7, 8, 9, 10, 11].map((s) => R(s, V([0, 2, 1, 2][s % 4]), 1, s % 4 === 0 ? 0.5 : 0.36)),
      ],
    },
  ],
};

/* -------------------------------- Bossa Nova ------------------------------ */

const bossa: MusicStyle = {
  id: "bossa",
  name: "Bossa Nova",
  description: "Bass 1–5 chấm dôi kiểu Brazil, hợp âm theo clave bossa 2 ô nhịp.",
  timeSignature: "4/4",
  defaultBpm: 128,
  patterns: [
    {
      id: "bossa-classic",
      name: "Bossa Clave Comping",
      kind: "block",
      description: "Tay phải theo clave bossa (0-6-12 | 20-26), bass: gốc. gốc | quãng5. quãng5.",
      bars: 2,
      pedal: "none",
      events: [
        // Left hand: the classic dotted-quarter / eighth bossa bass (per bar)
        L(0, BASS, 6, 0.82),
        L(6, BASS, 2, 0.5),
        L(8, FIFTH, 6, 0.7),
        L(14, FIFTH, 2, 0.48),
        L(16, BASS, 6, 0.8),
        L(22, BASS, 2, 0.5),
        L(24, FIFTH, 6, 0.7),
        L(30, FIFTH, 2, 0.48),
        // Right hand: bossa clave, short & light
        R(0, CHORD, 3, 0.56),
        R(6, CHORD, 3, 0.5),
        R(12, CHORD, 3, 0.54),
        R(20, CHORD, 3, 0.5),
        R(26, CHORD, 3, 0.54),
      ],
    },
    {
      id: "bossa-anticipated",
      name: "Bossa with Pushes",
      kind: "block",
      description: "Biến thể có móc sớm: hợp âm của ô nhịp sau vào trước nửa phách.",
      bars: 2,
      pedal: "none",
      events: [
        L(0, BASS, 6, 0.82),
        L(6, BASS, 2, 0.5),
        L(8, FIFTH, 6, 0.7),
        L(14, FIFTH, 2, 0.48),
        L(16, BASS, 6, 0.8),
        L(22, BASS, 2, 0.5),
        L(24, FIFTH, 6, 0.7),
        L(30, FIFTH, 2, 0.48),
        R(0, CHORD, 2, 0.56),
        R(4, CHORD, 2, 0.46),
        R(10, CHORD, 4, 0.52),
        R(14, CHORD, 4, 0.56, true),
        R(20, CHORD, 2, 0.48),
        R(24, CHORD, 2, 0.5),
        R(30, CHORD, 4, 0.56, true),
      ],
    },
    {
      id: "bossa-arpeggio",
      name: "Bossa Guitar-style",
      kind: "fingerpick",
      description: "Mô phỏng tiếng guitar bossa: bass ngón cái + các nốt trên bật cùng clave.",
      bars: 2,
      pedal: "none",
      events: [
        L(0, BASS, 6, 0.8),
        L(8, FIFTH, 6, 0.68),
        L(16, BASS, 6, 0.78),
        L(24, FIFTH, 6, 0.68),
        R(2, VS(1, 2, 3), 2, 0.48),
        R(6, VS(0, 1, 2), 2, 0.52),
        R(10, VS(1, 2, 3), 2, 0.46),
        R(12, VS(0, 1, 2), 2, 0.52),
        R(18, VS(1, 2, 3), 2, 0.48),
        R(20, VS(0, 1, 2), 2, 0.52),
        R(26, VS(0, 1, 2), 2, 0.52),
        R(28, VS(1, 2, 3), 2, 0.44),
      ],
    },
  ],
};

/* --------------------------------- Bolero --------------------------------- */

/**
 * Vietnamese bolero ("nhạc vàng"): slow 4/4 built on the Latin bolero cell
 * "ta – ti ti – ta – ta" (steps 0 · 4 6 · 8 · 12). The bass owns beats 1 and 3
 * (root → 5th), the right hand answers on 2, 2& and 4, and a 16th-note pickup on
 * beat 4 ("láy") leads into the next bar — the signature bolero lilt.
 */
const bolero: MusicStyle = {
  id: "bolero",
  name: "Bolero",
  description: "Bùm – chát chát – bùm – chát. Nhịp 4/4 chậm, bass gốc/quãng 5 và câu láy dẫn cuối ô nhịp.",
  timeSignature: "4/4",
  defaultBpm: 70,
  patterns: [
    {
      id: "bolero-block",
      name: "Bolero cơ bản",
      kind: "block",
      description: "Bass phách 1 (gốc) và phách 3 (quãng 5), tay phải chặn hợp âm ở phách 2, 2& và 4 — tiết tấu bolero kinh điển.",
      bars: 1,
      pedal: "half-bar",
      events: [
        L(0, BASS, 4, 0.84),
        L(8, FIFTH, 4, 0.74),
        L(14, BASS, 2, 0.5),
        R(4, CHORD, 2, 0.6),
        R(6, CHORD, 2, 0.5),
        R(12, CHORD, 2, 0.58),
      ],
    },
    {
      id: "bolero-arpeggio",
      name: "Bolero rải",
      kind: "arpeggio",
      description: "Tay trái giữ gốc – quãng 5, tay phải rải móc đơn theo phách bolero; dùng cho đoạn intro và phiên khúc.",
      bars: 1,
      pedal: "half-bar",
      events: [
        L(0, BASS, 8, 0.8),
        L(8, FIFTH, 8, 0.7),
        R(2, V(0), 2, 0.46),
        R(4, V(1), 2, 0.58),
        R(6, V(2), 2, 0.52),
        R(10, V(1), 2, 0.46),
        R(12, V(2), 2, 0.56),
        R(14, V(3), 2, 0.5),
      ],
    },
    {
      id: "bolero-fill",
      name: "Bolero láy ngón",
      kind: "fingerpick",
      description: "Tiết tấu bolero có câu láy 16th đi xuống ở phách 4 dẫn vào hợp âm kế tiếp, bass chạy lên ở cuối ô nhịp.",
      bars: 1,
      pedal: "half-bar",
      events: [
        L(0, BASS, 4, 0.84),
        L(8, FIFTH, 4, 0.72),
        L(12, OCTAVE, 2, 0.5),
        L(14, FIFTH, 2, 0.48),
        R(4, CHORD, 2, 0.58),
        R(6, CHORD, 2, 0.5),
        R(12, V(3), 1, 0.52),
        R(13, V(2), 1, 0.42),
        R(14, V(1), 1, 0.46),
        R(15, V(0), 1, 0.4),
      ],
    },
  ],
};

/* ---------------------------------- Blues --------------------------------- */

/**
 * Blues: shuffle / boogie on a swung 16th grid, plus 12/8 slow blues on a triplet grid.
 * Written for dominant-7th changes (C7 – F7 – G7), but the boogie line adapts its 3rd
 * to minor chords so a minor blues (Am7 – Dm7 – E7) works too.
 */
const EIGHTHS = [0, 2, 4, 6, 8, 10, 12, 14];
const BOOGIE_LINE = [0, 4, 7, 9, 10, 9, 7, 4]; // 1-3-5-6-♭7-6-5-3

const blues: MusicStyle = {
  id: "blues",
  name: "Blues",
  description: "Shuffle & Boogie 4/4 (swing) và Slow Blues 12/8 — hợp với vòng 12 ô nhịp C7 – F7 – G7.",
  timeSignature: "4/4",
  defaultBpm: 104,
  patterns: [
    {
      id: "blues-shuffle",
      name: "Shuffle 5–6",
      kind: "block",
      description: "Tay trái chơi quãng 1–5 rồi 1–6 luân phiên mỗi phách (móc đơn swing) — nền shuffle kinh điển. Tay phải dậm ngắn phách 2 và 4.",
      bars: 1,
      pedal: "none",
      swing: 1,
      events: [
        ...EIGHTHS.flatMap((s) => {
          const top = Math.floor(s / 4) % 2 === 0 ? 7 : 9;
          const vel = s % 4 === 0 ? 0.74 : 0.56;
          return [L(s, BI(0), 2, vel), L(s, BI(top), 2, vel * 0.9)];
        }),
        R(4, CHORD, 2, 0.58),
        R(10, VS(1, 2), 1, 0.36),
        R(12, CHORD, 2, 0.58),
      ],
    },
    {
      id: "blues-boogie",
      name: "Boogie-Woogie",
      kind: "fingerpick",
      description: "Bass đi 1–3–5–6–♭7–6–5–3 theo móc đơn swing, tay phải bật hợp âm ở phách lẻ — sôi động kiểu boogie.",
      bars: 1,
      pedal: "none",
      swing: 1,
      events: [
        ...EIGHTHS.map((s, i) => L(s, BI(BOOGIE_LINE[i]), 2, s % 4 === 0 ? 0.8 : 0.6)),
        R(2, CHORD, 1, 0.5),
        R(6, CHORD, 2, 0.6),
        R(10, CHORD, 1, 0.48),
        R(14, CHORD, 2, 0.58),
      ],
    },
    {
      id: "blues-slow-triplets",
      name: "Slow Blues 12/8 (chùm ba)",
      kind: "block",
      description: "Nhịp 12/8 chậm: tay phải dậm hợp âm theo chùm ba liên tục, tay trái đi 1–5–6–5 mỗi phách.",
      bars: 1,
      pedal: "beat",
      timeSignature: "12/8",
      defaultBpm: 56,
      events: [
        L(0, BI(0), 3, 0.8),
        L(3, BI(7), 3, 0.62),
        L(6, BI(9), 3, 0.68),
        L(9, BI(7), 3, 0.6),
        ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((s) => R(s, CHORD, 1, s % 3 === 0 ? 0.58 : 0.36)),
      ],
    },
    {
      id: "blues-slow-arpeggio",
      name: "Slow Blues 12/8 (rải)",
      kind: "arpeggio",
      description: "Tay phải rải chùm ba đi lên rồi vòng xuống, tay trái giữ nốt gốc và quãng 8 — ballad blues sâu lắng.",
      bars: 1,
      pedal: "half-bar",
      timeSignature: "12/8",
      defaultBpm: 56,
      events: [
        L(0, BASS, 6, 0.78),
        L(6, OCTAVE, 6, 0.6),
        ...[0, 1, 2, 1, 2, 3, 2, 3, 4, 3, 2, 1].map((voice, s) => R(s, V(voice), 1, s % 3 === 0 ? 0.52 : 0.38)),
      ],
    },
  ],
};

export const STYLES: MusicStyle[] = [ballad, pop, bolero, blues, valse, bossa];

export function getStyle(id: string): MusicStyle {
  return STYLES.find((s) => s.id === id) ?? STYLES[0];
}

export function getPattern(styleId: string, patternId: string): StylePattern {
  const style = getStyle(styleId);
  return style.patterns.find((p) => p.id === patternId) ?? style.patterns[0];
}

/* ------------------------------ Preset progressions ------------------------------ */

export interface ProgressionPreset {
  id: string;
  name: string;
  /** Bar notation: "|" separates bars, two chords inside one bar = half a bar each. */
  text: string;
}

export const PROGRESSION_PRESETS: ProgressionPreset[] = [
  { id: "pop-g", name: "Pop kinh điển (G)", text: "G | D/F# | Em | C" },
  { id: "canon", name: "Canon in D", text: "D | A/C# | Bm | F#m/A | G | D/F# | G | A" },
  { id: "canon-half", name: "Canon in D (2 hợp âm/ô)", text: "D A/C# | Bm F#m/A | G D/F# | G A" },
  { id: "ballad-half", name: "Ballad bass đi xuống (2 hợp âm/ô)", text: "C G/B | Am Am/G | F C/E | Dm7 G7" },
  { id: "blues-12", name: "Blues 12 ô nhịp (C)", text: "C7 | F7 | C7 | C7 | F7 | F7 | C7 | C7 | G7 | F7 | C7 | G7" },
  { id: "blues-minor", name: "Minor Blues (Am)", text: "Am7 | Dm7 | Am7 | Am7 | Dm7 | Dm7 | Am7 | Am7 | F7 | E7 | Am7 | E7" },
  { id: "blues-jazz", name: "Jazz Blues (C)", text: "C7 | F7 | C7 | Gm7 C7 | F7 | F#dim7 | C7 | A7 | Dm7 | G7 | C7 A7 | Dm7 G7" },
  { id: "bolero", name: "Bolero (Am)", text: "Am | Dm | G | C | F | Dm | E7 | Am" },
  { id: "vn-ballad", name: "Ballad Việt (Am)", text: "Am | F | C | G | Am | Dm | E7 | Am" },
  { id: "jazz-251", name: "Jazz ii–V–I (C)", text: "Dm9 | G13 | Cmaj7 | Am7" },
  { id: "valse", name: "Valse (C)", text: "C | Am | Dm7 | G7" },
  { id: "bossa", name: "Bossa (Dm)", text: "Dm9 | G13 | Cmaj7 | A7" },
  { id: "descending", name: "Bass đi xuống", text: "C | G/B | Am | Am/G | F | C/E | Dm7 | G7sus4" },
];
