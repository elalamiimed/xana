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
  configureRecognizer,
  dictationFailure,
  dictationNote as buildDictationNote,
  getSpeechRecognition,
  hasOnDeviceRecognition,
  planDictation,
  spokenInputMode,
  type DictationPlan,
  type SpeechRecognizer,
} from "./speech";
import {
  browserLanguages,
  nextSpeechLanguage,
  resolveSpeechLanguage,
  speechLanguageFallbacks,
} from "./speech-language";
import { canRecord, ensureLocalTranscriber, recordUtterance, transcribe, transcriberHealth } from "./local-speech";
import { logMic } from "./mic-log";

/**
 * The single input line. Pinned to the bottom, one hairline, radius-full.
 *
 * Enter sends, Shift+Enter breaks the line. The mic is drawn wherever something
 * could actually dictate — the browser's recogniser, or this machine's own
 * transcriber — and not at all where nothing could. `planDictation` decides both,
 * because a control that does nothing is worse than no control, and a control
 * that explains itself is better than either.
 *
 * THE MICROPHONE ANSWERS
 *
 * Two things a microphone can be for, and the app now tells them apart by the
 * only signal available from outside: whether the user was already writing.
 *
 *   empty box   — the press was a question. The first finished sentence is sent,
 *                 the microphone closes, and she answers. See `asking`.
 *   text in it  — the press was dictation. Everything said is appended and
 *                 nothing is sent until the user sends it, which is what
 *                 composing a long message by voice needs.
 *
 * Before this, both cases filled the box and stopped. That is right for composing
 * and wrong for asking, and it is exactly what was reported: "when I ask a
 * question she does not answer it" — she had answered nothing, because nothing
 * had been asked.
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
 *
 * AND THEN THE LANGUAGE
 *
 * `instance.lang = navigator.language` is what produced "This browser cannot
 * recognise your language for dictation" on a machine whose owner speaks English:
 * the tag went to the speech service untouched, this profile reports the bare
 * `en`, and a service that wanted a locale refused it. The tag is now resolved
 * (`speech-language.ts`), the user can override it, and a refusal is answered by
 * trying the next tag of the same language rather than by blaming the browser.
 */

export interface ComposerHandle {
  focus: () => void;
  blur: () => void;
}

/**
 * How long to wait before starting a replacement recogniser.
 *
 * Not politeness. Chromium throws `InvalidStateError` when a new recogniser
 * starts in the same tick as the previous one ending, and `startRecognizer`
 * turns that throw into a note — so a retry started immediately would surface as
 * "Dictation could not start. Press the mic again." rather than as the attempt it
 * was meant to be. The wake listener waits for the same reason.
 */
const RETRY_DELAY_MS = 400;

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
  /**
   * Where transcription happens.
   *
   * "browser" uses the browser's own speech service, which is faster where it
   * works and needs no install. "local" records the audio and sends it to a
   * Whisper service on this machine, which is the only thing that works on a
   * network where that service is blocked — the diagnosed cause of `network`
   * errors on every attempt.
   */
  transcribe?: "browser" | "local";
  /**
   * Which language to recognise, from Settings → Voice.
   *
   * Empty means "work it out from the browser", which is the default and what
   * almost every user wants: the tag is normalised and a bare language is
   * resolved to a regional model, because a service that wants a locale will not
   * accept `en`. A non-empty value is the user overruling that inference, and it
   * is used exactly as given.
   */
  language?: string;
}

