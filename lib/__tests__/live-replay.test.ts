import { describe, expect, it } from "vitest";
import { liveVoiceCommands } from "@/lib/live-replay";
import type { RecNote } from "@/lib/recorder";

const n = (midi: number, start: number, end: number, velocity = 0.5): RecNote => ({ source: "live", midi, velocity, start, end });
const brief = (cmds: ReturnType<typeof liveVoiceCommands>) => cmds.map((c) => `${c.type[0]}${c.midi}@${c.time}`);

describe("liveVoiceCommands", () => {
  it("attacks and releases with no pedal", () => {
    expect(brief(liveVoiceCommands([n(60, 0, 1)], [], 9))).toEqual(["a60@0", "r60@1"]);
  });

  it("holds released keys while the pedal is down, damps them on pedal up", () => {
    const cmds = liveVoiceCommands([n(60, 0, 1), n(64, 0.5, 3)], [{ time: 0.2, down: true }, { time: 2, down: false }], 9);
    // 60 released at key-up 1 is held; on pedal up at 2 only 60 is damped (64 still held); 64 released at 3.
    expect(brief(cmds)).toEqual(["a60@0", "a64@0.5", "r60@2", "r64@3"]);
  });

  it("re-striking a sustained key keeps it out of the damp list", () => {
    const cmds = liveVoiceCommands([n(60, 0, 1), n(60, 1.5, 3)], [{ time: 0, down: true }, { time: 2, down: false }], 9);
    expect(brief(cmds)).toEqual(["a60@0", "a60@1.5", "r60@3"]);
  });

  it("releases notes still sustained at the end", () => {
    const cmds = liveVoiceCommands([n(60, 0, 1)], [{ time: 0, down: true }], 5);
    expect(brief(cmds)).toEqual(["a60@0", "r60@5"]);
  });

  it("keeps velocity on attacks", () => {
    expect(liveVoiceCommands([n(60, 0, 1, 0.9)], [], 9)[0]).toEqual({ type: "attack", midi: 60, time: 0, velocity: 0.9 });
  });
});
