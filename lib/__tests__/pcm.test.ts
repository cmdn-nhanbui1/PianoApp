import { describe, expect, it } from "vitest";
import { trimTail } from "@/lib/pcm";

const SR = 1000; // 1 kHz keeps the numbers readable

describe("trimTail", () => {
  it("cuts trailing silence below the threshold on all channels", () => {
    const l = new Float32Array(3000);
    const r = new Float32Array(3000);
    l.fill(0.5, 0, 1000);
    r.fill(0.5, 0, 1500); // right channel rings longer → keep up to 1500
    const [tl, tr] = trimTail([l, r], SR);
    expect(tl.length).toBe(1500);
    expect(tr.length).toBe(1500);
  });

  it("applies a linear fade over the last fadeMs", () => {
    const l = new Float32Array(1000).fill(1);
    const [out] = trimTail([l], SR, -80, 50);
    expect(out.length).toBe(1000);
    expect(out[949]).toBeCloseTo(1, 5);
    expect(out[999]).toBeCloseTo(0, 1);
    expect(out[975]).toBeGreaterThan(0.3);
    expect(out[975]).toBeLessThan(0.7);
  });

  it("does not modify the input arrays", () => {
    const l = new Float32Array(100).fill(1);
    trimTail([l], SR);
    expect(l[99]).toBe(1);
  });

  it("returns empty channels for complete silence", () => {
    const [out] = trimTail([new Float32Array(500)], SR);
    expect(out.length).toBe(0);
  });
});
