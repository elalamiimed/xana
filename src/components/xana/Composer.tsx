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
  dictationNote as buildDictationNote,
  getSpeechRecognition,
  hasOnDeviceRecognition,
  type SpeechRecognizer,
} from "./speech";

/**
 * The single input line. Pinned to the bottom, one hairline, radius-full.
 *
 * Enter sends, Shift+Enter breaks the line. The mic exists only where the Web
 * Speech API does — a dead control is worse than no control, so when
 * `getSpeechRecognition()` returns null the button is not rendered at all.
 *
 * WHY DICTATION USED TO LOOK BROKEN
 *
 * Two mistakes compounded, and both are fixed here.
 *
 * The first was silence on failure: `onerror` threw the reason away, so a denied
 * permission, a browser with no speech service, and an unplugged headset were
 * indistinguishable from a button that does nothing.
 *
 * The second was the shape of the interaction. `continuous = false` means one
 * utterance and the session ends — speak, pause to think, and the microphone is
 * already closed. From the user's side that is not "it heard one sentence", it is
 * "it stopped listening", which is exactly the complaint this was rebuilt for.
 * Dictation now stays open until it is switched off or the field is sent, and it
 * says what it is hearing while it hears it, so a misheard word is visible as
 * words rather than discovered as a wrong reply.
 *
 * PERMISSION FIRST
 *
 * `SpeechRecognition.start()` reports a refused microphone as an anonymous
 * error, sometimes only after the user has already spoken. Where `getUserMedia`
 * exists it is asked first: it is the API that produces a real permission
 * prompt, its failures name their cause, and a refusal is then reported before
 * anything is opened. The probe stream is stopped immediately, since leaving it
 * running would hold the microphone while the recogniser tries to open it.
 */

export interface ComposerHandle {
  focus: () => void;
  blur: () => void;
}

export interface ComposerProps {
  onSubmit: (text: string, modality: "text" | "voice") => void;
  /** True while Xana is composing a reply. The field is disabled, not hidden. */
  busy: boolean;
  /**
   * Called before dictation opens the microphone, so a caller holding it for
   * always-listening can let go. The microphone is one resource; two consumers
   * fight over it and the loser fails with no visible reason.
   */
  onTakeMicrophone?: () => void;
  /**
   * Called when dictation has finished with the microphone, so a caller that
   * gave it up can take it back.
   *
   * Separate from `onTakeMicrophone` because the two are not symmetric in time:
   * taking happens before the permission prompt, giving back happens after the
   * last result, and a caller that only heard about the first would be left
   * permanently switched off.
   */
  onReleaseMicrophone?: () => void;
}

