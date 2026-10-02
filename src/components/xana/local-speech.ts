"use client";

import { initialVad, stepVad } from "./vad";

/**
 * Recording a spoken request without the browser's speech service.
 *
 * WHY THIS EXISTS
 *
 * The browser's `SpeechRecognition` does not transcribe anything itself. In Edge
 * it sends the audio to Microsoft's speech service; in Chrome, to Google's. On a
 * network where that service is blocked — a corporate proxy, a campus firewall,
 * a hardened browser build — every recognition attempt fails with the error name
 * `network`, no matter how good the microphone is. This was diagnosed from the
 * flight recorder rather than guessed: ten consecutive `wake.error
 * reason=network` events with `micButton=true` and a session that opened every
 * time.
 *
 * The fix is not to retry harder. It is to stop asking the network. This module
 * records audio locally, decides where the sentence ends using nothing but the
 * waveform, and hands the clip to a transcriber that runs on this machine.
 *
 * WHERE THE SENTENCE ENDS
 *
 * A recording has to be stopped by something, and the browser offers no "they
 * finished talking" event. So the envelope is measured directly: an
 * `AnalyserNode` reports loudness ~60 times a second, and the sentence is deemed
 * over after sustained quiet following speech. The threshold adapts, because a
 * fixed one is either deaf in a quiet room or permanently "hearing speech" in a
 * noisy one, and a floor is kept above digital silence so a muted microphone
 * cannot hold the recorder open forever.
 *
 * NOTHING HERE IS XANA'S
 *
 * This module has no idea what a transcriber is. It returns a `Blob` and a
 * `heardSpeech` flag, so the same recorder can feed a local Whisper service, a
 * test, or nothing at all.
 */

/** How loud counts as speech, before adaptation. */
const SPEECH_FLOOR = 0.012;

/** Quiet for this long after speech ends the sentence. */
const SILENCE_MS = 850;

/**
 * Speech must last at least this long before its end is allowed to stop the clip.
 *
 * Without it the recorder is fooled by a door, a keyboard or a chair: any
 * transient that crosses the threshold starts "speech", the quiet that follows
 * immediately satisfies the silence rule, and the clip ends after a few hundred
 * milliseconds. What reaches the transcriber is then too short to contain a word,
 * which is exactly the shape of the failure this was found by — a log full of
 * `heard chars=0` and `chars=6` where the user had clearly spoken.
 *
 * 350ms is shorter than any word and longer than any click.
 */
const MIN_SPEECH_MS = 350;

/** No speech at all by now, and the attempt is abandoned. */
const NO_SPEECH_MS = 7000;

/** Hard ceiling, so a noisy room cannot record forever. */
const MAX_MS = 15000;

export interface RecordOptions {
  /** Called with a 0..1 loudness figure, for a live meter. */
  onLevel?: (level: number) => void;
  /** Called when speech is first detected, so a UI can say "go ahead". */
  onSpeechStart?: () => void;
  /** Override the defaults, for a caller that knows its environment. */
  silenceMs?: number;
  noSpeechMs?: number;
  maxMs?: number;
  /** Cooperative cancellation, checked on every frame. */
  signal?: AbortSignal;
}

export interface RecordResult {
  /** The audio, or null when nothing was heard. */
  blob: Blob | null;
  /** True when the envelope saw speech, as opposed to merely noise. */
  heardSpeech: boolean;
  /** Why it stopped, which the caller turns into a sentence. */
  ended: "silence" | "no-speech" | "max" | "cancelled" | "error";
  /** Milliseconds of audio captured, for a log. */
  durationMs: number;
  /** The failure, when `ended` is "error". */
  error?: Error;
}

/**
 * The best container this browser will give us for a short voice clip.
 *
 * Asked in order of preference rather than hardcoded, because the answer differs
 * by browser and a wrong guess makes `MediaRecorder` throw. WebM/Opus is
 * Chromium's default and is what the local service decodes with PyAV; plain WAV
 * is the fallback, since the `openai-whisper` backend refuses anything else.
 */
export function pickAudioMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      // `isTypeSupported` throws on some hardened builds. Not fatal: try the next.
    }
  }
  return "";
}

