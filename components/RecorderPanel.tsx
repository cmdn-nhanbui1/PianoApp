"use client";

import { useEffect, useState } from "react";
import { Circle, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { recordingController } from "@/lib/recording-controller";
import { cn } from "@/lib/utils";
import { useMusicStore, type RecFormat } from "@/store/useMusicStore";

const formatTime = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

function RecTimer() {
  const startedAt = useMusicStore((s) => s.recStartedAt);
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const id = setInterval(() => setNow(performance.now()), 250);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="flex items-center gap-1.5 font-mono text-sm tabular-nums text-destructive" aria-live="off">
      <span className="size-2 animate-pulse rounded-full bg-destructive" />
      {formatTime(Math.max(0, (now - startedAt) / 1000))}
    </span>
  );
}

function PartChip({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "rounded-md border px-2.5 py-1 text-sm transition-colors",
        checked ? "border-primary/60 bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

export function RecorderPanel() {
  const recState = useMusicStore((s) => s.recState);
  const format = useMusicStore((s) => s.recFormat);
  const live = useMusicStore((s) => s.recLive);
  const accomp = useMusicStore((s) => s.recAccomp);
  const setFormat = useMusicStore((s) => s.setRecFormat);
  const setLive = useMusicStore((s) => s.setRecLive);
  const setAccomp = useMusicStore((s) => s.setRecAccomp);
  const recording = recState === "recording";

  return (
    <div className="flex items-center gap-2">
      <div className="flex rounded-md border border-border p-0.5" role="radiogroup" aria-label="Định dạng ghi">
        {(["midi", "mp3"] as RecFormat[]).map((value) => (
          <button
            key={value}
            role="radio"
            aria-checked={format === value}
            onClick={() => setFormat(value)}
            className={cn(
              "rounded px-2.5 py-1 font-mono text-sm uppercase transition-colors",
              format === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {value}
          </button>
        ))}
      </div>
      <PartChip label="Live" checked={live} onChange={setLive} />
      <PartChip label="Đệm" checked={accomp} onChange={setAccomp} />
      <Button
        variant={recording ? "destructive" : "outline"}
        size="icon"
        disabled={!recording && !live && !accomp}
        onClick={() => void recordingController.toggle()}
        aria-pressed={recording}
        aria-label={recording ? "Dừng ghi" : "Ghi"}
        title={!live && !accomp ? "Chọn ít nhất Live hoặc Đệm" : "Ghi (phím tắt: R)"}
      >
        {recording ? <Square className="size-3.5 fill-current" /> : <Circle className="size-3.5 fill-destructive text-destructive" />}
      </Button>
      {recording && <RecTimer />}
    </div>
  );
}
