/**
 * Both directions of speech, typed locally.
 *
 * Recognition (speech → text) is not in TypeScript's DOM lib and only
 * exists behind a `webkit` prefix in Chromium, so the minimum surface the
 * Composer needs is declared here rather than in a global `.d.ts` — nothing
 * else in the app should start assuming the API exists.
 *
 * Synthesis (text → speech) *is* in the DOM lib, but the two useful extras
 * are not: listing the installed voices, and knowing when that list has
 * actually been populated. Chromium fills it asynchronously, so an empty
 * result means "not yet", never "none" — a voice picker that got this wrong
 * would report that the machine has no voices.
 */

/* ================================================================== */
/* Recognition: speech to text                                        */
/* ================================================================== */

export interface SpeechAlternative {
  readonly transcript: string;
}

export interface SpeechResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechAlternative;
}

export interface SpeechResultList {
  readonly length: number;
  readonly [index: number]: SpeechResult;
}

export interface SpeechResultEvent {
  readonly resultIndex: number;
  readonly results: SpeechResultList;
}

export interface SpeechErrorEvent {
  readonly error: string;
}

export interface SpeechRecognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  /**
   * Recognise on the device instead of through the browser's speech service.
   *
   * An addition to the Web Speech API rather than part of it, and only honoured
   * where the browser ships an on-device model — see `hasOnDeviceRecognition`.
   * Setting it where there is no model makes `start()` fail, which is why it is
   * opt-in here rather than always on.
   */
  processLocally?: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  /**
   * Fires when the session genuinely opens.
   *
   * Worth its own handler because "called `start()`" and "the microphone is
   * open" are different moments, and on a machine where they never converge the
   * difference is the whole diagnosis. The mic-check page reports it.
   */
  onstart: (() => void) | null;
}

type RecognizerConstructor = new () => SpeechRecognizer;

/**
 * The four options every recogniser in this app is built with, in one place.
 *
 * They were written out three times — the Composer, the wake listener and the
 * microphone check — and they had already drifted: the check page left
 * `maxAlternatives` alone while the other two set it, and `processLocally` was
 * set only from the retry path. Three copies of a value that must agree is a
 * disagreement waiting to happen, and the one that matters most is `lang`: the
 * module note in `speech-language.ts` describes what a wrong language tag costs.
 *
 * The language is a PARAMETER rather than read here, because it is the one option
 * that is not a constant — it comes from the setting, the browser, and possibly
 * from a retry after the service refused the previous tag.
 */
export function configureRecognizer(
  instance: SpeechRecognizer,
  language: string,
  options: { onDevice?: boolean } = {},
): void {
  instance.lang = language;
  // Continuous, because one press means "listen until I say stop" rather than
  // "listen to one sentence". The browser ends the session after a pause
  // regardless; every caller restarts it while the user is still listening.
  instance.continuous = true;
  instance.interimResults = true;
  instance.maxAlternatives = 1;
  // Requested, never forced: setting it where the model is absent makes
  // `start()` fail outright. See `hasOnDeviceRecognition`.
  if (options.onDevice) instance.processLocally = true;
}

interface SpeechWindow {
  SpeechRecognition?: RecognizerConstructor;
  webkitSpeechRecognition?: RecognizerConstructor;
}

/**
 * Returns a recognizer factory when this browser supports dictation, or
 * null when it does not. The Composer hides the mic entirely on null — a
 * dead control is worse than no control.
 */
export function getSpeechRecognition(): RecognizerConstructor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as SpeechWindow;
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/**
 * Whether this browser can recognise speech *on the device*, without a cloud
 * round trip.
 *
 * Edge shipped an on-device model behind a flag, and the API that exposes it is
 * two static methods on the constructor rather than a per-instance option, so
 * the only honest test is their presence. Reported rather than assumed: the
 * sentence "your voice never leaves this machine" is a claim about an
 * implementation, and making it without asking would be a lie in the case where
 * the browser quietly sends the audio to a server instead.
 *
 * `processLocally` is deliberately NOT forced on. Setting it where the model is
 * absent makes recognition fail outright, and a mic that works through the
 * browser's own service is better than a mic that does nothing — so the panel
 * says which one is in use and the user decides whether that is acceptable.
 */
export function hasOnDeviceRecognition(): boolean {
  if (typeof window === "undefined") return false;
  const scope = window as unknown as SpeechWindow;
  const ctor = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  if (!ctor) return false;
  const withStatics = ctor as unknown as {
    available?: unknown;
    install?: unknown;
  };
  return typeof withStatics.available === "function" && typeof withStatics.install === "function";
}

/* ================================================================== */
/* Which engine the mic button means                                  */
/* ================================================================== */