/** Whether this browser can record audio at all. */
export function canRecord(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

/* ================================================================== */
/* The transcriber, on this machine                                   */
/* ================================================================== */

/**
 * Where the local transcriber lives.
 *
 * Loopback by default, overridable because someone may run it elsewhere. The
 * port is `python/xana_stt.py`'s default and is not secret.
 */
function transcriberUrl(path: string, base?: string): string {
  const root = base ?? "http://127.0.0.1:4319";
  return `${root.replace(/\/+$/, "")}${path}`;
}

export interface TranscriberHealth {
  available: boolean;
  ready: boolean;
  backend: string;
  model: string;
  /** Why it is not ready, in the service's own words. */
  reason: string;
}

/**
 * Ask the local service whether it can transcribe.
 *
 * Answered honestly by the service — `ready:false` with a reason, rather than a
 * cheerful 200 that fails on the first real clip — which is what makes it usable
 * as a preflight. A short timeout because this runs before a user is waiting on
 * anything and a hung probe must not become a hung UI.
 */
export async function transcriberHealth(base?: string, timeoutMs = 1500): Promise<TranscriberHealth> {
  const unavailable: TranscriberHealth = {
    available: false,
    ready: false,
    backend: "none",
    model: "",
    reason: "The local transcriber is not running.",
  };
  try {
    const response = await fetch(transcriberUrl("/health", base), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return unavailable;
    const body = (await response.json()) as Partial<TranscriberHealth>;
    return {
      available: true,
      ready: body.ready === true,
      backend: typeof body.backend === "string" ? body.backend : "unknown",
      model: typeof body.model === "string" ? body.model : "",
      reason: typeof body.reason === "string" ? body.reason : "",
    };
  } catch {
    // Not running, or not reachable. Both mean the same thing to a caller.
    return unavailable;
  }
}

export interface TranscribeResult {
  text: string;
  /** Why it failed, when it did. Empty on success and on an empty transcript. */
  error: string;
}

/**
 * Ask the app to start the local transcriber, and report how it went.
 *
 * WHY THIS EXISTS AT ALL
 *
 * A browser cannot start a process, so the service that "transcribe on this
 * machine" depends on was, until now, the user's job: the app's answer to a
 * missing service was a sentence telling them to go and run `python/serve.ps1`.
 * That is the app handing back its own dependency as a chore, and it is the one
 * thing a user reasonably assumes is automatic.
 *
 * The asking goes through `/api/transcriber`, which is idempotent and
 * rate-limited on the server: it probes first, never starts a second copy of
 * something already coming up, and refuses to respawn more than once a minute.
 * So calling this on every retry — which is what the wake loop does — is safe.
 *
 * It never throws. Every outcome is a health reading plus a sentence, because
 * the caller is a microphone that has to say something either way.
 */
export async function ensureLocalTranscriber(options: { timeoutMs?: number } = {}): Promise<{
  /** True when this call is the one that started the service. */
  started: boolean;
  /** What to tell the user, or "" when there is nothing worth saying. */
  note: string;
  health: TranscriberHealth;
}> {
  const fallback = async (note: string) => ({
    started: false,
    note,
    health: await transcriberHealth(),
  });

  try {
    const response = await fetch("/api/transcriber", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
    });
    if (!response.ok) {
      return fallback(
        "The app could not start the local transcriber. Check it in Settings → Voice.",
      );
    }
    const body = (await response.json()) as {
      started?: unknown;
      note?: unknown;
      status?: Partial<TranscriberHealth>;
    };
    const status = body.status ?? {};
    return {
      started: body.started === true,
      note: typeof body.note === "string" ? body.note : "",
      health: {
        available: status.available === true,
        ready: status.ready === true,
        backend: typeof status.backend === "string" ? status.backend : "unknown",
        model: typeof status.model === "string" ? status.model : "",
        reason: typeof status.reason === "string" ? status.reason : "",
      },
    };
  } catch {
    // The route is unreachable, or the wait ran past the timeout. Either way the
    // honest answer is the service's own state, read directly.
    return fallback("");
  }
}

/**
 * Transcribe a recorded clip on this machine.
 *
 * The body is the audio itself, not a multipart form: the service takes raw
 * bytes, which keeps the request small enough to stay under the body cap and
 * avoids a parser on the other side. An empty transcript is a SUCCESS and comes
 * back as `{ text: "" }` — "I heard nothing" is a normal outcome of listening,
 * not a failure, and conflating the two makes a quiet room look like a bug.
 */
export async function transcribe(
  blob: Blob,
  options: { base?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<TranscribeResult> {
  try {
    const response = await fetch(transcriberUrl("/transcribe", options.base), {
      method: "POST",
      headers: { "content-type": blob.type || "audio/webm" },
      body: blob,
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 60000),
    });

    if (response.status === 413) {
      return { text: "", error: "That was too long to transcribe. Try a shorter request." };
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return {
        text: "",
        error: `The local transcriber refused the clip (${response.status}). ${detail.slice(0, 160)}`.trim(),
      };
    }

    const body = (await response.json()) as { text?: unknown; error?: unknown };
    if (typeof body.error === "string" && body.error) {
      // The service reports a decode failure in-band rather than as a status, so
      // an empty string plus an error means "the clip was unusable".
      return { text: "", error: body.error };
    }
    return { text: typeof body.text === "string" ? body.text.trim() : "", error: "" };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError") {
      return { text: "", error: "The local transcriber took too long. The model may still be loading." };
    }
    return {
      text: "",
      error: "Could not reach the local transcriber. Is python/serve.ps1 running?",
    };
  }
}

/**
 * Record one spoken request.
 *
 * Resolves rather than rejects, always: a caller in the middle of a conversation
 * needs to distinguish "nothing was said" from "the microphone failed", and an
 * exception carries neither. The `ended` field is the answer.
 */
export async function recordUtterance(options: RecordOptions = {}): Promise<RecordResult> {
  const silenceMs = options.silenceMs ?? SILENCE_MS;
  const noSpeechMs = options.noSpeechMs ?? NO_SPEECH_MS;
  const maxMs = options.maxMs ?? MAX_MS;

  const empty = (ended: RecordResult["ended"], error?: Error): RecordResult => ({
    blob: null,
    heardSpeech: false,
    ended,
    durationMs: 0,
    ...(error ? { error } : {}),
  });

  if (!canRecord()) {
    return empty("error", new Error("This browser cannot record audio."));
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // The processing a voice assistant wants: the noise floor is what the
        // end-of-sentence detector reads, so a rumbling fan must not be part of
        // it. Echo cancellation also stops her own voice from being recorded.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    return empty("error", error instanceof Error ? error : new Error(String(error)));
  }

  const mimeType = pickAudioMimeType();
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    return empty("error", error instanceof Error ? error : new Error(String(error)));
  }

  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const frame = new Float32Array(analyser.fftSize);

  const startedAt = Date.now();
  /** The detector's state, advanced once per frame. See `vad.ts`. */
  let vad = initialVad();
  let resolved = false;

  return await new Promise<RecordResult>((resolve) => {
    const release = () => {
      for (const track of stream.getTracks()) track.stop();
      void context.close();
      options.signal?.removeEventListener("abort", onAbort);
    };

    function finish(ended: RecordResult["ended"]): void {
      if (resolved) return;
      resolved = true;
      window.clearInterval(poll);
      release();
      const durationMs = Date.now() - startedAt;
      const stop = () => {
        const type = recorder.mimeType || mimeType || "audio/webm";
        resolve({
          blob: chunks.length > 0 ? new Blob(chunks, { type }) : null,
          heardSpeech: vad.speechAt !== null,
          ended,
          durationMs,
        });
      };
      if (recorder.state === "inactive") stop();
      else {
        recorder.onstop = stop;
        try {
          recorder.stop();
        } catch {
          stop();
        }
      }
    }

    function onAbort(): void {
      finish("cancelled");
    }

    options.signal?.addEventListener("abort", onAbort);

    try {
      recorder.start();
    } catch (error) {
      resolved = true;
      release();
      resolve(empty("error", error instanceof Error ? error : new Error(String(error))));
      return;
    }

    // 60Hz is far more than the decision needs, but it is what the display
    // wants, and one timer driving both keeps them in agreement.
    const poll = window.setInterval(() => {
      if (resolved) return;
      analyser.getFloatTimeDomainData(frame);
      let peak = 0;
      for (const sample of frame) peak = Math.max(peak, Math.abs(sample));
      options.onLevel?.(peak);

      /**
       * The decision itself lives in `vad.ts`, as a pure function.
       *
       * It is not inline here any more, and that is the point: three separate
       * bugs came out of this loop — a click taken for a word, a sentence cut
       * off by its own noise floor, and a sentence whose end was never detected
       * because the bar for "still talking" sat below the room's own noise. None
       * of them was visible by reading the code, and none could be tested while
       * the logic needed an audio device to run. `scripts/check-vad.ts` now
       * drives the exact waveforms that broke it.
       */
      const step = stepVad(
        vad,
        peak,
        Date.now(),
        { silenceMs, noSpeechMs, maxMs },
        startedAt,
      );
      vad = step.state;

      if (step.verdict.kind === "speech-started") options.onSpeechStart?.();
      else if (step.verdict.kind === "speech-ended") finish("silence");
      else if (step.verdict.kind === "no-speech") finish("no-speech");
      else if (step.verdict.kind === "too-long") finish("max");
    }, 16);
  });
}
