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
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
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
 */
export function speak(
  text: string,
  opts: { voiceName?: string; rate?: number; pitch?: number } = {},
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
