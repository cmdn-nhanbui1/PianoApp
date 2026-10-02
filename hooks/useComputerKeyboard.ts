"use client";

import { useEffect, useRef, useState } from "react";
import { recordingController } from "@/lib/recording-controller";
import { audioEngine } from "./useAudioEngine";

/**
 * QWERTY → piano, the layout used by most DAWs:
 *
 *    W E   T Y U   O P        (black keys)
 *   A S D F G H J K L ;       (white keys, A = C)
 *
 * Z / X shift the octave, Space toggles play/pause, R toggles recording.
 */
const KEY_TO_OFFSET: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7,
  KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16,
};

const MIN_OCTAVE = 2;
const MAX_OCTAVE = 6;

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export function useComputerKeyboard() {
  const [octave, setOctave] = useState(4);
  const octaveRef = useRef(octave);
  octaveRef.current = octave;

  useEffect(() => {
    // Remember which MIDI note each physical key started, so an octave change mid-press releases correctly.
    const down = new Map<string, number>();

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "Space") {
        // Let focused buttons/switches handle Space themselves.
        if (e.target instanceof HTMLElement && e.target.closest("button, [role=switch], [role=slider], [role=combobox]")) return;
        e.preventDefault();
        if (!e.repeat) void audioEngine.toggle();
        return;
      }
      if (e.code === "KeyZ" && !e.repeat) return setOctave((o) => Math.max(MIN_OCTAVE, o - 1));
      if (e.code === "KeyX" && !e.repeat) return setOctave((o) => Math.min(MAX_OCTAVE, o + 1));
      if (e.code === "KeyR") {
        e.preventDefault();
        if (!e.repeat) void recordingController.toggle();
        return;
      }

      const offset = KEY_TO_OFFSET[e.code];
      if (offset === undefined || e.repeat || down.has(e.code)) return;
      e.preventDefault();
      const midi = (octaveRef.current + 1) * 12 + offset;
      down.set(e.code, midi);
      audioEngine.liveNoteOn(midi, e.shiftKey ? 1 : 0.72);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const midi = down.get(e.code);
      if (midi === undefined) return;
      down.delete(e.code);
      audioEngine.liveNoteOff(midi);
    };

    const releaseAll = () => {
      down.forEach((midi) => audioEngine.liveNoteOff(midi));
      down.clear();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseAll);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseAll);
      releaseAll();
    };
  }, []);

  return { octave, setOctave };
}
