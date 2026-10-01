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
  dictationFailure,
  getSpeechRecognition,
  hasOnDeviceRecognition,
  transcriptFrom,
  type SpeechRecognizer,
} from "./speech";

/**
 * The single input line. Pinned to the bottom, one hairline, radius-full.
 *
 * Enter sends, Shift+Enter breaks the line. The mic exists only where the
 * Web Speech API does — a dead control is worse than no control, so when
 * `getSpeechRecognition()` returns null the button is not rendered at all.
 *
 * WHEN THE MIC FAILS, IT SAYS WHY
 *
 * It did not, and that made a working feature look broken. `onerror` threw the
 * reason away, so a denied microphone permission, a browser with no speech
 * service, and an unplugged headset were indistinguishable from a button that
 * does nothing. Dictation is still a convenience — it never raises anything at
 * the user, and nothing here blocks sending a typed line — but a convenience
 * that fails silently is worse than one that is not offered, because the user
 * has no way to tell which of their own settings to change.
 *
 * One recovery is attempted automatically: if the failure is one the on-device
 * model can serve and this browser has that model, dictation restarts with
 * `processLocally`, so the network is no longer in the path.
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
  const [dictationNote, setDictationNote] = useState<string | null>(null);
  /** The transcript that was in the field when dictation started. */
  const baseText = useRef("");
  const recognizer = useRef<SpeechRecognizer | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const [micAvailable, setMicAvailable] = useState(false);
  /** Whether this browser can recognise speech without leaving the machine. */
  const [onDevice, setOnDevice] = useState(false);
  /** Set once the on-device retry has been tried, so it cannot loop. */
  const triedLocally = useRef(false);

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
    setOnDevice(hasOnDeviceRecognition());
  }, []);

  const stopDictation = useCallback(() => {
    setDictating(false);
    recognizer.current?.stop();
    recognizer.current = null;
  }, []);

  /**
   * The two things every recognizer this component starts has in common.
   *
   * Split out so the on-device retry below is the same recognizer with one
   * option changed, rather than a second copy of the wiring that could drift
   * from the first.
   */
  const buildRecognizer = useCallback((instance: SpeechRecognizer, local: boolean): void => {
    instance.lang = navigator.language || "en-US";
    // Not continuous: one press, one utterance. A recognizer that stays open
    // holds the microphone indicator on, which reads as the app listening
    // when it is not.
    instance.continuous = false;
    instance.interimResults = true;
    instance.maxAlternatives = 1;
    if (local) instance.processLocally = true;

    instance.onresult = (event) => {
      const heard = transcriptFrom(event);
      if (!heard) return;
      const prefix = baseText.current;
      setValue(prefix ? `${prefix} ${heard}` : heard);
    };
    instance.onerror = (event) => {
      const reason = event?.error ?? "";
      // Only the first failure of a session gets a recovery attempt, and only
      // if there is a model that can serve it. Retrying on every error would
      // spin against a permission the user has already refused.
      const canRetryLocally =
        !local && onDevice && !triedLocally.current && (reason === "network" || reason === "service-not-allowed");
      if (canRetryLocally) {
        triedLocally.current = true;
        recognizer.current?.abort();
        recognizer.current = null;
        setDictationNote("That needed the browser's speech service. Switching to the on-device model — the first run downloads it.");
        const Recognition = getSpeechRecognition();
        if (Recognition) {
          const retry = new Recognition();
          buildRecognizer(retry, true);
          recognizer.current = retry;
          setDictating(true);
          retry.start();
          return;
        }
      }
      const message = dictationFailure(reason, local);
      if (message) setDictationNote(message);
      stopDictation();
    };
    instance.onend = () => {
      setDictating(false);
      recognizer.current = null;
    };
  }, [onDevice, stopDictation]);

  const startDictation = useCallback(() => {
    const Recognition = getSpeechRecognition();
    if (!Recognition) return;

    baseText.current = value;
    setDictationNote(null);
    const instance = new Recognition();
    buildRecognizer(instance, false);

    recognizer.current = instance;
    setDictating(true);
    instance.start();
  }, [buildRecognizer, value]);

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
      // A failed dictation has been read by now. Leaving the note up while the
      // reply arrives would attach an old explanation to a new turn.
      setDictationNote(null);
      onSubmit(text, modality);
      setValue("");
    },
    [busy, dictating, onSubmit, stopDictation, value],
  );

  return (
    <div className="relative w-full">
      {/* Why dictation stopped, above the field rather than inside it: the pill
          is one line tall and a paragraph in it would push the textarea around
          while the user is mid-sentence. `aria-live` so the reason is announced
          rather than only drawn. */}
      {dictationNote ? (
        <p
          aria-live="polite"
          className="absolute inset-x-4 bottom-full mb-2 text-[12px] leading-relaxed font-normal text-warn"
        >
          {dictationNote}
        </p>
      ) : null}

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
          className="grid h-5 w-5 shrink-0 self-center place-items-center rounded-[6px] border border-hairline bg-surface-2 font-sans text-[11px] leading-none font-normal text-dim shadow-[0_1px_0_rgb(0_0_0/0.35)] transition-[transform,box-shadow] duration-[var(--t-fast)] select-none"
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
    </div>
  );
});

export default Composer;
