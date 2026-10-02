/** Cuts the silent tail of a render (any channel above the threshold counts) and fades out. */
export function trimTail(channels: Float32Array[], sampleRate: number, thresholdDb = -80, fadeMs = 50): Float32Array[] {
  const threshold = Math.pow(10, thresholdDb / 20);
  let end = 0;
  for (const ch of channels) {
    for (let i = ch.length - 1; i >= end; i--) {
      if (Math.abs(ch[i]) > threshold) {
        end = i + 1;
        break;
      }
    }
  }
  const fade = Math.min(end, Math.round((fadeMs / 1000) * sampleRate));
  return channels.map((ch) => {
    const out = ch.slice(0, end);
    for (let i = 0; i < fade; i++) out[end - fade + i] *= 1 - (i + 1) / fade;
    return out;
  });
}