const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    onSubmit,
    busy,
    onTakeMicrophone,
    onReleaseMicrophone,
    transcribe: mode = "browser",
    language = "",
  },
  ref,
) {
  const [value, setValue] = useState("");
  const [dictating, setDictating] = useState(false);
  const [dictationNote, setDictationNote] = useState<string | null>(null);
  /** What has been heard so far in this dictation, shown so it can be judged. */
  const [heard, setHeard] = useState("");
  /** Live loudness while recording locally, for the indicator. */
  const [level, setLevel] = useState(0);
  /** The transcript that was in the field when dictation started. */
  const baseText = useRef("");
  /**
   * Whether the press that started this dictation was a QUESTION.
   *
   * The field was empty when the mic was pressed, so there is nothing to add to
   * — the user pressed a microphone and spoke, and what they want is an answer,
   * not a box with their own sentence in it. That is the difference between the
   * two things a microphone can be for, and the only signal that separates them
   * from the outside is whether the user was already writing something.
   *
   * It is also the fix for the report that produced it: "when I ask a question
   * she does not answer it". Dictation filled the field and stopped there, which
   * is exactly right for composing and exactly wrong for asking.
   */
  const asking = useRef(false);
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
  /** The last recogniser whose session actually opened, for the watchdog. */
  const opened = useRef<SpeechRecognizer | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Which engine the button means, and whether it exists.
   *
   * One value rather than a `micAvailable` boolean and an inline `if` in the
   * click handler: those were two copies of one decision, and they disagreed —
   * see `planDictation`.
   */
  const [dictation, setDictation] = useState<DictationPlan>({
    engine: "none",
    button: false,
    note: "",
  });
  /** Whether this browser can recognise speech without leaving the machine. */
  const [onDevice, setOnDevice] = useState(false);
  /** Set once the on-device retry has been tried, so it cannot loop. */
  const triedLocally = useRef(false);
  /**
   * True while the local recorder owns the microphone.
   *
   * The local path is a loop of awaited recordings, so a second entry would run
   * a second loop over the same device — transcribing every sentence twice and
   * appending it twice. Starting the service made the window between the press
   * and the loop wide enough for a double click to find it.
   */
  const localLoop = useRef(false);
  /**
   * Whether the session was ended by the user rather than by the browser.
   *
   * The two need opposite handling. A session that ended because the browser
   * timed out must be restarted or dictation is silently over; one that ended
   * because the user pressed stop must not be, or the button cannot turn it off.
   */
  const stopping = useRef(false);
  /**
   * Every language tag the service has refused in this dictation.
   *
   * State rather than a local, because a refusal arrives as an event and the
   * answer to it is another attempt: without a record of what has already
   * failed, the retry hands back the same tag and the app spins with the
   * microphone light on. See `nextSpeechLanguage`.
   */
  const triedLanguages = useRef<readonly string[]>([]);
  /** The tags worth trying after the first, decided once when dictation starts. */
  const languageLadder = useRef<readonly string[]>([]);
  /**
   * Start one more recogniser, wired for everything except the retries.
   *
   * A ref rather than a `useCallback` called directly, because the error handler
   * built below has to start the next attempt and is itself what the starter is
   * built from — the two would be a cycle. This is the same indirection as
   * `live.current` in `useWakeListener.ts`: the handler reads it when it fires,
   * so it always reaches the current function rather than the one from the render
   * that created the recogniser.
   */
  const launch = useRef<(language: string, local: boolean) => boolean>(() => false);

  /**
   * The props the recogniser's handlers need, as refs.
   *
   * A handler built when the microphone opened runs with the render that built
   * it, so `busy` and `onSubmit` would be values from several seconds ago. Both
   * are read at the moment a spoken question is sent.
   */
  const busyRef = useRef(busy);
  const onSubmitRef = useRef(onSubmit);

  useEffect(() => {
    busyRef.current = busy;
    onSubmitRef.current = onSubmit;
  }, [busy, onSubmit]);

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
    const plan = planDictation({
      mode,
      hasRecognition: getSpeechRecognition() !== null,
      canRecord: canRecord(),
    });
    setDictation(plan);
    setOnDevice(hasOnDeviceRecognition());
    // Whether the button exists at all is the first question when a user says
    // "I clicked the mic" — if this is false, there was no button to click and
    // the problem is the browser, not the recogniser.
    //
    // The resolved language is here because it is the second question, and
    // because the browser's own tags cannot be read any other way once the
    // session is over: `browser` is what the browser asked for and `lang` is
    // what will actually be sent, which is the pair that explains a refusal.
    const chosen = resolveSpeechLanguage(language, browserLanguages());
    logMic("composer.mount", {
      micButton: plan.button,
      engine: plan.engine,
      onDevice: hasOnDeviceRecognition(),
      secure: window.isSecureContext,
      lang: chosen.tag,
      langSource: chosen.source,
      browserLang: chosen.fromBrowser || navigator.language || "none",
      hasMediaDevices: typeof navigator.mediaDevices?.getUserMedia === "function",
    });
  }, [language, mode]);

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
   * Send a question that was spoken rather than typed.
   *
   * Returns whether it went. A caller that gets `false` leaves the words in the
   * field, which is the honest outcome: she is mid-reply, so there is nothing to
   * answer yet, and throwing the sentence away would be worse than keeping it.
   *
   * The props are read through refs because this is called from a recogniser's
   * event handler, which was built on an earlier render — `busy` would otherwise
   * be the value it had when the microphone opened.
   */
  const sendSpoken = useCallback((text: string): boolean => {
    const question = text.trim();
    if (!question || busyRef.current) return false;
    setValue("");
    setHeard("");
    setDictationNote(null);
    logMic("composer.ask", { chars: question.length });
    onSubmitRef.current(question, "voice");
    return true;
  }, []);

  /**
   * The wiring every recognizer this component starts shares.
   *
   * Split out so the language retry, the on-device retry and the first attempt are
   * the same recogniser with one argument changed, rather than three copies that
   * can drift — which they already had: the retry copy was missing the `try/catch`
   * around `start` that the other one had.
   *
   * `language` is a parameter rather than read from the prop, because the whole
   * point of a retry is to send a different tag than the last one.
   */
  const buildRecognizer = useCallback(
    (instance: SpeechRecognizer, local: boolean, language: string): void => {
      // Language, continuity, interim results and alternatives are set in one
      // place, shared with the wake listener and the microphone check. Handing
      // the recogniser a tag nobody resolved is what this app used to do.
      configureRecognizer(instance, language, { onDevice: local });

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
        let finalized = false;
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const text = result?.[0]?.transcript ?? "";
          if (!text) continue;
          if (result?.isFinal) {
            committed.current = `${committed.current}${text}`.trim();
            interim.current = "";
            finalized = true;
            continue;
          }
          fresh += text;
        }
        if (fresh) interim.current = fresh;

        const spoken = `${committed.current} ${interim.current}`.trim();
        if (!spoken) return;
        setHeard(spoken);
        setValue(baseText.current ? `${baseText.current} ${spoken}` : spoken);

        /**
         * The first FINISHED sentence answers a question that was spoken.
         *
         * A final result is the recogniser's own judgement that the speaker
         * stopped — the same signal the wake listener acts on — so it is the
         * closest thing the browser engine has to the local engine's
         * end-of-sentence detector. See `asking`: this only happens when the
         * field was empty when the microphone was pressed, which is the
         * difference between asking something and dictating into a draft.
         */
        if (finalized && asking.current && sendSpoken(committed.current)) {
          closeDictation(true);
        }
      };
      instance.onstart = () => {
        logMic("composer.session.open", { local });
        opened.current = instance;
        if (openTimer.current) {
          clearTimeout(openTimer.current);
          openTimer.current = null;
        }
      };
      instance.onerror = (event) => {
        const reason = event?.error ?? "";
        logMic("composer.error", { reason, local, lang: language });
        if (openTimer.current) {
          clearTimeout(openTimer.current);
          openTimer.current = null;
        }

        /**
         * Start the next attempt, after the delay this API needs.
         *
         * The `stopping` check is what makes the delay safe: a user who presses
         * the mic to stop during those milliseconds must not have a recogniser
         * opened behind them.
         */
        const retrySoon = (next: () => void) => {
          window.setTimeout(() => {
            if (stopping.current) return;
            next();
          }, RETRY_DELAY_MS);
        };

        /**
         * The service refused the language, so try another tag of the SAME
         * language before saying anything to the user.
         *
         * This is the reported failure's second line of defence. The first is
         * not sending a bare language tag at all (see `speech-language.ts`), but
         * an inference can still be wrong, and when it is, the wrong value came
         * from this app — so correcting it is this app's job rather than a
         * sentence telling the user to go and change their browser's language.
         *
         * The abort is load-bearing for the same reason as the on-device retry
         * below: the superseded recogniser fires `onend` afterwards, and without
         * the identity check in that handler it would tear down the attempt that
         * replaced it and leave a live microphone the component cannot stop.
         */
        if (reason === "language-not-supported") {
          const next = nextSpeechLanguage(triedLanguages.current, languageLadder.current);
          if (next) {
            triedLanguages.current = [...triedLanguages.current, next];
            logMic("composer.language.retry", { from: language, to: next });
            const previous = recognizer.current;
            recognizer.current = null;
            previous?.abort();
            setDictationNote(`The browser would not recognise “${language}”. Trying ${next}.`);
            retrySoon(() => {
              launch.current(next, local);
            });
            return;
          }
        }

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
          retrySoon(() => {
            if (launch.current(language, true)) return;
            // `hasOnDeviceRecognition` only proves the two statics exist; the
            // model itself can still be absent, and this is what that looks like.
            setDictationNote(dictationFailure(reason, false, language));
            closeDictation(false);
          });
          return;
        }
        const message = dictationFailure(reason, local, language);
        if (message) setDictationNote(message);
        // `false`: a failure keeps the microphone. Releasing it here would hand
        // it to always-listening, which would fail the same way and hand it
        // back — a loop of two consumers trading one error.
        closeDictation(false);
      };
      instance.onend = () => {
        logMic("composer.end", { stopping: stopping.current, current: recognizer.current === instance });
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
    [closeDictation, onDevice, onReleaseMicrophone, sendSpoken],
  );

  /**
   * Build, start and watch one recogniser.
   *
   * Every attempt goes through here — the first, the language retry, and the
   * on-device retry — because they differ only in which tag and which engine they
   * ask for. They used to be three copies of the same twelve lines, and the
   * copies had already drifted: only the first one armed the watchdog for the
   * silent case, so an attempt that started and never opened left the button lit
   * with nothing behind it. That is the one failure this component otherwise
   * cannot report, because it produces neither a result nor an error.
   *
   * Returns whether the attempt is now running. A caller that needs to say
   * something when there is nothing to launch reads that rather than guessing.
   */
  const startRecognizer = useCallback(
    (language: string, local: boolean): boolean => {
      const Recognition = getSpeechRecognition();
      if (!Recognition) return false;

      const instance = new Recognition();
      buildRecognizer(instance, local, language);
      recognizer.current = instance;
      setDictating(true);
      try {
        instance.start();
        logMic("composer.start", { continuous: instance.continuous, lang: language, local });
      } catch (error) {
        // Guarded, unlike an earlier version of the retry. `hasOnDeviceRecognition`
        // only proves the two statics exist; the model itself can still be
        // absent, and an unguarded throw from inside an error handler leaves the
        // UI claiming to listen with nothing running.
        logMic("composer.start.threw", { name: error instanceof Error ? error.name : "unknown" });
        recognizer.current = null;
        setDictating(false);
        setDictationNote("Dictation could not start. Press the mic again.");
        return false;
      }

      /**
       * The watchdog for the silent case.
       *
       * A recogniser can start and never open: no error, no event, no `onend`,
       * and the microphone indicator stays lit while the field stays empty. Five
       * seconds is long enough for a slow service and short enough that a user
       * does not conclude the button is dead.
       */
      if (openTimer.current) clearTimeout(openTimer.current);
      openTimer.current = setTimeout(() => {
        openTimer.current = null;
        if (stopping.current || recognizer.current !== instance) return;
        if (opened.current === instance) return; // It did open; it is just quiet.
        logMic("composer.never-opened", { lang: language, local });
        recognizer.current = null;
        try {
          instance.abort();
        } catch {
          // Never opened, so there is nothing to abort.
        }
        setDictating(false);
        setDictationNote(
          "The microphone did not open. The browser may be blocked from its speech service, or the device may be held by another app.",
        );
      }, 5000);

      return true;
    },
    [buildRecognizer],
  );

  // The error handler above reaches the starter through this, so a retry always
  // calls the current one rather than the one captured when the recogniser was
  // built.
  useEffect(() => {
    launch.current = startRecognizer;
  }, [startRecognizer]);

  /**
   * Dictation through the local transcriber.
   *
   * A loop rather than a single recording, so it behaves like the browser path
   * from the user's side: press once, keep talking, pause between sentences. Each
   * pass records one utterance — the end found by the waveform, not by a timer —
   * sends it to the machine, and appends what came back.
   *
   * The microphone is released between passes, which is deliberate: holding it
   * across a transcription would keep the indicator lit while nothing is being
   * listened to, and would block the local model from ever being the only thing
   * using the device.
   */
  const startLocalDictation = useCallback(async () => {
    /**
     * One recorder at a time.
     *
     * The service may need twenty seconds to load its model, and the microphone
     * button stays live throughout — so a second press used to be able to start a
     * second loop, and two loops transcribe the same sentence twice and append it
     * twice. The window was always there; starting a service made it wide.
     */
    if (localLoop.current) return;
    localLoop.current = true;

    try {
      let health = await transcriberHealth();
      if (!health.ready) {
        /**
         * The service is the app's dependency, not the user's errand.
         *
         * A browser cannot start a process, so the app asks the server to — see
         * `/api/transcriber`. It is idempotent and rate-limited, so this is not
         * a retry loop dressed up: it is one request that either finds the
         * service running, starts it, or explains why it cannot.
         */
        logMic("composer.local.start", { available: health.available, ready: health.ready });
        setDictationNote("Starting the local transcriber… the first run loads the model.");
        const ensured = await ensureLocalTranscriber();
        health = ensured.health;
        if (stopping.current) return;
        if (!health.ready && ensured.note) {
          logMic("composer.local.start.fail", { note: ensured.note.slice(0, 90) });
          setDictationNote(ensured.note);
          return;
        }
      }

      logMic("composer.local.health", { available: health.available, ready: health.ready, backend: health.backend });
      if (!health.ready) {
        setDictationNote(
          health.available
            ? `The local transcriber is running but not ready. ${health.reason}`
            : "The local transcriber is not running, and could not be started. Its log is data/stt.log — or switch transcription back to the browser in Settings → Voice.",
        );
        return;
      }

      setDictating(true);
      setDictationNote(null);

      while (!stopping.current) {
        const clip = await recordUtterance({
          onLevel: (level) => setLevel(level),
          onSpeechStart: () => setHeard(""),
        });
        if (stopping.current) break;

        if (clip.ended === "cancelled") break;
        if (clip.ended === "error") {
          logMic("composer.local.record.fail", { name: clip.error?.name ?? "unknown" });
          setDictationNote(buildDictationNote(clip.error));
          break;
        }
        if (!clip.blob || !clip.heardSpeech) {
          // The end of the sentence is also the end of this utterance's attempt:
          // in a hands-free loop that is the moment a person expects the field to
          // keep what it has and wait, so the loop continues; but a single press
          // with nothing said should say so rather than sit silently.
          logMic("composer.local.heard-nothing", { ended: clip.ended });
          if (clip.ended === "no-speech" && !committed.current) {
            setDictationNote("I did not hear anything. Press the mic and speak.");
            break;
          }
          continue;
        }

        logMic("composer.local.clip", { bytes: clip.blob.size, ms: clip.durationMs, type: clip.blob.type });
        setHeard("…");
        const result = await transcribe(clip.blob);
        if (stopping.current) break;

        if (result.error) {
          logMic("composer.local.transcribe.fail", { error: result.error.slice(0, 80) });
          setDictationNote(result.error);
          break;
        }
        const text = result.text.trim();
        if (!text) {
          logMic("composer.local.empty-transcript");
          continue;
        }

        // Append across passes, the same way a session boundary is handled in the
        // browser path: what was said in an earlier utterance survives this one.
        committed.current = committed.current ? `${committed.current} ${text}` : text;
        const spoken = committed.current;
        setHeard(spoken);
        setValue(baseText.current ? `${baseText.current} ${spoken}` : spoken);

        /**
         * A press with an empty box was a question, and it is answered here.
         *
         * The end of the sentence is the signal, and the local engine is the one
         * that genuinely knows where the sentence ended: the waveform went quiet
         * for most of a second after speech. So the answer is sent, the
         * microphone is closed, and the user is not left holding a transcription
         * of their own question wondering why nothing happened.
         */
        if (asking.current && sendSpoken(spoken)) {
          committed.current = "";
          break;
        }
      }
    } finally {
      localLoop.current = false;
      setLevel(0);
      setDictating(false);
      setHeard("");
      onReleaseMicrophone?.();
    }
  }, [onReleaseMicrophone, sendSpoken]);

  const startDictation = useCallback(() => {
    /**
     * Which path, decided in one place — the same function that decides whether
     * the button exists, so the two cannot disagree again.
     *
     * The local path is asked for first when the setting says so. It is not tried
     * "if the browser fails", because the browser's failure is `network` — a
     * blocked service — and by the time that is known the user has already
     * spoken into a void.
     */
    const plan = planDictation({
      mode,
      hasRecognition: getSpeechRecognition() !== null,
      canRecord: canRecord(),
    });
    logMic("composer.mic.click", { path: plan.engine });

    if (plan.engine === "local") {
      onTakeMicrophone?.();
      baseText.current = value;
      // An empty box means the user pressed a microphone to ask something, not
      // to write something. See `asking` and `spokenInputMode`.
      asking.current = spokenInputMode(value) === "question";
      stopping.current = false;
      committed.current = "";
      interim.current = "";
      setDictationNote(null);
      setHeard("");
      void startLocalDictation();
      return;
    }

    if (plan.engine === "none") {
      // Either nothing here can dictate, or only the local path could and the
      // setting points at the browser. In the second case the note says which
      // setting, because that is a fix the user can make in one click.
      if (plan.note) setDictationNote(plan.note);
      return;
    }

    const Recognition = getSpeechRecognition();
    if (!Recognition) return;

    // Hand over the microphone before asking for it. Framed as a callback so
    // this component does not need to know that always-listening exists.
    onTakeMicrophone?.();

    baseText.current = value;
    // See the local path above: empty box, spoken question, answer.
    asking.current = spokenInputMode(value) === "question";
    stopping.current = false;
    triedLocally.current = false;
    committed.current = "";
    interim.current = "";
    setDictationNote(null);
    setHeard("");

    /**
     * Which language tag to send, decided once per dictation.
     *
     * `resolveSpeechLanguage` prefers the setting, then the browser's own
     * preference with a bare language resolved to a regional model — the bare
     * `en` this machine reports is exactly what the speech service refuses — and
     * falls back to `en-US` when the browser will not name a language at all.
     * The ladder is what a refusal then walks: other regional variants of the
     * SAME language, never a different one, because answering in a language the
     * user did not choose produces confident nonsense that reads as a bad
     * microphone rather than as a refusal.
     */
    const chosen = resolveSpeechLanguage(language, browserLanguages());
    const ladder = speechLanguageFallbacks(chosen);
    triedLanguages.current = [chosen.tag];
    languageLadder.current = ladder;
    // The tag and its provenance, because "what language was actually sent" is
    // the first question for this class of failure and the flight recorder is
    // the only place the answer survives the session.
    logMic("composer.language", {
      tag: chosen.tag,
      source: chosen.source,
      browser: chosen.fromBrowser || "none",
      fallbacks: ladder.length,
    });

    /**
     * Ask for the microphone with the API that produces a real prompt, then let
     * it go. Failures here are named, and the recogniser's are not.
     */
    const begin = () => {
      startRecognizer(chosen.tag, false);
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
        const tracks = stream.getAudioTracks();
        logMic("composer.gum.ok", {
          tracks: tracks.length,
          // The device label is the single most useful fact when the answer is
          // "it opened and heard nothing" — a virtual voice-changer driver is a
          // very different problem from a muted headset.
          label: tracks[0]?.label ?? "unlabelled",
        });
        // Released immediately: the recogniser opens the microphone itself, and
        // holding both is what makes it fail with `audio-capture`.
        for (const track of stream.getTracks()) track.stop();
        begin();
      })
      .catch((error: unknown) => {
        logMic("composer.gum.fail", {
          name: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message : String(error),
        });
        setDictating(false);
        setDictationNote(buildDictationNote(error));
      });
  }, [language, mode, onTakeMicrophone, startLocalDictation, startRecognizer, value]);

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
          {heard ? `Listening — “${heard}”` : asking.current ? "Listening — ask your question" : "Listening…"}
        </p>
      ) : null}

      {/* The loudness meter, only while recording locally.
          It answers the question a silent microphone otherwise leaves open —
          "is this thing hearing me at all?" — and it is the same envelope the
          end-of-sentence detector uses, so what it shows is what the recorder
          believes. A bar that never moves means the device is not passing audio,
          which is a different problem from transcription being wrong. */}
      {dictating && mode === "local" ? (
        <div
          aria-hidden="true"
          className="absolute inset-x-4 bottom-full mb-0 h-[2px] overflow-hidden rounded-full bg-surface-2"
          style={{ transform: heard ? "translateY(-1.6rem)" : undefined }}
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-75"
            style={{ width: `${Math.min(100, Math.round(level * 400))}%` }}
          />
        </div>
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

      {dictation.button ? (
        <button
          type="button"
          onClick={() => (dictating ? stopDictation() : startDictation())}
          aria-pressed={dictating}
          aria-label={dictating ? "Stop listening" : "Ask by voice"}
          title={
            dictating
              ? "Stop listening"
              : "Ask by voice — with an empty box she answers what you say; with text in it, she adds to it"
          }
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
