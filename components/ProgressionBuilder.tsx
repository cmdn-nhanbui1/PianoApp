"use client";

import { memo, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, ListMusic, Pencil, Plus, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { audioEngine } from "@/hooks/useAudioEngine";
import { INVERSION_NAMES, chordToneName, isValidChord, type Voicing } from "@/lib/music-theory";
import { arrangementPrefersFlats, getArrangement, getTimeline, parseProgressionText, patternGrid, slotSteps, type SlotLength } from "@/lib/sequencer";
import { PATTERN_KIND_LABEL, PROGRESSION_PRESETS, STYLES, getStyle, patternTimeSignature, stepsPerBar, stepsPerBeat, styleTimeSignatures } from "@/lib/styles";
import { cn } from "@/lib/utils";
import { useMusicStore, type ChordSlot } from "@/store/useMusicStore";

/* ========================================================================== */
/*                          Row 1 — Style & pattern                           */
/* ========================================================================== */

function StyleSelector() {
  const styleId = useMusicStore((s) => s.styleId);
  const setStyle = useMusicStore((s) => s.setStyle);
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {STYLES.map((style) => (
        <button
          key={style.id}
          onClick={() => setStyle(style.id)}
          aria-pressed={style.id === styleId}
          className={cn(
            "group rounded-lg border px-3 py-2 text-left transition-all",
            style.id === styleId
              ? "border-primary/70 bg-primary/10 shadow-[0_0_20px_-10px_var(--primary)]"
              : "border-border bg-background/30 hover:border-muted-foreground/40",
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <span className={cn("text-sm font-semibold", style.id === styleId && "text-primary")}>{style.name}</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {styleTimeSignatures(style).join(" + ")} · {style.defaultBpm}
            </span>
          </div>
          <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{style.description}</p>
        </button>
      ))}
    </div>
  );
}

function PatternSelector() {
  const styleId = useMusicStore((s) => s.styleId);
  const patternId = useMusicStore((s) => s.patternId);
  const setPattern = useMusicStore((s) => s.setPattern);
  const style = getStyle(styleId);
  const current = style.patterns.find((p) => p.id === patternId) ?? style.patterns[0];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {style.patterns.map((p) => (
          <button
            key={p.id}
            onClick={() => setPattern(p.id)}
            aria-pressed={p.id === current.id}
            className={cn(
              "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors",
              p.id === current.id ? "border-rh/60 bg-rh/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            <span className={cn("rounded px-1.5 py-px text-[10px] font-semibold", p.id === current.id ? "bg-rh/25 text-rh" : "bg-muted")}>
              {PATTERN_KIND_LABEL[p.kind]}
            </span>
            {p.name}
            {patternTimeSignature(style, p) !== style.timeSignature && (
              <span className="font-mono text-[10px] text-muted-foreground">{patternTimeSignature(style, p)}</span>
            )}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{current.description}</p>
    </div>
  );
}

/** Two-lane step grid (LH / RH) with a live playhead — like a drum-machine view of the pattern. */
const PatternGrid = memo(function PatternGrid() {
  const styleId = useMusicStore((s) => s.styleId);
  const patternId = useMusicStore((s) => s.patternId);
  const step = useMusicStore((s) => s.currentStep);
  const grid = useMemo(() => patternGrid(styleId, patternId), [styleId, patternId]);

  const lane = (label: string, hits: number[], holds: boolean[], color: "lh" | "rh") => (
    <div className="flex items-center gap-2">
      <span className={cn("w-7 shrink-0 text-[10px] font-semibold", color === "lh" ? "text-lh" : "text-rh")}>{label}</span>
      <div className="grid flex-1 gap-[3px]" style={{ gridTemplateColumns: `repeat(${grid.length}, minmax(0, 1fr))` }}>
        {hits.map((v, i) => (
          <div
            key={i}
            className={cn(
              "h-4 rounded-[3px] transition-[outline-color]",
              i % grid.barSteps === 0 && i > 0 && "ml-1",
              v > 0 ? (color === "lh" ? "bg-gradient-to-b from-lh to-lh-2" : "bg-gradient-to-b from-rh to-rh-2") : holds[i] ? (color === "lh" ? "bg-lh/15" : "bg-rh/15") : i % grid.beatSteps === 0 ? "bg-muted" : "bg-muted/50",
              i === step ? "outline-2 outline-offset-1 outline-foreground/90" : "outline-transparent",
            )}
            style={v > 0 ? { opacity: 0.35 + v * 0.65 } : undefined}
          />
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-background/40 p-2.5" aria-label="Lưới pattern">
      {lane("RH", grid.right, grid.rightHold, "rh")}
      {lane("LH", grid.left, grid.leftHold, "lh")}
      <div className="flex items-center justify-between pl-9 font-mono text-[9px] text-muted-foreground">
        <span>
          {grid.length} steps · {grid.beatSteps === 3 ? "triplet grid" : "16th grid"}
          {grid.swing > 0 && <span className="ml-1.5 rounded bg-rh/20 px-1 text-rh">Swing {Math.round(grid.swing * 100)}%</span>}
        </span>
        <span>{grid.length / grid.barSteps} ô nhịp</span>
      </div>
    </div>
  );
});

/* ========================================================================== */
/*                       Row 2 — Chord progression timeline                   */
/* ========================================================================== */

function BeatDots({ index, length }: { index: number; length: SlotLength }) {
  // A half-bar slot shows half the beats (3/4: 1½ beats → 2 dots).
  const beats = useMusicStore((s) => Math.ceil(slotSteps(length, stepsPerBar(s.timeSignature)) / stepsPerBeat(s.timeSignature)));
  // Only the active card subscribes to a changing value → other cards don't re-render per beat.
  const beat = useMusicStore((s) => (s.currentSlot === index && s.isPlaying ? s.currentBeat : -1));
  return (
    <div className="flex gap-1">
      {Array.from({ length: beats }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-1.5 flex-1 rounded-full transition-colors duration-75",
            i === beat ? (i === 0 ? "bg-primary shadow-[0_0_8px_var(--primary)]" : "bg-foreground") : i < beat ? "bg-primary/40" : "bg-muted",
          )}
        />
      ))}
    </div>
  );
}

interface ChordCardProps {
  slot: ChordSlot;
  index: number;
  voicing?: Voicing;
  flats: boolean;
}

const ChordCard = memo(function ChordCard({ slot, index, voicing, flats }: ChordCardProps) {
  const isCurrent = useMusicStore((s) => s.currentSlot === index);
  const isPlaying = useMusicStore((s) => s.isPlaying);
  const updateChord = useMusicStore((s) => s.updateChord);
  const removeChord = useMusicStore((s) => s.removeChord);
  const setChordLength = useMusicStore((s) => s.setChordLength);
  const half = slot.length === "half";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(slot.symbol);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: slot.id });

  const startEdit = () => {
    setDraft(slot.symbol);
    setEditing(true);
  };
  const commit = () => {
    if (updateChord(slot.id, draft)) setEditing(false);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") {
      setDraft(slot.symbol);
      setEditing(false);
    }
  };

  const select = () => {
    audioEngine.jumpTo(index);
    if (!isPlaying && voicing) void audioEngine.previewChord([voicing.bass, ...voicing.rightHand], ["left", ...voicing.rightHand.map(() => "right" as const)]);
  };

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "group relative flex shrink-0 flex-col gap-2 rounded-lg border bg-card p-2.5 transition-[border-color,box-shadow,width]",
        half ? "w-28" : "w-36",
        isCurrent ? "border-primary shadow-[0_0_0_1px_var(--primary),0_0_28px_-8px_var(--primary)]" : "border-border hover:border-muted-foreground/50",
        isDragging && "z-30 opacity-80 shadow-2xl",
      )}
    >
      {isCurrent && <span className="cursor-blink absolute -top-1 left-3 h-2 w-2 rotate-45 bg-primary" aria-hidden />}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <span className="font-mono text-[10px] text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
          <button
            onClick={() => setChordLength(slot.id, half ? "bar" : "half")}
            className={cn(
              "rounded border px-1 font-mono text-[10px] leading-4 transition-colors",
              half ? "border-lh/50 bg-lh/15 text-lh" : "border-border text-muted-foreground hover:text-foreground",
            )}
            title={half ? "Nửa ô nhịp — bấm để đổi thành 1 ô nhịp" : "1 ô nhịp — bấm để đổi thành nửa ô nhịp"}
            aria-label={`Độ dài ${slot.symbol}: ${half ? "nửa ô nhịp" : "1 ô nhịp"}`}
          >
            {half ? "½" : "1"}
          </button>
        </div>
        <div className="flex items-center opacity-60 transition-opacity group-hover:opacity-100">
          <button onClick={startEdit} className="rounded p-0.5 hover:bg-muted" aria-label={`Sửa hợp âm ${slot.symbol}`}>
            <Pencil className="size-3" />
          </button>
          <button onClick={() => removeChord(slot.id)} className="rounded p-0.5 hover:bg-muted hover:text-destructive" aria-label={`Xóa hợp âm ${slot.symbol}`}>
            <X className="size-3.5" />
          </button>
          <button {...attributes} {...listeners} className="cursor-grab touch-none rounded p-0.5 hover:bg-muted active:cursor-grabbing" aria-label="Kéo để sắp xếp">
            <GripVertical className="size-3.5" />
          </button>
        </div>
      </div>

      {editing ? (
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={commit}
          aria-invalid={!isValidChord(draft)}
          className="h-9 font-mono text-lg font-bold"
        />
      ) : (
        <button onClick={select} onDoubleClick={startEdit} className="text-left" title="Click: nhảy tới / nghe thử · Double-click: sửa">
          <div className={cn("truncate text-2xl leading-none font-bold tracking-tight", isCurrent && "text-primary")}>{slot.symbol}</div>
          {voicing && (
            <div className="mt-1.5 flex flex-col gap-0.5 font-mono text-[10px] leading-tight">
              <span className="truncate text-rh">{voicing.rightHand.map((m) => chordToneName(m, voicing.chord, flats)).join(" ")}</span>
              <span className="text-lh">
                {chordToneName(voicing.bass, voicing.chord, flats)} · {INVERSION_NAMES[voicing.inversion]}
              </span>
            </div>
          )}
        </button>
      )}

      <BeatDots index={index} length={slot.length} />
    </div>
  );
});

