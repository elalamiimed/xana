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
 */
export function dictationFailure(error: string, onDevice: boolean): string {
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
      // Reached when the browser cannot recognise the page's language. Worth
      // its own sentence because the generic fallback ("Dictation stopped.")
      // gives the user nothing to act on, and the browser's language setting
      // is not somewhere they would think to look.
      return "This browser cannot recognise your language for dictation. Change the browser's language, or type instead.";
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
