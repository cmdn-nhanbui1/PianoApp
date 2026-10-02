"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import { audioEngine } from "@/hooks/useAudioEngine";
import { keyBus, type KeySource } from "@/lib/key-bus";
import { isBlackKey, KEYBOARD_SIZES, midiToNoteName } from "@/lib/music-theory";
import { useKeyCount } from "@/store/useMusicStore";

/* -------------------------------------------------------------------------- */
/*                                   Layout                                   */
/* -------------------------------------------------------------------------- */

interface KeySpec {
  midi: number;
  black: boolean;
  /** Percent-based geometry so the keyboard scales fluidly. */
  left: number;
  width: number;
}

/** Real pianos offset black keys slightly away from the group centre. */
const BLACK_NUDGE: Record<number, number> = { 1: -0.12, 3: 0.12, 6: -0.16, 8: 0, 10: 0.16 };
const BLACK_WIDTH_RATIO = 0.6;

function buildLayout(low: number, high: number): { keys: KeySpec[]; whiteCount: number } {
  const whites: number[] = [];
  for (let m = low; m <= high; m++) if (!isBlackKey(m)) whites.push(m);
  const whiteW = 100 / whites.length;
  const blackW = whiteW * BLACK_WIDTH_RATIO;
  const keys: KeySpec[] = [];
  let whiteIndex = -1;
  for (let m = low; m <= high; m++) {
    if (!isBlackKey(m)) {
      whiteIndex++;
      keys.push({ midi: m, black: false, left: whiteIndex * whiteW, width: whiteW });
    } else {
      const nudge = BLACK_NUDGE[m % 12] * blackW;
      keys.push({ midi: m, black: true, left: (whiteIndex + 1) * whiteW - blackW / 2 + nudge, width: blackW });
    }
  }
  return { keys, whiteCount: whites.length };
}

/** Minimum white-key width before the keyboard scrolls horizontally. */
const MIN_WHITE_KEY_PX = 27;
const SOURCE_ATTR: Record<KeySource, string> = { left: "data-lh", right: "data-rh", user: "data-user" };

/* -------------------------------------------------------------------------- */
/*                                  Key cell                                  */
/* -------------------------------------------------------------------------- */

/**
 * A single key. Memoised with static props → it renders exactly once. Highlighting
 * happens by toggling data-attributes on the DOM node (see the keyBus effect below),
 * so sequencer playback causes zero React renders on the keyboard.
 */
