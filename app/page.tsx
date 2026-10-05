"use client";

import { useEffect } from "react";
import { ChordDisplay } from "@/components/ChordDisplay";
import { ControlPanel } from "@/components/ControlPanel";
import { GuidePanel } from "@/components/GuidePanel";
import { Keyboard } from "@/components/Keyboard";
import { ProgressionBuilder } from "@/components/ProgressionBuilder";
import { RecordingResult } from "@/components/RecordingResult";
import { useAudioEngine } from "@/hooks/useAudioEngine";
import { useComputerKeyboard } from "@/hooks/useComputerKeyboard";
import { KEYBOARD_SIZES, midiToNoteName } from "@/lib/music-theory";
import { useKeyCount, useMusicStore } from "@/store/useMusicStore";

export default function StudioPage() {
  useAudioEngine();
  const { octave } = useComputerKeyboard();
  const keyCount = useKeyCount();
  const { low, high } = KEYBOARD_SIZES[keyCount];

  // Restore the saved session after mount (the store skips hydration to keep SSR markup stable).
  useEffect(() => {
    void useMusicStore.persist.rehydrate();
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-[1440px] flex-col gap-3 px-4 py-4 sm:gap-4 sm:px-6">
      {/* 1 — Top control bar */}
      <ControlPanel />
      <RecordingResult />

      {/* 2 — Style & progression */}
      <ProgressionBuilder />

      {/* 3 — Visualizer & guide */}
      <section className="panel p-3 sm:p-4" aria-label={`Bàn phím ${keyCount} phím`}>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2 px-1">
          <h2 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">{keyCount} phím · {midiToNoteName(low)} – {midiToNoteName(high)}</h2>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <Legend className="from-lh to-lh-2" label="Tay trái" />
            <Legend className="from-rh to-rh-2" label="Tay phải" />
            <Legend className="from-user to-user" label="Bạn đang chơi" />
          </div>
        </div>
        <div className="relative">
          <Keyboard qwertyOctave={octave} />
          <ChordDisplay />
        </div>
      </section>
      <GuidePanel qwertyOctave={octave} />
    </main>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2.5 w-4 rounded-sm bg-gradient-to-b ${className}`} />
      {label}
    </span>
  );
}
