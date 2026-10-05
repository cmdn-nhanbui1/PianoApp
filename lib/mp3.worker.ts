/**
 * MP3 encoding off the main thread: LAME (WASM) at 320 kbps CBR. The WASM binary is inlined in
 * the package, so nothing is fetched at runtime.
 */

import { createMp3Encoder } from "wasm-media-encoders";

export type Mp3Request = { left: Float32Array; right: Float32Array; sampleRate: number };
export type Mp3Response = { ok: true; mp3: ArrayBuffer } | { ok: false; error: string };

/** Samples per encode() call — a multiple of the 1152-sample MP3 frame. */
const CHUNK = 1152 * 64;

// The project tsconfig uses the DOM lib; describe just the worker surface we use.
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Mp3Request>) => void) | null;
  postMessage(msg: Mp3Response, transfer?: Transferable[]): void;
};

ctx.onmessage = async (e: MessageEvent<Mp3Request>) => {
  try {
    const { left, right, sampleRate } = e.data;
    const encoder = await createMp3Encoder();
    encoder.configure({ channels: 2, sampleRate, bitrate: 320, outputSampleRate: 44100 });

    const parts: Uint8Array[] = [];
    for (let i = 0; i < left.length; i += CHUNK) {
      // encode()/finalize() return views into WASM memory — copy before the next call.
      parts.push(encoder.encode([left.subarray(i, i + CHUNK), right.subarray(i, i + CHUNK)]).slice());
    }
    parts.push(encoder.finalize().slice());

    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    ctx.postMessage({ ok: true, mp3: out.buffer } satisfies Mp3Response, [out.buffer]);
  } catch (err) {
    ctx.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Mp3Response);
  }
};