const PianoKey = memo(function PianoKey({ spec }: { spec: KeySpec }) {
  const label = spec.midi % 12 === 0 ? midiToNoteName(spec.midi) : null;
  return (
    <div
      data-midi={spec.midi}
      role="button"
      aria-label={midiToNoteName(spec.midi)}
      className={
        spec.black
          ? "pk-black absolute top-0 z-20 flex h-[62%] cursor-pointer flex-col items-center justify-end overflow-hidden pb-1.5"
          : "pk-white absolute top-0 z-10 flex h-full cursor-pointer flex-col items-center justify-end overflow-hidden pb-2"
      }
      style={{ left: `${spec.left}%`, width: `${spec.width}%` }}
    >
      <span className="pk-finger mb-1 flex size-4 items-center justify-center rounded-full text-[10px] font-bold text-white shadow sm:size-5 sm:text-[11px]" />
      {label && <span className="pointer-events-none font-mono text-[9px] font-semibold text-neutral-500 sm:text-[10px]">{label}</span>}
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/*                                  Keyboard                                  */
/* -------------------------------------------------------------------------- */

interface KeyboardProps {
  /** Octave the QWERTY keys are mapped to — shown as a thin marker above the keys. */
  qwertyOctave?: number;
}

function KeyboardImpl({ qwertyOctave }: KeyboardProps) {
  const keysRef = useRef<HTMLDivElement>(null);
  const rainRef = useRef<HTMLDivElement>(null);
  const keyCount = useKeyCount();
  const { low, high } = KEYBOARD_SIZES[keyCount];
  const layout = useMemo(() => buildLayout(low, high), [low, high]);

  /* --------- imperative highlighting: subscribe to the key bus once --------- */
  useEffect(() => {
    const container = keysRef.current!;
    const rain = rainRef.current!;
    const els = new Map<number, HTMLElement>();
    container.querySelectorAll<HTMLElement>("[data-midi]").forEach((el) => els.set(Number(el.dataset.midi), el));

    // Reference counts per source: overlapping notes on the same key (e.g. pedal + re-strike)
    // must not switch the highlight off early.
    const counts = new Map<number, Record<KeySource, number>>();
    let guided: number[] = [];

    const spawnEffects = (el: HTMLElement, source: KeySource, velocity: number) => {
      const ripple = document.createElement("span");
      ripple.className = "pk-ripple";
      ripple.style.opacity = String(0.4 + velocity * 0.6);
      ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
      el.appendChild(ripple);

      const spark = document.createElement("span");
      spark.className = "pk-spark";
      spark.dataset.source = source;
      const w = el.offsetWidth * 0.55;
      spark.style.width = `${w}px`;
      spark.style.height = `${24 + velocity * 46}px`;
      spark.style.left = `${el.offsetLeft + (el.offsetWidth - w) / 2}px`;
      spark.addEventListener("animationend", () => spark.remove(), { once: true });
      rain.appendChild(spark);
    };

    const setAttr = (midi: number, source: KeySource, on: boolean) => {
      const el = els.get(midi);
      if (!el) return;
      if (on) el.setAttribute(SOURCE_ATTR[source], "");
      else el.removeAttribute(SOURCE_ATTR[source]);
    };

    const unsubscribe = keyBus.subscribe((e) => {
      switch (e.type) {
        case "on": {
          const c = counts.get(e.midi) ?? { left: 0, right: 0, user: 0 };
          c[e.source]++;
          counts.set(e.midi, c);
          setAttr(e.midi, e.source, true);
          const el = els.get(e.midi);
          if (el) spawnEffects(el, e.source, e.velocity);
          break;
        }
        case "off": {
          const c = counts.get(e.midi);
          if (!c) return;
          c[e.source] = Math.max(0, c[e.source] - 1);
          if (c[e.source] === 0) setAttr(e.midi, e.source, false);
          break;
        }
        case "guide": {
          for (const m of guided) {
            const el = els.get(m);
            if (!el) continue;
            el.removeAttribute("data-guide");
            (el.firstElementChild as HTMLElement).textContent = "";
          }
          guided = [];
          const mark = (m: number, lane: "left" | "right") => {
            const el = els.get(m);
            if (!el) return;
            el.setAttribute("data-guide", lane);
            (el.firstElementChild as HTMLElement).textContent = String(e.fingers[m] ?? "");
            guided.push(m);
          };
          e.left.forEach((m) => mark(m, "left"));
          e.right.forEach((m) => mark(m, "right"));
          break;
        }
        case "clear": {
          counts.forEach((c, midi) => {
            c.left = 0;
            c.right = 0;
            setAttr(midi, "left", false);
            setAttr(midi, "right", false);
          });
          break;
        }
      }
    });
    return () => {
      unsubscribe();
      // Keys are reused across layout changes; drop highlights whose counts are about to be lost.
      els.forEach((el) => {
        el.removeAttribute("data-lh");
        el.removeAttribute("data-rh");
        el.removeAttribute("data-user");
      });
    };
  }, [layout]);

  /* ------------------ mouse / touch: play keys, glissando ------------------ */
  useEffect(() => {
    const container = keysRef.current!;
    const active = new Map<number, number>(); // pointerId → midi

    const keyAt = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-midi]");
      return el && container.contains(el) ? el : null;
    };
    const velocityFor = (el: HTMLElement, y: number) => {
      // Striking nearer the front edge of a key plays louder.
      const r = el.getBoundingClientRect();
      return 0.45 + 0.55 * Math.min(1, Math.max(0, (y - r.top) / r.height));
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const el = keyAt(e.clientX, e.clientY);
      if (!el) return;
      const midi = Number(el.dataset.midi);
      active.set(e.pointerId, midi);
      audioEngine.liveNoteOn(midi, velocityFor(el, e.clientY));
    };
    const onMove = (e: PointerEvent) => {
      const current = active.get(e.pointerId);
      if (current === undefined) return;
      const el = keyAt(e.clientX, e.clientY);
      const midi = el ? Number(el.dataset.midi) : null;
      if (midi === current) return;
      audioEngine.liveNoteOff(current);
      if (el && midi !== null) {
        active.set(e.pointerId, midi);
        audioEngine.liveNoteOn(midi, velocityFor(el, e.clientY));
      } else {
        active.delete(e.pointerId);
      }
    };
    const onUp = (e: PointerEvent) => {
      const midi = active.get(e.pointerId);
      if (midi === undefined) return;
      active.delete(e.pointerId);
      audioEngine.liveNoteOff(midi);
    };

    container.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp); // e.g. a horizontal swipe turns into a scroll on mobile
    return () => {
      container.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      active.forEach((m) => audioEngine.liveNoteOff(m));
    };
  }, []);

  const qwertyMarker = useMemo(() => {
    if (qwertyOctave === undefined) return null;
    const start = (qwertyOctave + 1) * 12;
    const end = start + 16;
    const first = layout.keys.find((k) => k.midi === Math.max(start, low));
    const last = layout.keys.find((k) => k.midi === Math.min(end, high));
    if (!first || !last) return null;
    return { left: first.left, width: last.left + last.width - first.left };
  }, [qwertyOctave, layout, low, high]);

  return (
    <div className="scroll-thin overflow-x-auto overflow-y-hidden rounded-xl" style={{ touchAction: "pan-x" }}>
      <div className="relative select-none px-1 pb-1" style={{ minWidth: layout.whiteCount * MIN_WHITE_KEY_PX }}>
        {/* note-rain lane */}
        <div ref={rainRef} className="relative h-20 overflow-hidden" aria-hidden>
          <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
          {qwertyMarker && (
            <div
              className="absolute bottom-1 h-1 rounded-full bg-user/60 transition-all duration-300"
              style={{ left: `${qwertyMarker.left}%`, width: `${qwertyMarker.width}%` }}
              title="Vùng phím máy tính (A → ;)"
            />
          )}
        </div>
        {/* felt strip */}
        <div className="h-2 rounded-t-sm bg-gradient-to-b from-rose-950 to-rose-900/70 shadow-inner" />
        <div ref={keysRef} className="relative h-40 sm:h-48 lg:h-56">
          {layout.keys.map((spec) => (
            <PianoKey key={spec.midi} spec={spec} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** The whole keyboard is memoised: it only re-renders when the QWERTY octave marker moves or the key count changes. */
export const Keyboard = memo(KeyboardImpl);
