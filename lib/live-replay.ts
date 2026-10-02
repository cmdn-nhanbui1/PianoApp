/**
 * Turns the recorded live part back into voice commands, with the same sustain-pedal rules as
 * AudioEngine.liveNoteOn/liveNoteOff/setPedal — so the offline render damps exactly like the
 * real-time engine did.
 */

import type { RecNote, RecPedal } from "@/lib/recorder";

export type VoiceCommand =
  | { type: "attack"; midi: number; time: number; velocity: number }
  | { type: "release"; midi: number; time: number };

type Event =
  | { time: number; order: number; kind: "on"; midi: number; velocity: number }
  | { time: number; order: number; kind: "off"; midi: number }
  | { time: number; order: number; kind: "pedal"; down: boolean };

export function liveVoiceCommands(notes: RecNote[], pedals: RecPedal[], releaseAllAt: number): VoiceCommand[] {
  const events: Event[] = [
    ...notes.flatMap((n): Event[] => [
      { time: n.start, order: 2, kind: "on", midi: n.midi, velocity: n.velocity },
      { time: n.end, order: 0, kind: "off", midi: n.midi },
    ]),
    ...pedals.map((p): Event => ({ time: p.time, order: 1, kind: "pedal", down: p.down })),
  ].sort((a, b) => a.time - b.time || a.order - b.order);

  const out: VoiceCommand[] = [];
  const held = new Set<number>();
  const sustained = new Set<number>();
  let pedalDown = false;

  for (const e of events) {
    if (e.kind === "on") {
      held.add(e.midi);
      sustained.delete(e.midi);
      out.push({ type: "attack", midi: e.midi, time: e.time, velocity: e.velocity });
    } else if (e.kind === "off") {
      held.delete(e.midi);
      if (pedalDown) sustained.add(e.midi);
      else out.push({ type: "release", midi: e.midi, time: e.time });
    } else {
      pedalDown = e.down;
      if (e.down) continue;
      for (const midi of sustained) if (!held.has(midi)) out.push({ type: "release", midi, time: e.time });
      sustained.clear();
    }
  }
  for (const midi of sustained) out.push({ type: "release", midi, time: releaseAllAt });
  return out;
}
