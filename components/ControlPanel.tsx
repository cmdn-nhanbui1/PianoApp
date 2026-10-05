"use client";

import { useRef } from "react";
import { Loader2, Minus, Pause, Piano, Play, Plus, Square, Timer, Usb, Volume1, Volume2, VolumeX } from "lucide-react";
import { RecorderPanel } from "@/components/RecorderPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { audioEngine } from "@/hooks/useAudioEngine";
import { KEY_COUNTS, type KeyCount } from "@/lib/music-theory";
import { cn } from "@/lib/utils";
import type { TimeSignature } from "@/lib/styles";
import { useMusicStore } from "@/store/useMusicStore";

/* ------------------------------- Transport ------------------------------- */

function Transport() {
  const isPlaying = useMusicStore((s) => s.isPlaying);
  const hasChords = useMusicStore((s) => s.progression.length > 0);
  const audioStatus = useMusicStore((s) => s.audioStatus);
  const metronome = useMusicStore((s) => s.metronome);
  const setMetronome = useMusicStore((s) => s.setMetronome);

  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="icon" onClick={() => audioEngine.stop()} aria-label="Dừng" title="Dừng (về đầu)">
        <Square className="size-3.5 fill-current" />
      </Button>
      <Button
        size="lg"
        className={cn("w-28 font-semibold", isPlaying && "shadow-[0_0_24px_-4px_var(--primary)]")}
        disabled={!hasChords}
        onClick={() => void audioEngine.toggle()}
        aria-label={isPlaying ? "Tạm dừng" : "Phát"}
        title="Phím tắt: Space"
      >
        {audioStatus === "loading" && !isPlaying ? (
          <Loader2 className="animate-spin" />
        ) : isPlaying ? (
          <Pause className="fill-current" />
        ) : (
          <Play className="fill-current" />
        )}
        {isPlaying ? "Pause" : "Play"}
      </Button>
      <Button
        variant={metronome ? "default" : "outline"}
        size="icon"
        onClick={() => setMetronome(!metronome)}
        aria-pressed={metronome}
        aria-label="Metronome"
        title="Metronome"
      >
        <Timer />
      </Button>
    </div>
  );
}

/* ---------------------------------- Tempo --------------------------------- */

function Tempo() {
  const bpm = useMusicStore((s) => s.bpm);
  const setBpm = useMusicStore((s) => s.setBpm);
  const taps = useRef<number[]>([]);

  const tap = () => {
    const now = performance.now();
    taps.current = [...taps.current.filter((t) => now - t < 2500), now].slice(-6);
    if (taps.current.length >= 3) {
      const intervals = taps.current.slice(1).map((t, i) => t - taps.current[i]);
      setBpm(60000 / (intervals.reduce((a, b) => a + b, 0) / intervals.length));
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="lcd flex h-11 w-[92px] shrink-0 flex-col items-center justify-center rounded-md leading-none">
        <span className="text-xl font-semibold tabular-nums">{bpm}</span>
        <span className="text-[9px] tracking-[0.2em] opacity-70">BPM</span>
      </div>
      <div className="flex w-full min-w-[140px] flex-col gap-1.5">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => setBpm(bpm - 1)} aria-label="Giảm tempo">
            <Minus />
          </Button>
          <Slider min={40} max={220} step={1} value={[bpm]} onValueChange={([v]) => setBpm(v)} aria-label="Tempo" />
          <Button variant="ghost" size="icon-sm" onClick={() => setBpm(bpm + 1)} aria-label="Tăng tempo">
            <Plus />
          </Button>
        </div>
        <button onClick={tap} className="self-start rounded px-1.5 text-[10px] tracking-wider text-muted-foreground uppercase hover:text-foreground">
          Tap tempo
        </button>
      </div>
    </div>
  );
}

/* ----------------------------- Time signature ----------------------------- */

