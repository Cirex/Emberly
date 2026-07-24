import { useCallback, useEffect, useRef, useState } from "react";
import {
  type DictationAvailability,
  dictationAvailability,
  isDictationModuleLinked,
  onDictationError,
  onDictationResult,
  requestDictationPermissions,
  startDictation,
  stopDictation,
} from "@/lib/dictation/native";
import { applyTranscript, beginDictation, type DictationSpan } from "@/lib/dictation/insert";
import type { AppLanguage } from "@/lib/i18n";

/**
 * A dictation session bound to a text field.
 *
 * The editor owns the draft; this owns the microphone and the span the
 * recognizer is currently rewriting. Callers hand it getters rather than
 * values, because the recognizer's callbacks outlive any one render and must
 * read the draft as it stands, not as it was when the session started.
 */
export function useDictation(input: {
  language: AppLanguage;
  getText: () => string;
  getSelection: () => { start: number; end: number };
  onText: (text: string, caret: number) => void;
}): {
  availability: DictationAvailability;
  /** Whether the native module is in this binary — the one signal that tells
   *  an old build apart from a device that can't dictate. */
  moduleLinked: boolean;
  listening: boolean;
  error: string | null;
  toggle: () => void;
  clearError: () => void;
} {
  const [availability, setAvailability] = useState<DictationAvailability>("unsupported");
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spanRef = useRef<DictationSpan | null>(null);

  // The recognizer calls back long after the render that subscribed, so the
  // callbacks are read from a ref rather than captured.
  const io = useRef(input);
  io.current = input;

  useEffect(() => {
    let alive = true;
    void dictationAvailability(input.language).then((a) => {
      if (alive) setAvailability(a);
    });
    return () => {
      alive = false;
    };
  }, [input.language]);

  useEffect(() => {
    const result = onDictationResult(({ text, isFinal }) => {
      const span = spanRef.current;
      if (!span) return;
      const next = applyTranscript(io.current.getText(), span, text);
      spanRef.current = next.span;
      io.current.onText(next.text, next.caret);
      if (isFinal) {
        spanRef.current = null;
        setListening(false);
      }
    });
    const failure = onDictationError(({ message }) => {
      spanRef.current = null;
      setListening(false);
      setError(message);
    });
    return () => {
      result?.remove();
      failure?.remove();
    };
  }, []);

  // Never leave the mic hot behind a closing sheet.
  useEffect(() => {
    return () => {
      void stopDictation();
    };
  }, []);

  const stop = useCallback(() => {
    setListening(false);
    spanRef.current = null;
    void stopDictation();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    let state = availability;
    if (state === "needsPermission") {
      state = await requestDictationPermissions();
      setAvailability(state);
    }
    if (state !== "ready") return;

    // Open the run before the first partial lands, so a selection is consumed
    // exactly once and the anchor is the caret the tech was looking at.
    const sel = io.current.getSelection();
    const opened = beginDictation(io.current.getText(), sel.start, sel.end);
    spanRef.current = opened.span;
    io.current.onText(opened.text, opened.caret);

    try {
      await startDictation(io.current.language);
      setListening(true);
    } catch (err) {
      spanRef.current = null;
      setError(err instanceof Error ? err.message : "Couldn't start dictation");
    }
  }, [availability]);

  const toggle = useCallback(() => {
    if (listening) stop();
    else void start();
  }, [listening, start, stop]);

  return {
    availability,
    moduleLinked: isDictationModuleLinked(),
    listening,
    error,
    toggle,
    clearError: () => setError(null),
  };
}