function AddChordForm() {
  const addChord = useMusicStore((s) => s.addChord);
  const [text, setText] = useState("");
  const { slots, invalid, error } = parseProgressionText(text);
  const ok = slots.length > 0 && invalid.length === 0 && !error;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    slots.forEach((s) => addChord(s.symbol, s.length));
    setText("");
  };

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-1 items-start gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="G  D/F#  Em7 …   hoặc chia ô nhịp:  C G/B | Am Am/G | F"
          aria-invalid={invalid.length > 0}
          className="font-mono"
          aria-label="Thêm hợp âm"
        />
        {invalid.length > 0 ? (
          <span className="text-[11px] text-destructive">Không nhận ra: {invalid.join(", ")}</span>
        ) : error ? (
          <span className="text-[11px] text-destructive">{error}</span>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            Dùng <kbd className="font-mono">|</kbd> để chia ô nhịp — 2 hợp âm trong một ô sẽ mỗi hợp âm nửa ô nhịp. Bấm nút <span className="font-mono">1</span>/
            <span className="font-mono">½</span> trên thẻ để đổi độ dài.
          </span>
        )}
      </div>
      <Button type="submit" variant="secondary" disabled={!ok}>
        <Plus /> Thêm
      </Button>
    </form>
  );
}

function ProgressionTools() {
  const setProgression = useMusicStore((s) => s.setProgression);
  const transpose = useMusicStore((s) => s.transpose);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        onValueChange={(id) => {
          const preset = PROGRESSION_PRESETS.find((p) => p.id === id);
          if (preset) {
            audioEngine.jumpTo(0);
            setProgression(parseProgressionText(preset.text).slots);
          }
        }}
      >
        <SelectTrigger className="w-48" aria-label="Vòng hợp âm mẫu">
          <ListMusic className="size-4 text-muted-foreground" />
          <SelectValue placeholder="Vòng hợp âm mẫu" />
        </SelectTrigger>
        <SelectContent>
          {PROGRESSION_PRESETS.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex items-center rounded-md border border-border">
        <Button variant="ghost" size="sm" onClick={() => transpose(-1)} aria-label="Hạ nửa cung">
          ♭
        </Button>
        <span className="px-1 text-[11px] text-muted-foreground">Transpose</span>
        <Button variant="ghost" size="sm" onClick={() => transpose(1)} aria-label="Nâng nửa cung">
          ♯
        </Button>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          audioEngine.stop();
          setProgression([]);
        }}
        className="text-muted-foreground"
      >
        <Trash2 /> Xóa hết
      </Button>
    </div>
  );
}