function TimeSignaturePicker() {
  const ts = useMusicStore((s) => s.timeSignature);
  const setTs = useMusicStore((s) => s.setTimeSignature);
  return (
    <div className="flex rounded-md border border-border p-0.5" role="radiogroup" aria-label="Nhịp">
      {(["4/4", "3/4", "12/8"] as TimeSignature[]).map((value) => (
        <button
          key={value}
          role="radio"
          aria-checked={ts === value}
          onClick={() => setTs(value)}
          className={cn(
            "rounded px-2.5 py-1 font-mono text-sm transition-colors",
            ts === value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {value}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------- Volume --------------------------------- */

function VolumeControl() {
  const volume = useMusicStore((s) => s.volume);
  const setVolume = useMusicStore((s) => s.setVolume);
  const Icon = volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;
  return (
    <div className="flex w-36 items-center gap-2">
      <button onClick={() => setVolume(volume === 0 ? 80 : 0)} aria-label="Tắt/bật tiếng" className="text-muted-foreground hover:text-foreground">
        <Icon className="size-4" />
      </button>
      <Slider min={0} max={100} step={1} value={[volume]} onValueChange={([v]) => setVolume(v)} aria-label="Âm lượng" />
    </div>
  );
}

/* ---------------------------------- MIDI ---------------------------------- */

function MidiLed() {
  const activity = useMusicStore((s) => s.midiActivity);
  // Remounting via `key` restarts the CSS animation on every incoming note.
  return (
    <span
      key={activity}
      className={cn("size-2 rounded-full bg-muted", activity > 0 && "led-flash")}
    />
  );
}

function MidiSelector() {
  const status = useMusicStore((s) => s.midiStatus);
  const devices = useMusicStore((s) => s.midiDevices);
  const selected = useMusicStore((s) => s.selectedMidiId);
  const select = useMusicStore((s) => s.selectMidiDevice);
  const connected = devices.filter((d) => d.connected);

  if (status === "unsupported" || status === "denied") {
    return (
      <Badge variant="secondary" title="Web MIDI chỉ hỗ trợ trên Chrome/Edge/Opera (HTTPS hoặc localhost)">
        <Usb className="size-3" /> {status === "denied" ? "MIDI bị chặn" : "Trình duyệt không hỗ trợ MIDI"}
      </Badge>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <MidiLed />
      <Select value={selected} onValueChange={select}>
        <SelectTrigger className="w-52" aria-label="Thiết bị MIDI">
          <Usb className="size-4 shrink-0 text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Tự động — {connected.length ? `${connected.length} thiết bị` : "chưa có thiết bị"}</SelectItem>
          <SelectItem value="off">Tắt MIDI In</SelectItem>
          {devices.length > 0 && <SelectSeparator />}
          {devices.length > 0 && (
            <SelectGroup>
              <SelectLabel>MIDI Inputs</SelectLabel>
              {devices.map((d) => (
                <SelectItem key={d.id} value={d.id} disabled={!d.connected}>
                  {d.name}
                  {d.manufacturer ? ` · ${d.manufacturer}` : ""}
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}

function KeyboardSizeSelector() {
  const size = useMusicStore((s) => s.keyboardSize);
  const detected = useMusicStore((s) => s.detectedKeyCount);
  const setSize = useMusicStore((s) => s.setKeyboardSize);
  return (
    <Select value={String(size)} onValueChange={(v) => setSize(v === "auto" ? "auto" : (Number(v) as KeyCount))}>
      <SelectTrigger className="w-48" aria-label="Số phím đàn" title="Số phím hiển thị — Tự động: theo đàn MIDI đang kết nối">
        <Piano className="size-4 shrink-0 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="auto">Tự động ({detected} phím)</SelectItem>
        <SelectSeparator />
        {KEY_COUNTS.map((k) => (
          <SelectItem key={k} value={String(k)}>
            {k} phím
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/* --------------------------------- Toggles -------------------------------- */

function Toggles() {
  const humanize = useMusicStore((s) => s.humanize);
  const sustain = useMusicStore((s) => s.sustain);
  const setHumanize = useMusicStore((s) => s.setHumanize);
  const setSustain = useMusicStore((s) => s.setSustain);
  return (
    <div className="flex items-center gap-4 text-sm">
      <label className="flex cursor-pointer items-center gap-2" title="Sai số ±5ms thời gian, ±10% lực nhấn — nghe như người thật chơi">
        <Switch checked={humanize} onCheckedChange={setHumanize} />
        Humanize
      </label>
      <label className="flex cursor-pointer items-center gap-2" title="Pedal vang (đổi pedal theo hợp âm)">
        <Switch checked={sustain} onCheckedChange={setSustain} />
        Sustain
      </label>
    </div>
  );
}

function AudioStatusBadge() {
  const status = useMusicStore((s) => s.audioStatus);
  if (status === "ready") return <Badge variant="secondary">Grand Piano · sẵn sàng</Badge>;
  if (status === "error") return <Badge variant="outline" title="Không tải được sample, đang dùng synth dự phòng">Synth dự phòng</Badge>;
  return (
    <Badge variant="secondary">
      <Loader2 className="size-3 animate-spin" /> Đang tải piano…
    </Badge>
  );
}

/* ------------------------------ Control panel ----------------------------- */

export function ControlPanel() {
  return (
    <header className="panel flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
      <div className="flex items-center gap-2.5">
        <div className="flex size-9 items-center justify-center rounded-lg bg-gradient-to-br from-rh to-rh-2 text-primary-foreground shadow-[0_0_20px_-6px_var(--rh)]">
          <Piano className="size-5" />
        </div>
        <div className="leading-tight">
          <h1 className="text-sm font-semibold tracking-tight">Accompaniment Studio</h1>
          <p className="text-[11px] text-muted-foreground">Piano Pro</p>
        </div>
      </div>

      <Transport />
      <RecorderPanel />
      <Tempo />
      <TimeSignaturePicker />
      <VolumeControl />

      <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2">
        <Toggles />
        <MidiSelector />
        <KeyboardSizeSelector />
        <AudioStatusBadge />
      </div>
    </header>
  );
}
