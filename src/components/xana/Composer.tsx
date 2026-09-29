"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import {
  getSpeechRecognition,
  transcriptFrom,
  type SpeechRecognizer,
} from "./speech";

/**
 * The single input line. Pinned to the bottom, one hairline, radius-full.
 *
 * Enter sends, Shift+Enter breaks the line. The mic exists only where the
 * Web Speech API does — a dead control is worse than no control, so when
 * `getSpeechRecognition()` returns null the button is not rendered at all.
 */

export interface ComposerHandle {
  focus: () => void;
  blur: () => void;
}

export interface ComposerProps {
  onSubmit: (text: string, modality: "text" | "voice") => void;
  /** True while Xana is composing a reply. The field is disabled, not hidden. */
  busy: boolean;
}

const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { onSubmit, busy },
  ref,
) {
  const [value, setValue] = useState("");
  const [dictating, setDictating] = useState(false);
  /** The transcript that was in the field when dictation started. */
  const baseText = useRef("");
  const recognizer = useRef<SpeechRecognizer | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const [micAvailable, setMicAvailable] = useState(false);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => textarea.current?.focus(),
      blur: () => textarea.current?.blur(),
    }),
    [],
  );

  // Feature detection runs after mount, never during render: the server has
  // no `window`, and a mismatch here would desync hydration.
  useEffect(() => {
    setMicAvailable(getSpeechRecognition() !== null);
  }, []);

  const stopDictation = useCallback(() => {
    setDictating(false);
    recognizer.current?.stop();
    recognizer.current = null;
  }, []);

  const startDictation = useCallback(() => {
    const Recognition = getSpeechRecognition();
    if (!Recognition) return;

    baseText.current = value;
    const instance = new Recognition();
    instance.lang = navigator.language || "en-US";
    instance.continuous = false;
    instance.interimResults = true;
    instance.maxAlternatives = 1;

    instance.onresult = (event) => {
      const heard = transcriptFrom(event);
      if (!heard) return;
      const prefix = baseText.current;
      setValue(prefix ? `${prefix} ${heard}` : heard);
    };
    instance.onerror = () => {
      // Dictation is a convenience. It never raises anything at the user.
      stopDictation();
    };
    instance.onend = () => {
      setDictating(false);
      recognizer.current = null;
    };

    recognizer.current = instance;
    setDictating(true);
    instance.start();
  }, [stopDictation, value]);

  // A recognizer left running across an unmount keeps the microphone open.
  useEffect(() => {
    return () => {
      recognizer.current?.abort();
      recognizer.current = null;
    };
  }, []);

  const submit = useCallback(
    (modality: "text" | "voice") => {
      const text = value.trim();
      if (!text || busy) return;
      if (dictating) stopDictation();
      onSubmit(text, modality);
      setValue("");
    },
    [busy, dictating, onSubmit, stopDictation, value],
  );

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit("text");
      }}
      className="relative flex w-full items-end gap-2 rounded-full border border-hairline bg-surface px-5 py-3 transition-colors duration-[var(--t-fast)] focus-within:border-accent/24"
    >
      <label htmlFor="xana-composer" className="sr-only">
        Ask Xana
      </label>
      <textarea
        id="xana-composer"
        ref={textarea}
        rows={1}
        autoFocus
        value={value}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit("text");
          }
        }}
        placeholder="Ask Xana…"
        // 16px on a phone, 15px above it. The mobile value is a floor, not
        // a style choice: iOS Safari force-zooms the page when a focused
        // input is under 16px, and this is the app's primary control.
        className="max-h-[160px] flex-1 resize-none self-center bg-transparent text-[16px] leading-6 font-light tracking-[0.01em] text-text outline-none placeholder:text-faint disabled:opacity-40 md:text-[15px]"
      />

      {/* The slash hint.
          Shown only while the field is empty, because its job is to answer
          "where do I start" — a hint sitting beside a half-written sentence
          is noise. It is not decoration: `/` really does focus this field
          (bound in app/page.tsx, beside Cmd+K), so the keycap is telling the
          truth. Hidden while she is answering, since pressing `/` then would
          focus a disabled field. */}
      {!value.trim() && !busy ? (
        <kbd
          aria-hidden="true"
          title="Press / to jump here"
          className="grid h-5 w-5 shrink-0 self-center place-items-center rounded-[6px] border border-hairline bg-surface-2 font-sans text-[11px] leading-none font-light text-dim shadow-[0_1px_0_rgb(0_0_0/0.35)] transition-[transform,box-shadow] duration-[var(--t-fast)] select-none"
        >
          /
        </kbd>
      ) : null}

      {micAvailable ? (
        <button
          type="button"
          onClick={() => (dictating ? stopDictation() : startDictation())}
          aria-pressed={dictating}
          aria-label={dictating ? "Stop dictation" : "Speak to Xana"}
          className={`mb-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full transition-colors duration-[var(--t-fast)] hover:bg-surface-2 ${
            dictating ? "text-accent" : "text-faint hover:text-dim"
          }`}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            aria-hidden="true"
          >
            <rect
              x="5"
              y="1"
              width="4"
              height="7"
              rx="2"
              stroke="currentColor"
              strokeWidth="1"
            />
            <path
              d="M2.5 6.5a4.5 4.5 0 0 0 9 0M7 11v2"
              stroke="currentColor"
              strokeWidth="1"
              strokeLinecap="round"
            />
          </svg>
        </button>
      ) : null}
    </form>
  );
});

export default Composer;
