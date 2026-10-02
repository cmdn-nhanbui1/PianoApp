"use client";

import { useEffect, useMemo } from "react";
import { ArrowRight, Hand, Keyboard as KeyboardIcon, Lightbulb } from "lucide-react";
import { keyBus } from "@/lib/key-bus";
import { buildHandGuide, chordToneName, pcToSolfege, spellChord, type Chord, type HandGuide } from "@/lib/music-theory";
import { arrangementPrefersFlats, getArrangement } from "@/lib/sequencer";
import { cn } from "@/lib/utils";
import { useMusicStore } from "@/store/useMusicStore";

function NoteChips({ notes, fingers, lane, chord, flats }: { notes: number[]; fingers: number[]; lane: "left" | "right"; chord: Chord; flats: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {notes.map((n, i) => (
        <div
          key={n}
          className={cn(
            "flex items-center gap-1.5 rounded-md border py-1 pr-2 pl-1 font-mono text-sm",
            lane === "left" ? "border-lh/40 bg-lh/10" : "border-rh/40 bg-rh/10",
          )}
        >
          <span
            className={cn(
              "flex size-5 items-center justify-center rounded-full text-[11px] font-bold text-white",
              lane === "left" ? "bg-lh-2" : "bg-rh-2",
            )}
            title={`Ngón ${fingers[i]}`}
          >
            {fingers[i]}
          </span>
          {chordToneName(n, chord, flats)}
        </div>
      ))}
    </div>
  );
}

export function GuidePanel({ qwertyOctave }: { qwertyOctave: number }) {
  const progression = useMusicStore((s) => s.progression);
  const slot = useMusicStore((s) => s.currentSlot);
  const symbols = useMemo(() => progression.map((s) => s.symbol), [progression]);
  const voicings = useMemo(() => getArrangement(symbols), [symbols]);
  const flats = arrangementPrefersFlats(symbols);

  const index = voicings.length ? Math.min(slot, voicings.length - 1) : -1;
  const current = index >= 0 ? voicings[index] : undefined;
  const next = voicings.length > 1 ? voicings[(index + 1) % voicings.length] : undefined;
  const guide: HandGuide | null = useMemo(() => (current ? buildHandGuide(current, next, flats) : null), [current, next, flats]);

  // Push target notes + finger numbers onto the keyboard (imperatively, no keyboard re-render).
  useEffect(() => {
    if (!guide) {
      keyBus.guide([], [], {});
      return;
    }
    const fingers: Record<number, number> = {};
    guide.leftNotes.forEach((m, i) => (fingers[m] = guide.leftFingers[i]));
    guide.rightNotes.forEach((m, i) => (fingers[m] = guide.rightFingers[i]));
    keyBus.guide(guide.leftNotes, guide.rightNotes, fingers);
  }, [guide]);

  if (!current || !guide) {
    return (
      <section className="panel p-4 text-sm text-muted-foreground">Thêm hợp âm để xem hướng dẫn đặt tay và ngón bấm.</section>
    );
  }

  return (
    <section className="panel grid gap-4 p-4 lg:grid-cols-[220px_minmax(0,1fr)_minmax(0,1.2fr)]" aria-label="Hướng dẫn">
      {/* Chord identity */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">Hợp âm hiện tại</span>
        <div className="flex items-end gap-3">
          <span className="text-5xl leading-none font-bold tracking-tight text-primary">{current.chord.symbol}</span>
          {next && next !== current && (
            <span className="mb-1 flex items-center gap-1 text-sm text-muted-foreground">
              <ArrowRight className="size-3.5" /> {next.chord.symbol}
            </span>
          )}
        </div>
        <span className="text-sm">{current.chord.formula.label}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {spellChord(current.chord, flats)}
          {current.chord.isSlash && ` / bass ${current.chord.bassName}`}
        </span>
        <span className="text-xs text-muted-foreground">
          {pcToSolfege(current.chord.root)} · {guide.inversionName}
        </span>
      </div>

      {/* Hands */}
      <div className="flex flex-col gap-3">
        <span className="flex items-center gap-1.5 text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          <Hand className="size-3.5" /> Đặt tay & ngón
        </span>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-rh">Tay phải — Voicing</span>
          <NoteChips notes={guide.rightNotes} fingers={guide.rightFingers} lane="right" chord={current.chord} flats={flats} />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-lh">Tay trái — Bass</span>
          <NoteChips notes={guide.leftNotes} fingers={guide.leftFingers} lane="left" chord={current.chord} flats={flats} />
        </div>
      </div>

      {/* Tips */}
      <div className="flex flex-col gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold tracking-widest text-muted-foreground uppercase">
          <Lightbulb className="size-3.5" /> Từng bước
        </span>
        <ol className="flex flex-col gap-1.5 text-sm">
          {guide.tips.map((tip, i) => (
            <li key={i} className="flex gap-2">
              <span className="mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-[10px]">{i + 1}</span>
              <span className="text-foreground/90">{tip}</span>
            </li>
          ))}
        </ol>
        <p className="mt-auto flex items-start gap-1.5 border-t border-border pt-2 text-[11px] text-muted-foreground">
          <KeyboardIcon className="mt-px size-3.5 shrink-0" />
          <span>
            Chơi bằng phím máy tính: <kbd className="font-mono">A W S E D F T G Y H U J K</kbd> (quãng C{qwertyOctave}), <kbd className="font-mono">Z</kbd>/
            <kbd className="font-mono">X</kbd> đổi quãng, <kbd className="font-mono">Shift</kbd> đánh mạnh, <kbd className="font-mono">Space</kbd> Play/Pause.
          </span>
        </p>
      </div>
    </section>
  );
}
