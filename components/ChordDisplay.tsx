"use client";

import { useEffect, useState } from "react";
import { keyBus } from "@/lib/key-bus";
import { detectChord, INVERSION_NAMES, spellChord, type DetectedChord } from "@/lib/music-theory";
import { cn } from "@/lib/utils";

/** How long the last chord stays on screen after every key is released. */
const HIDE_AFTER_IDLE_MS = 10_000;

/**
 * Names the chord the player is holding (MIDI, mouse or QWERTY — every "user" key).
 * The last recognised chord stays on screen, dimmed, after the keys are released.
 */
export function ChordDisplay() {
  const [detected, setDetected] = useState<DetectedChord | null>(null);
  const [holding, setHolding] = useState(false);

  useEffect(() => {
    // Reference-counted: the same key can arrive from two inputs (e.g. MIDI + mouse).
    const held = new Map<number, number>();
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = keyBus.subscribe((e) => {
      if ((e.type !== "on" && e.type !== "off") || e.source !== "user") return;
      const n = (held.get(e.midi) ?? 0) + (e.type === "on" ? 1 : -1);
      if (n > 0) held.set(e.midi, n);
      else held.delete(e.midi);

      const chord = detectChord(held.keys());
      if (chord) setDetected(chord);
      setHolding(chord !== null);

      // Hide the chord once nothing has been played for a while (keys still held keep it visible).
      clearTimeout(hideTimer);
      if (held.size === 0) hideTimer = setTimeout(() => setDetected(null), HIDE_AFTER_IDLE_MS);
    });
    return () => {
      unsubscribe();
      clearTimeout(hideTimer);
    };
  }, []);

  if (!detected) return null;
  const { chord, symbol, inversion } = detected;
  return (
    <div
      aria-live="polite"
      className={cn(
        "pointer-events-none absolute top-2 left-1/2 z-30 flex -translate-x-1/2 items-baseline gap-3 rounded-lg border border-border bg-background/80 px-4 py-1.5 shadow-lg backdrop-blur transition-opacity duration-300",
        holding ? "opacity-100" : "opacity-45",
      )}
    >
      <span className={cn("font-mono text-2xl font-bold tracking-tight", holding ? "text-user" : "text-foreground")}>{symbol}</span>
      <span className="flex flex-col text-[11px] leading-tight text-muted-foreground">
        <span>
          {chord.formula.label}
          {inversion !== null && ` · ${INVERSION_NAMES[inversion]}`}
        </span>
        <span className="font-mono">{spellChord(chord)}</span>
      </span>
    </div>
  );
}
