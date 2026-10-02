/**
 * Key Bus — a tiny synchronous event channel between the audio engine and the keyboard.
 *
 * Note on/off events fire dozens of times per second. Routing them through React state
 * would re-render the keyboard on every 16th note, so instead the keyboard subscribes
 * here and mutates `data-*` attributes on the key DOM nodes directly.
 */

export type KeySource = "left" | "right" | "user";

export type KeyBusEvent =
  | { type: "on"; midi: number; source: KeySource; velocity: number }
  | { type: "off"; midi: number; source: KeySource }
  | { type: "guide"; left: number[]; right: number[]; fingers: Record<number, number> }
  /** Releases every sounding key highlight (guide markers are kept). */
  | { type: "clear" };

type Listener = (e: KeyBusEvent) => void;

const listeners = new Set<Listener>();
/** Last guide is replayed to late subscribers, so mount order doesn't matter. */
let lastGuide: KeyBusEvent | null = null;

export const keyBus = {
  subscribe(fn: Listener) {
    listeners.add(fn);
    if (lastGuide) fn(lastGuide);
    return () => {
      listeners.delete(fn);
    };
  },
  emit(e: KeyBusEvent) {
    if (e.type === "guide") lastGuide = e;
    listeners.forEach((fn) => fn(e));
  },
  on(midi: number, source: KeySource, velocity = 0.8) {
    this.emit({ type: "on", midi, source, velocity });
  },
  off(midi: number, source: KeySource) {
    this.emit({ type: "off", midi, source });
  },
  guide(left: number[], right: number[], fingers: Record<number, number>) {
    this.emit({ type: "guide", left, right, fingers });
  },
  clear() {
    this.emit({ type: "clear" });
  },
};