const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { onSubmit, busy, onTakeMicrophone, onReleaseMicrophone },
  ref,
) {
  const [value, setValue] = useState("");
  const [dictating, setDictating] = useState(false);
  const [dictationNote, setDictationNote] = useState<string | null>(null);
  /** What has been heard so far in this dictation, shown so it can be judged. */
  const [heard, setHeard] = useState("");
  /** The transcript that was in the field when dictation started. */
  const baseText = useRef("");
  /**
   * The transcript heard so far, split into what the recogniser has finished
   * deciding and what it is still revising. Refs rather than state because
   * `onresult` fires several times a second and must read the previous value
   * synchronously — see the accumulation note in `buildRecognizer`.
   */
  const committed = useRef("");
  const interim = useRef("");
  const recognizer = useRef<SpeechRecognizer | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const [micAvailable, setMicAvailable] = useState(false);
  /** Whether this browser can recognise speech without leaving the machine. */
  const [onDevice, setOnDevice] = useState(false);
  /** Set once the on-device retry has been tried, so it cannot loop. */
  const triedLocally = useRef(false);
  /**
   * Whether the session was ended by the user rather than by the browser.
   *
   * The two need opposite handling. A session that ended because the browser
   * timed out must be restarted or dictation is silently over; one that ended
   * because the user pressed stop must not be, or the button cannot turn it off.
   */
  const stopping = useRef(false);

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

  /**
   * Close the microphone.
   *
   * `release` decides who gets it next, and the distinction matters. When the
   * USER stops or sends, the microphone is free and always-listening should have
   * it back. When dictation stopped because it FAILED, handing the microphone
   * straight back would have the other listener walk into the same failure and
   * start a loop of two consumers trading an error — so a failure keeps it, and
   * the user decides what to try next.
   */
  const closeDictation = useCallback((release: boolean) => {
    stopping.current = true;
    setDictating(false);
    setHeard("");
    const instance = recognizer.current;
    recognizer.current = null;
    try {
      instance?.stop();
    } catch {
      // `stop` throws when the recogniser never started. Nothing to report.
    }
    if (release) onReleaseMicrophone?.();
  }, [onReleaseMicrophone]);

  const stopDictation = useCallback(() => closeDictation(true), [closeDictation]);

  /**
   * The wiring every recognizer this component starts shares.
   *
   * Split out so the on-device retry below is the same recognizer with one
   * option changed, rather than a second copy that could drift from the first.
   */
  const buildRecognizer = useCallback(
    (instance: SpeechRecognizer, local: boolean): void => {
      instance.lang = navigator.language || "en-US";
      // Continuous, unlike the original. One press means "listen until I say
      // stop", not "listen to one sentence": the browser ends the session after
      // a pause regardless, and `onend` restarts it while the user still wants
      // it. See the module note.
      instance.continuous = true;
      instance.interimResults = true;
      instance.maxAlternatives = 1;
      if (local) instance.processLocally = true;

      instance.onresult = (event) => {
        /**
         * Read only what is NEW, and commit only what is FINAL.
         *
         * The obvious implementation — `transcriptFrom(event)` on every event —
         * is wrong, and wrong in a way that destroys the user's words rather
         * than merely repeating them. `event.results` is the whole result list
         * for the CURRENT recogniser session, and a session does not survive a
         * pause: the browser ends it, `onend` restarts it, and the new session's
         * list starts empty. Rewriting the field from that list therefore drops
         * everything said before the pause.
         *
         * So the transcript is accumulated forward instead. `committed` holds
         * every final result seen so far, across sessions; `interim` holds the
         * still-changing tail, which is replaced rather than appended. The field
         * shows committed + interim, and a result that later becomes final moves
         * from one to the other without being written twice.
         */
        let fresh = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const text = result?.[0]?.transcript ?? "";
          if (!text) continue;
          if (result?.isFinal) {
            committed.current = `${committed.current}${text}`.trim();
            interim.current = "";
            continue;
          }
          fresh += text;
        }
        if (fresh) interim.current = fresh;

        const spoken = `${committed.current} ${interim.current}`.trim();
        if (!spoken) return;
        setHeard(spoken);
        setValue(baseText.current ? `${baseText.current} ${spoken}` : spoken);
      };
      instance.onerror = (event) => {
        const reason = event?.error ?? "";
        // Only the first failure of a session gets a recovery attempt, and only
        // if there is a model that can serve it. Retrying on every error would
        // spin against a permission the user has already refused.
        const canRetryLocally =
          !local &&
          onDevice &&
          !triedLocally.current &&
          (reason === "network" || reason === "service-not-allowed");
        if (canRetryLocally) {
          triedLocally.current = true;
          const previous = recognizer.current;
          recognizer.current = null;
          // The aborted instance still fires `onend`, and without this flag its
          // handler would run the fall-through below and tear down the retry —
          // leaving a live recogniser that the component no longer holds a
          // reference to and can therefore never stop. The microphone would stay
          // open after navigating away.
          previous?.abort();
          setDictationNote(
            "That needed the browser's speech service. Trying the on-device model.",
          );
          const Recognition = getSpeechRecognition();
          if (Recognition) {
            const retry = new Recognition();
            buildRecognizer(retry, true);
            recognizer.current = retry;
            setDictating(true);
            try {
              retry.start();
            } catch {
              // Guarded, unlike an earlier version. `hasOnDeviceRecognition`
              // only proves the two statics exist; the model itself can still be
              // absent, and an unguarded throw from inside an error handler
              // leaves the UI claiming to listen with nothing running.
              recognizer.current = null;
              setDictating(false);
              setDictationNote(dictationFailure(reason, false));
            }
            return;
          }
        }
        const message = dictationFailure(reason, local);
        if (message) setDictationNote(message);
        // `false`: a failure keeps the microphone. Releasing it here would hand
        // it to always-listening, which would fail the same way and hand it
        // back — a loop of two consumers trading one error.
        closeDictation(false);
      };
      instance.onend = () => {
        // A session that ended on its own is restarted while the user still
        // wants to dictate. This is the difference between "it stopped after one
        // sentence" and a microphone that stays open.
        //
        // The identity check is what stops a superseded recogniser from acting:
        // the on-device retry above replaces `recognizer.current`, and the old
        // instance's onend arrives afterwards.
        if (!stopping.current && recognizer.current === instance) {
          try {
            instance.start();
            return;
          } catch {
            // Starting too soon after an end throws in Chromium. The id is
            // non-null and the user still wants to dictate, so try once more
            // shortly rather than reporting a failure that is about timing.
            window.setTimeout(() => {
              if (stopping.current || recognizer.current !== instance) return;
              try {
                instance.start();
              } catch {
                recognizer.current = null;
                setDictating(false);
                setDictationNote("Dictation stopped. Press the mic to start again.");
              }
            }, 400);
            return;
          }
        }
        // A superseded instance must not clear the live session's state. Only
        // the recogniser the component is actually holding may do that.
        if (recognizer.current !== instance) return;
        recognizer.current = null;
        setDictating(false);
        setHeard("");
        // The browser decided to stop for good — most often because it failed
        // silently. The microphone is free again, so it goes back.
        onReleaseMicrophone?.();
      };
    },
    [closeDictation, onDevice, onReleaseMicrophone],
  );

  const startDictation = useCallback(() => {
    const Recognition = getSpeechRecognition();
    if (!Recognition) return;

    // Hand over the microphone before asking for it. Framed as a callback so
    // this component does not need to know that always-listening exists.
    onTakeMicrophone?.();

    baseText.current = value;
    stopping.current = false;
    triedLocally.current = false;
    committed.current = "";
    interim.current = "";
    setDictationNote(null);
    setHeard("");

    /**
     * Ask for the microphone with the API that produces a real prompt, then let
     * it go. Failures here are named, and the recogniser's are not.
     */
    const begin = () => {
      const instance = new Recognition();
      buildRecognizer(instance, false);
      recognizer.current = instance;
      setDictating(true);
      try {
        instance.start();
      } catch {
        recognizer.current = null;
        setDictating(false);
        setDictationNote("Dictation could not start. Press the mic again.");
      }
    };

    if (typeof navigator.mediaDevices?.getUserMedia !== "function") {
      // No probe available. The recogniser is still worth trying — it may hold
      // a permission the probe API cannot see.
      begin();
      return;
    }

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        // Released immediately: the recogniser opens the microphone itself, and
        // holding both is what makes it fail with `audio-capture`.
        for (const track of stream.getTracks()) track.stop();
        begin();
      })
      .catch((error: unknown) => {
        setDictating(false);
        setDictationNote(buildDictationNote(error));
      });
  }, [buildRecognizer, onTakeMicrophone, value]);

  // A recogniser left running across an unmount keeps the microphone open.
  useEffect(() => {
    return () => {
      stopping.current = true;
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

      {/* What is being heard, while it is being heard. This is the feedback that
          turns "the mic does nothing" into "it misheard me" — the first is a bug
          to report and the second is something the user can fix by repeating
          themselves. It also makes the request audible-to-the-eye before it is
          sent, which matters when the transcript is going to a model. */}
      {dictating ? (
        <p
          aria-live="polite"
          className="absolute inset-x-4 bottom-full mb-2 truncate text-[12px] leading-relaxed font-normal text-accent"
        >
          {heard ? `Listening — “${heard}”` : "Listening…"}
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
