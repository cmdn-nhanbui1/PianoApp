"use client";

import { useEffect } from "react";
import { CircleCheck, Download, Loader2, RotateCcw, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { exportKey } from "@/lib/recorder";
import { recordingController } from "@/lib/recording-controller";
import { useMusicStore } from "@/store/useMusicStore";

const formatTime = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

export function RecordingResult() {
  const recState = useMusicStore((s) => s.recState);
  const info = useMusicStore((s) => s.recInfo);
  const format = useMusicStore((s) => s.recFormat);
  const live = useMusicStore((s) => s.recLive);
  const accomp = useMusicStore((s) => s.recAccomp);
  const exports = useMusicStore((s) => s.recExports);
  const job = useMusicStore((s) => s.recJob);
  const error = useMusicStore((s) => s.recError);

  const key = exportKey(format, { live, accomp });
  useEffect(() => {
    if (recState === "ready") void recordingController.prepare();
  }, [recState, key]);

  if (recState !== "ready" || !info) return null;

  const notes = (live ? info.liveNotes : 0) + (accomp ? info.accompNotes : 0);
  const url = exports[key];
  const busy = job?.key === key;
  const failed = error?.key === key ? error.message : null;
  const ext = format === "mp3" ? "mp3" : "mid";

  return (
    <section className="panel flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 text-sm" aria-label="Bản ghi">
      <span className="flex items-center gap-2">
        <CircleCheck className="size-4 text-user" />
        Bản ghi {formatTime(info.duration)} · {notes} nốt
      </span>

      {notes === 0 && <span className="text-muted-foreground">Không có nốt nào</span>}

      {busy && (
        <span className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {job.phase === "render" ? "Đang render…" : "Đang mã hóa…"}
        </span>
      )}

      {failed && (
        <span className="flex items-center gap-2 text-destructive">
          <TriangleAlert className="size-4" /> Xuất file lỗi: {failed}
          <Button variant="outline" size="sm" onClick={() => {
            useMusicStore.getState().setRec({ recError: null });
            void recordingController.prepare();
          }}>
            <RotateCcw /> Thử lại
          </Button>
        </span>
      )}

      {url && format === "mp3" && <audio controls src={url} className="h-8" />}

      {format === "mp3" && info.synth && (
        <span className="text-xs text-muted-foreground">Render bằng synth dự phòng (không tải được sample piano)</span>
      )}

      <div className="ml-auto flex items-center gap-2">
        <Button asChild={!!url} size="sm" disabled={!url}>
          {url ? (
            <a href={url} download={`${info.fileStem}.${ext}`}>
              <Download /> Tải .{ext}
            </a>
          ) : (
            <span>
              <Download /> Tải .{ext}
            </span>
          )}
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => recordingController.discard()} aria-label="Bỏ bản ghi" title="Bỏ bản ghi">
          <X />
        </Button>
      </div>
    </section>
  );
}