/**
 * What pressing the microphone will do, and whether it should be there at all.
 *
 * A pure function of three facts the caller reads from the browser, because this
 * decision was made twice — once to decide whether to draw the button, once to
 * decide what the click does — and the two copies disagreed. The button was
 * drawn only where `SpeechRecognition` existed, while the click handler had a
 * branch for "no recogniser, but this machine can record": a sentence telling the
 * user to switch to the local transcriber, reachable only from a button that
 * that very branch's condition would have hidden. The local path needs no
 * `SpeechRecognition` at all — it is `MediaRecorder` and a Whisper service on
 * this machine — so a browser without the Web Speech API could dictate and was
 * offered nothing.
 *
 * `canRecord` is a parameter rather than a call to `canRecord()` so that this
 * stays a decision and not a query, and so it can be driven in a test.
 */
export interface DictationPlan {
  /** What a click will use. `"none"` means it cannot dictate here. */
  readonly engine: "local" | "browser" | "none";
  /** Whether the button should exist. A control that explains itself is worth
   *  drawing; a control that does nothing is not. */
  readonly button: boolean;
  /** Why it cannot dictate, in words a person can act on. Empty when it can. */
  readonly note: string;
}

export function planDictation(input: {
  /** Where transcription is configured to happen. */
  mode: "browser" | "local";
  /** Whether this browser exposes the Web Speech API. */
  hasRecognition: boolean;
  /** Whether this browser can record audio at all. */
  canRecord: boolean;
}): DictationPlan {
  // The setting decides first. A user who chose the local transcriber must not be
  // quietly given the browser's service just because the browser has one — that
  // choice is the whole point of the setting.
  if (input.mode === "local" && input.canRecord) {
    return { engine: "local", button: true, note: "" };
  }
  if (input.hasRecognition) {
    return { engine: "browser", button: true, note: "" };
  }
  if (input.canRecord) {
    // No Web Speech API, but this machine can record and transcribe locally. The
    // button is drawn and the click explains the one setting that would make it
    // work, rather than the app hiding the feature it has.
    return {
      engine: "none",
      button: true,
      note: "This browser has no speech recognition. Switch transcription to the local transcriber in Settings → Voice.",
    };
  }
  return { engine: "none", button: false, note: "" };
}

/* ================================================================== */
/* What a press of the microphone means                               */
/* ================================================================== */

/**
 * Whether the user is asking something or writing something.
 *
 * The only signal available from outside is whether they were already writing:
 * a microphone pressed over an **empty** box was pressed to ask a question, and
 * the first finished sentence should be sent and answered. A microphone pressed
 * over **text** was pressed to add to it, and nothing is sent until the user
 * sends it — which is what composing a long message out loud needs.
 *
 * It is one line of logic and it is here, named, because it is a *contract* and
 * not an implementation detail: it is the whole difference between the two
 * things a microphone can be for, and getting it backwards is what produced
 * "when I ask a question she does not answer it" — the app filled the box with
 * the question and waited, which is right for dictation and useless for asking.
 */
export function spokenInputMode(fieldText: string): "question" | "dictation" {
  return fieldText.trim() === "" ? "question" : "dictation";
}

/**
 * Why dictation stopped, in words a person can act on.
 *
 * This exists because the first version of the mic treated every failure as
 * nothing at all: `onerror` called `stopDictation()` and said no more, so a
 * denied permission, a browser with no speech service configured, and a
 * microphone another app was holding all looked identical — like a button that
 * does not work. None of them is the app's fault, and all of them are fixable by
 * the person sitting in front of it, so the reason is carried out to the UI
 * rather than swallowed.
 *
 * `not-allowed` and `service-not-allowed` are the two worth telling apart: the
 * first is a permission the user can grant in one click, the second usually
 * means the browser cannot reach its speech service at all (Brave, some hardened
 * Chromium builds, and anything offline).
 *
 * `language-not-supported` is the third, and it is the one this app used to cause
 * itself. The recogniser is handed `navigator.language`, this machine's browser
 * reports the bare tag `en`, the service refuses a language where it wanted a
 * locale, and the user is told to change a browser setting that was never wrong.
 * Two things changed with that: the tag is resolved before it is sent (see
 * `speech-language.ts`), and the sentence below now names the tag that was
 * refused, points at the setting that overrides it, and no longer reads as an
 * instruction to reconfigure the browser. `refusedTag` is what makes the first
 * of those possible; without it the message can only be generic, which is why it
 * is a parameter rather than a second function.
 */
export function dictationFailure(error: string, onDevice: boolean, refusedTag = ""): string {
  switch (error) {
    case "not-allowed":
    case "permission-denied":
      return "That needs microphone access. Allow it for this page, then press the mic again.";
    case "service-not-allowed":
      return "This browser will not run speech recognition. Edge or Chrome will; Brave and some hardened builds disable it.";
    case "no-speech":
      return "I did not hear anything. Press the mic and speak.";
    case "audio-capture":
      return "No microphone was found. Check that one is plugged in and not in use by another app.";
    case "language-not-supported":
      // The browser's language setting is not the thing to change, and saying so
      // was this app's least useful sentence. The tag is chosen here, and the
      // override is here too.
      return refusedTag
        ? `This browser's speech service refused the language "${refusedTag}". Set the dictation language in Settings → Voice — English (United States) is the safest choice.`
        : "This browser's speech service refused the dictation language. Set it in Settings → Voice — English (United States) is the safest choice.";
    case "bad-grammar":
    case "phrases-not-supported":
      // Not the language: the *hints* were rejected. Nothing in Xana sends a
      // grammar or a phrase list, so this means the browser or an extension is
      // substituting its own recognition configuration. Worth its own sentence
      // because every other explanation sends the user to the wrong screen.
      return "The browser rejected the recognition hints it was given. An extension may be replacing this page's speech settings — try a private window, or switch to the local transcriber.";
    case "network":
      return onDevice
        ? "The on-device model stopped. Try again."
        : "Speech recognition needs a working connection in this browser — the audio is sent to the browser's own service, not to Xana.";
    case "aborted":
      return "";
    default:
      return "Dictation stopped.";
  }
}