function ChordTimeline() {
  const progression = useMusicStore((s) => s.progression);
  const moveChord = useMusicStore((s) => s.moveChord);
  const symbols = useMemo(() => progression.map((s) => s.symbol), [progression]);
  const voicings = useMemo(() => getArrangement(symbols), [symbols]);
  const flats = arrangementPrefersFlats(symbols);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = progression.findIndex((s) => s.id === active.id);
    const to = progression.findIndex((s) => s.id === over.id);
    if (from >= 0 && to >= 0) moveChord(from, to);
  };

  if (progression.length === 0) {
    return (
      <div className="flex h-[132px] items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
        Chưa có hợp âm — nhập bên dưới hoặc chọn một vòng hợp âm mẫu.
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={progression.map((s) => s.id)} strategy={horizontalListSortingStrategy}>
        <div className="scroll-thin flex gap-2 overflow-x-auto pt-1.5 pb-2">
          {progression.map((slot, i) => (
            <ChordCard key={slot.id} slot={slot} index={i} voicing={voicings[i]} flats={flats} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

/* ========================================================================== */

export function ProgressionBuilder() {
  const progression = useMusicStore((s) => s.progression);
  const barSteps = useMusicStore((s) => stepsPerBar(s.timeSignature));
  const timeline = getTimeline(progression, barSteps);
  return (
    <section className="panel flex flex-col gap-4 p-4" aria-label="Điệu & vòng hợp âm">
      {/* Row 1 */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-3">
          <h2 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">Điệu nhạc</h2>
          <StyleSelector />
          <PatternSelector />
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">Pattern</h2>
            <div className="flex gap-1.5">
              <Badge variant="left">Tay trái · Bass</Badge>
              <Badge variant="right">Tay phải · Comping</Badge>
            </div>
          </div>
          <PatternGrid />
        </div>
      </div>

      {/* Row 2 */}
      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
            Vòng hợp âm{" "}
            <span className="ml-1 font-mono normal-case">
              ({timeline.bars} ô nhịp · lặp lại{timeline.padded && " · hợp âm cuối được kéo cho tròn ô nhịp"})
            </span>
          </h2>
          <ProgressionTools />
        </div>
        <ChordTimeline />
        <AddChordForm />
      </div>
    </section>
  );
}
