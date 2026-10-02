"use client";

/**
 * Owns the current recording: start/stop, the in-memory `Recording`, and its exports
 * (one per format × part filter), built one at a time and exposed as object URLs in the store.
 */

import { audioEngine } from "@/hooks/useAudioEngine";
import { writeMidi } from "@/lib/midi-file";
import { exportKey, recordingFileStem, selectNotes, type Recording } from "@/lib/recorder";
import { renderMp3 } from "@/lib/render-audio";
import { useMusicStore } from "@/store/useMusicStore";

let current: Recording | null = null;
let generation = 0;
let queue: Promise<void> = Promise.resolve();

const store = () => useMusicStore.getState();

function revokeExports() {
  Object.values(store().recExports).forEach((url) => URL.revokeObjectURL(url));
}

async function buildExport() {
  const rec = current;
  const gen = generation;
  const { recFormat, recLive, recAccomp, recExports } = store();
  const filter = { live: recLive, accomp: recAccomp };
  const key = exportKey(recFormat, filter);
  if (!rec || recExports[key] || selectNotes(rec, filter).length === 0) return;

  store().setRec({ recError: null, recJob: { key, phase: recFormat === "mp3" ? "render" : "encode" } });
  try {
    const blob =
      recFormat === "midi"
        ? new Blob([writeMidi(rec, filter)], { type: "audio/midi" })
        : await renderMp3(rec, filter, audioEngine.renderSamples, (phase) => {
            if (gen === generation) store().setRec({ recJob: { key, phase } });
          });
    if (gen !== generation) return; // discarded or replaced while building
    store().setRec({ recJob: null, recExports: { ...store().recExports, [key]: URL.createObjectURL(blob) } });
  } catch (err) {
    if (gen !== generation) return;
    console.error("[recording] export failed", err);
    store().setRec({ recJob: null, recError: { key, message: err instanceof Error ? err.message : String(err) } });
  }
}

export const recordingController = {
  async toggle() {
    if (store().recState === "recording") this.stop();
    else await this.start();
  },

  async start() {
    const s = store();
    if (s.recState === "recording" || (!s.recLive && !s.recAccomp)) return;
    await audioEngine.unlock();
    this.discard();
    audioEngine.startRecording();
    store().setRec({ recState: "recording", recStartedAt: performance.now() });
  },

  stop() {
    if (store().recState !== "recording") return;
    const rec = audioEngine.stopRecording();
    current = rec;
    const count = (source: "live" | "accomp") => rec.notes.filter((n) => n.source === source).length;
    store().setRec({
      recState: "ready",
      recInfo: {
        duration: rec.duration,
        liveNotes: count("live"),
        accompNotes: count("accomp"),
        synth: audioEngine.renderSamples === null,
        fileStem: recordingFileStem(new Date(Date.now() - rec.duration * 1000)),
      },
    });
  },

  prepare() {
    queue = queue.then(buildExport, buildExport);
    return queue;
  },

  discard() {
    generation++;
    revokeExports();
    current = null;
    store().setRec({ recState: "idle", recInfo: null, recExports: {}, recJob: null, recError: null });
  },
};
