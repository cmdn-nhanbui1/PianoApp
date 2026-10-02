/**
 * MP3 export: re-render the recording offline through the same piano chain as the live engine
 * (sample-accurate, immune to CPU hiccups during recording), trim the tail, then encode in a worker.
 */

import { liveVoiceCommands } from "@/lib/live-replay";
import type { Mp3Request, Mp3Response } from "@/lib/mp3.worker";
import { midiToNoteName } from "@/lib/music-theory";
import { trimTail } from "@/lib/pcm";
import { buildPianoChain, makePianoVoice, MASTER_GAIN_DB, type SampleMap } from "@/lib/piano-voice";
import { selectNotes, type PartFilter, type Recording } from "@/lib/recorder";
import type { RecPhase } from "@/store/useMusicStore";

export const RENDER_SAMPLE_RATE = 44100;
/** Room after the stop for releases and the reverb tail; trimmed afterwards. */
const TAIL_SECONDS = 4;
/** Notes still under the pedal at the stop are damped here (release completes inside the tail). */
const DAMP_AFTER_STOP = 2.5;
/** Shortest note the offline voice is asked to play. */
const MIN_NOTE_SECONDS = 0.01;

export async function renderMp3(
  rec: Recording,
  filter: PartFilter,
  samples: SampleMap | null,
  onPhase: (p: RecPhase) => void,
): Promise<Blob> {
  const Tone = await import("tone");
  onPhase("render");

  const live = filter.live ? selectNotes(rec, { live: true, accomp: false }) : [];
  const accomp = filter.accomp ? selectNotes(rec, { live: false, accomp: true }) : [];

  const buffer = await Tone.Offline(
    async () => {
      const chain = buildPianoChain(Tone, MASTER_GAIN_DB);
      await chain.ready;
      if (live.length) {
        const voice = makePianoVoice(Tone, samples, chain.input);
        for (const c of liveVoiceCommands(live, rec.pedals, rec.duration + DAMP_AFTER_STOP)) {
          const name = midiToNoteName(c.midi);
          if (c.type === "attack") voice.triggerAttack(name, c.time, c.velocity);
          else voice.triggerRelease(name, c.time);
        }
      }
      if (accomp.length) {
        const voice = makePianoVoice(Tone, samples, chain.input);
        for (const n of accomp)
          voice.triggerAttackRelease(midiToNoteName(n.midi), Math.max(MIN_NOTE_SECONDS, n.end - n.start), n.start, n.velocity);
      }
    },
    rec.duration + TAIL_SECONDS,
    2,
    RENDER_SAMPLE_RATE,
  );

  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const [l, r] = trimTail([left, right], buffer.sampleRate);

  onPhase("encode");
  return encodeMp3({ left: l, right: r, sampleRate: buffer.sampleRate });
}

function encodeMp3(req: Mp3Request): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./mp3.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<Mp3Response>) => {
      worker.terminate();
      if (e.data.ok) resolve(new Blob([e.data.mp3], { type: "audio/mpeg" }));
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "MP3 encoder failed"));
    };
    // `left` and `right` may share a buffer (mono render); transfer each distinct buffer once.
    const transfer = [...new Set([req.left.buffer, req.right.buffer])] as ArrayBuffer[];
    worker.postMessage(req, transfer);
  });
}