/**
 * Why the microphone probe failed, in words a person can act on.
 *
 * Separate from `dictationFailure` because the two APIs name the same problems
 * differently, and `getUserMedia` names them better: the recogniser reports a
 * refused microphone as `not-allowed`, which does not say whether the user
 * declined, the operating system refused, or the browser has no microphone at
 * all. `DOMException.name` does distinguish those, and this is where that
 * distinction is spent.
 *
 * The probe exists precisely so the user gets one of these sentences instead of
 * a microphone that opens and hears nothing.
 */
export function dictationNote(error: unknown): string {
  const name = error instanceof Error ? error.name : "";

  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "That needs microphone access. Allow it for this page — the icon in the address bar — then press the mic again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found. Check that one is plugged in, then press the mic again.";
    case "NotReadableError":
    case "AbortError":
      return "The microphone is in use by another app. Close it and press the mic again.";
    default:
      return "The microphone could not be opened. Press the mic to try again.";
  }
}

/** Flattens a result list into the transcript accumulated so far. */
export function transcriptFrom(event: SpeechResultEvent): string {
  let text = "";
  for (let index = 0; index < event.results.length; index += 1) {
    const result = event.results[index];
    const alternative = result?.[0];
    if (alternative) text += alternative.transcript;
  }
  return text.trim();
}

/* ================================================================== */
/* Synthesis: text to speech                                          */
/* ================================================================== */

export function speechSynthesisAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.speechSynthesis !== "undefined" &&
    typeof window.SpeechSynthesisUtterance !== "undefined"
  );
}

/**
 * The installed voices, ranked with the user's own locale first.
 *
 * Ranked rather than filtered: someone with only a non-English voice
 * installed should still get a usable picker, just with their own locale at
 * the top.
 */
export function listVoices(): SpeechSynthesisVoice[] {
  if (!speechSynthesisAvailable()) return [];
  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) return [];

  const locale = typeof navigator !== "undefined" ? navigator.language : "en";
  const base = locale.split("-")[0] ?? "en";

  return [...voices].sort((a, b) => rank(a.lang) - rank(b.lang));

  function rank(lang: string): number {
    if (lang.toLowerCase() === locale.toLowerCase()) return 0;
    if (lang.toLowerCase().startsWith(base)) return 1;
    return 2;
  }
}

/**
 * Speak a line, replacing anything already speaking.
 *
 * Replacing rather than queuing is right for an assistant: if she has said
 * something new, the previous sentence is stale, and two voices talking
 * over each other is the worst possible outcome here.
 *
 * `onDone` fires when the sentence actually stops — finished, cancelled, or
 * failed. Always-on listening needs this: a recogniser left open while the
 * speakers are playing hears the reply and can wake on her own voice, so the
 * microphone has to be shut for exactly as long as she is talking, and a timer
 * guessing the duration would either clip her or leave the mic open.
 *
 * It fires at most once, whichever of `onend` and `onerror` the browser uses.
 * Chromium fires `onend` after a cancellation, but not all builds do, and a
 * callback that never runs would leave listening paused forever.
 */
export function speak(
  text: string,
  opts: { voiceName?: string; rate?: number; pitch?: number; onDone?: () => void } = {},
): boolean {
  if (!speechSynthesisAvailable()) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  const synth = window.speechSynthesis;
  synth.cancel();

  const utterance = new window.SpeechSynthesisUtterance(trimmed);
  utterance.rate = opts.rate ?? 1;
  utterance.pitch = opts.pitch ?? 1;

  if (opts.voiceName) {
    const match = synth.getVoices().find((voice) => voice.name === opts.voiceName);
    if (match) utterance.voice = match;
  }

  if (opts.onDone) {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      opts.onDone?.();
    };
    utterance.onend = done;
    utterance.onerror = done;
  }

  synth.speak(utterance);
  return true;
}

export function stopSpeaking(): void {
  if (speechSynthesisAvailable()) window.speechSynthesis.cancel();
}

/**
 * Strip what should never be read aloud: markdown syntax and the raw card
 * payloads a reply can carry. Without this, a briefing becomes "dash,
 * energy, colon, thirty five".
 */
export function speakable(text: string): string {
  return text
    .replace(/`{1,3}[^`]*`{1,3}/g, "")
    .replace(/[*_#>~]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[-•]\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
