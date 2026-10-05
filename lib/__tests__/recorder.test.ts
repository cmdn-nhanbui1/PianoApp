import { describe, expect, it } from "vitest";
import { exportKey, Recorder, recordingFileStem, selectNotes } from "@/lib/recorder";

const META = { bpm: 100, timeSignature: "4/4" as const };

describe("Recorder", () => {
  it("ignores everything while idle", () => {
    const r = new Recorder();
    r.noteOn(60, 0.5, 1);
    r.noteOff(60, 2);
    r.pedal(true, 1);
    r.scheduled("accomp", 48, 0.5, 1, 2);
    expect(r.isRecording).toBe(false);
    r.start(10, META);
    const rec = r.stop(11);
    expect(rec.notes).toEqual([]);
    expect(rec.pedals).toEqual([]);
  });

  it("records live notes relative to the start time", () => {
    const r = new Recorder();
    r.start(10, META);
    r.noteOn(60, 0.8, 10.5);
    r.noteOff(60, 11.25);
    const rec = r.stop(12);
    expect(rec).toMatchObject({ duration: 2, bpm: 100, timeSignature: "4/4" });
    expect(rec.notes).toEqual([{ source: "live", midi: 60, velocity: 0.8, start: 0.5, end: 1.25 }]);
  });

  it("closes an open pitch before re-triggering it", () => {
    const r = new Recorder();
    r.start(0, META);
    r.noteOn(60, 0.5, 1);
    r.noteOn(60, 0.9, 2);
    r.noteOff(60, 3);
    const rec = r.stop(4);
    expect(rec.notes.map((n) => [n.start, n.end, n.velocity])).toEqual([
      [1, 2, 0.5],
      [2, 3, 0.9],
    ]);
  });

  it("closes held live notes at stop", () => {
    const r = new Recorder();
    r.start(0, META);
    r.noteOn(64, 0.7, 1);
    const rec = r.stop(3);
    expect(rec.notes).toEqual([{ source: "live", midi: 64, velocity: 0.7, start: 1, end: 3 }]);
    expect(r.isRecording).toBe(false);
  });

  it("drops scheduled notes not yet heard at stop and clamps ends", () => {
    const r = new Recorder();
    r.start(5, META);
    r.scheduled("accomp", 48, 0.6, 5.5, 9); // rings past stop → clamped
    r.scheduled("accomp", 52, 0.6, 7.05, 7.5); // look-ahead, starts after stop → dropped
    const rec = r.stop(7);
    expect(rec.notes).toEqual([{ source: "accomp", midi: 48, velocity: 0.6, start: 0.5, end: 2 }]);
  });

  it("records pedal events and drops ones after stop", () => {
    const r = new Recorder();
    r.start(1, META);
    r.pedal(true, 1.5);
    r.pedal(false, 2.5);
    r.pedal(true, 3.5); // after the stop below
    const rec = r.stop(3);
    expect(rec.pedals).toEqual([
      { time: 0.5, down: true },
      { time: 1.5, down: false },
    ]);
  });

  it("sorts notes by start time", () => {
    const r = new Recorder();
    r.start(0, META);
    r.noteOn(60, 0.5, 1);
    r.scheduled("accomp", 48, 0.5, 0.5, 1.5);
    r.noteOff(60, 2);
    const rec = r.stop(3);
    expect(rec.notes.map((n) => n.midi)).toEqual([48, 60]);
  });

  it("starts a fresh log on every start()", () => {
    const r = new Recorder();
    r.start(0, META);
    r.noteOn(60, 0.5, 0.1);
    r.stop(1);
    r.start(5, META);
    expect(r.stop(6).notes).toEqual([]);
  });
});

describe("helpers", () => {
  const rec = {
    notes: [
      { source: "live" as const, midi: 60, velocity: 1, start: 0, end: 1 },
      { source: "accomp" as const, midi: 48, velocity: 1, start: 0, end: 1 },
    ],
    pedals: [],
    duration: 1,
    bpm: 120,
    timeSignature: "4/4" as const,
  };

  it("selectNotes filters by part", () => {
    expect(selectNotes(rec, { live: true, accomp: false }).map((n) => n.midi)).toEqual([60]);
    expect(selectNotes(rec, { live: false, accomp: true }).map((n) => n.midi)).toEqual([48]);
    expect(selectNotes(rec, { live: true, accomp: true })).toHaveLength(2);
  });

  it("exportKey is distinct per format and filter", () => {
    expect(exportKey("mp3", { live: true, accomp: false })).toBe("mp3:L");
    expect(exportKey("midi", { live: true, accomp: true })).toBe("midi:LA");
  });

  it("recordingFileStem uses local time", () => {
    expect(recordingFileStem(new Date(2026, 9, 2, 14, 5))).toBe("piano-2026-10-02-1405");
  });
});
