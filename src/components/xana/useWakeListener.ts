"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { SpeechRecognizer } from "./speech";
import { logMic } from "./mic-log";
import { recordUtterance, transcribe, transcriberHealth } from "./local-speech";
import {
  endFromError,
  matchWake,
  parseWakePhrases,
  planRestart,
  type WakeEnd,
} from "./wake-word";

/**
 * Always-listening for her name.
 *
 * WHAT THIS IS UP AGAINST
 *
 * The browser will not keep a recogniser open. `continuous = true` is a hint,
 * not a guarantee: Chromium ends the session after a few seconds of silence,
 * after an utterance, and sometimes for no stated reason at all. So the loop is
 * the feature — a recogniser restarted whenever it ends, with the ends that mean
 * "stop" told apart from the ends that mean "carry on". That policy is
 * `planRestart`, in `wake-word.ts`, where it can be tested without a browser.
 *
 * THE TWO STATES
 *
 *   armed     — watching for the name. The recogniser is the browser's, so what
 *               leaves this machine is the browser's business and not Xana's;
 *               the only thing read out of it here is whether the name appeared.
 *   listening — the name was heard, and whatever is said next is the request.
 *
 * ECHO
 *
 * She speaks her replies aloud. A recogniser left running while the speakers are
 * playing will hear her and wake on her own voice, which is a loop that ends in
 * her talking to herself. So `paused` is not an optimisation: the recogniser is
 * aborted and not restarted while she is speaking or composing, and the loop
 * resumes when she stops.
 *
 * WHY THE COMMAND IS RE-ANCHORED
 *
 * One recogniser session accumulates results: after "Xana, what's the weather"
 * the list still holds that sentence when the next one arrives. Reading the
 * request from the start of the transcript would re-send an old one, so `anchor`
 * records how much of the transcript belonged to the previous wake and only what
 * follows it is treated as the request.
 */

/** How long a request is waited for after the name is heard. */
const COMMAND_WINDOW_MS = 9000;

/**
 * How long a partial request is left alone before it is taken as complete.
 *
 * Chromium marks a result final only when it decides the speaker stopped, which
 * can be a second or more after they did. Waiting for that makes the feature
 * feel slow; acting on the partial text immediately truncates anyone who pauses
 * mid-sentence. This is the compromise — short enough to feel immediate, long
 * enough to survive a breath.
 */
const SETTLE_MS = 1100;

/** After a request is sent, ignore results for this long. */
const COOLDOWN_MS = 1200;

export type WakeState = "off" | "starting" | "armed" | "listening" | "paused" | "failed";

export interface WakeListenerOptions {
  enabled: boolean;
  /** Comma-separated ways of saying her name. Empty means the built-in list. */
  phrases: string;
  /** True while she is composing a reply or speaking one. */
  paused: boolean;
  /**
   * Where the words come from.
   *
   * "browser" watches her name with the browser's speech service, which is what
   * the recogniser below is for. "local" records each utterance and transcribes
   * it on this machine, which is the only version that works when that service
   * is blocked — the diagnosed cause of every `network` failure.
   */
  transcribe: "browser" | "local";
  /** Called with a request heard without a button press. */
  onSubmit: (text: string) => void;
}

export interface WakeListener {
  state: WakeState;
  /** What to tell the user, or an empty string when there is nothing to say. */
  note: string;
  /** True while the microphone is genuinely open. */
  active: boolean;
  /** The request being heard, for display while it is still being assembled. */
  draft: string;
  /** Restart after the user has changed something. */
  retry: () => void;
  /**
   * Let go of the microphone RIGHT NOW, and stay off it.
   *
   * Synchronous on purpose. The mic button has to take the microphone before it
   * asks for it, and the first version of this did that by saving
   * `wakeEnabled: false` through the settings API — a network round trip used as
   * a side effect of pressing a button, arriving long after `startDictation` had
   * already called `getUserMedia`. The events race, and the loser is the
   * recogniser the user actually asked for.
   *
   * The hold is not released until the caller says so, so a restart timer that
   * was already pending cannot grab the microphone back mid-dictation.
   */
  stop: () => void;
  /** Release the hold and start watching again. */
  resume: () => void;
}

/**
 * The recogniser constructor, or null.
 *
 * Declared here rather than imported so this hook's dependency on the browser
 * API is visible in the file that uses it, and so `speech.ts` stays the module
 * for the one-shot dictation path.
 */
function getWakeRecognition(): (new () => SpeechRecognizer) | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognizer;
    webkitSpeechRecognition?: new () => SpeechRecognizer;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export function useWakeListener({
  enabled,
  phrases,
  paused,
  transcribe: mode,
  onSubmit,
}: WakeListenerOptions): WakeListener {
  const [state, setState] = useState<WakeState>("off");
  const [note, setNote] = useState("");
  const [draft, setDraft] = useState("");

  const recognizer = useRef<SpeechRecognizer | null>(null);
  const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const windowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Consecutive transient failures, for the backoff policy. */
  const failures = useRef(0);
  /** How much of the current transcript belonged to the previous wake. */
  const anchor = useRef(0);
  /** Set while a request is being assembled, so the name is not required twice. */
  const capturing = useRef(false);
  const cooldownUntil = useRef(0);
  /** The latest partial request, held outside state so timers can read it. */
  const lastHeard = useRef("");
  /**
   * Set while something else owns the microphone.
   *
   * Distinct from React state because the restart timers read it, and they run
   * outside the render cycle — a state variable would be a render behind and
   * would let a pending restart open the microphone during dictation.
   */
  const held = useRef(false);

  const phraseList = useMemo(() => parseWakePhrases(phrases), [phrases]);

  /**
   * The values the callbacks read at the moment they fire.
   *
   * React state would be stale inside a recogniser created several restarts ago,
   * and re-creating the recogniser on every render would drop the audio being
   * heard. Refs are refreshed in an effect, so the callbacks always see current
   * values without the recogniser's identity depending on them.
   */
  const live = useRef({ paused, onSubmit, phraseList });

  /**
   * The local loop's cancel handle.
   *
   * Separate from `recognizer` because the two engines are stopped differently:
   * a recogniser has `abort()`, whereas the local loop is a sequence of awaited
   * recordings that has to be told to stop between passes.
   */
  const localStop = useRef(false);

  /**
   * Submit a request heard by the local loop, with the same cooldown as the
   * other engine. Declared before the loop that calls it.
   */
  const submitLocal = useCallback((text: string) => {
    const command = text.trim();
    cooldownUntil.current = Date.now() + COOLDOWN_MS;
    setDraft("");
    if (!command) return;
    logMic("wake.local.submit", { chars: command.length });
    setNote("");
    live.current.onSubmit(command);
  }, []);

  /**
   * Watch for her name on this machine.
   *
   * A loop of one-utterance recordings, each transcribed locally, each checked
   * against the wake word. Slower than the browser's service when that service
   * works — a second or so per utterance on CPU — but it is the only version
   * that works where that service is blocked, and it never sends audio anywhere.
   *
   * The common case is handled in one pass: "Xana, what's the weather" arrives as
   * a single utterance, matches, and carries its own command. When the name
   * arrives alone, the next utterance is taken as the request without needing the
   * name again — which is what makes the window between the two feel natural.
   */
  const runLocalLoop = useCallback(async () => {
    const health = await transcriberHealth();
    logMic("wake.local.health", { available: health.available, ready: health.ready, backend: health.backend });
    if (!health.ready) {
      setState("failed");
      setNote(
        health.available
          ? `The local transcriber is running but not ready. ${health.reason}`
          : "Always-listening needs a transcriber. Start the local one with python/serve.ps1, or switch transcription back to the browser in Settings → Voice.",
      );
      return;
    }

    setNote("");
    setState("armed");
    /** Set in one pass when the name arrives without a request after it. */
    let awaitingCommand = false;

    while (!localStop.current && enabled) {
      if (live.current.paused) {
        setState("paused");
        return;
      }

      const clip = await recordUtterance({ silenceMs: awaitingCommand ? 1100 : 700, noSpeechMs: 9000 });
      if (localStop.current || !enabled) return;

      if (clip.ended === "error") {
        logMic("wake.local.record.fail", { name: clip.error?.name ?? "unknown" });
        setState("failed");
        setNote("The microphone could not be opened for always-listening.");
        return;
      }
      if (clip.ended === "cancelled") return;
      if (!clip.blob || !clip.heardSpeech) {
        // A quiet stretch is the normal state of a room, not a failure.
        continue;
      }

      setState("listening");
      const result = await transcribe(clip.blob);
      if (localStop.current || !enabled) return;
      if (result.error) {
        logMic("wake.local.transcribe.fail", { error: result.error.slice(0, 80) });
        setState("failed");
        setNote(result.error);
        return;
      }
      const said = result.text.trim();
      logMic("wake.local.heard", { chars: said.length, awaiting: awaitingCommand });
      if (!said) {
        setState("armed");
        continue;
      }

      const match = matchWake(said, live.current.phraseList);
      logMic("wake.local.match", { matched: match.matched, heard: match.heard });

      if (!match.matched) {
        if (awaitingCommand) {
          // The name was heard on its own and this is the request.
          awaitingCommand = false;
          submitLocal(said);
          setState("armed");
        } else {
          // Ordinary conversation. Nothing is done with it, and it is not stored.
          setState("armed");
        }
        continue;
      }

      if (match.command) {
        submitLocal(match.command);
        setState("armed");
      } else {
        // The name alone. Take the next thing said as the request.
        awaitingCommand = true;
        setDraft("");
        setState("listening");
      }
    }
  }, [enabled, submitLocal]);

  const clearTimers = useCallback(() => {
    for (const timer of [restartTimer, settleTimer, windowTimer]) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const endCapture = useCallback(() => {
    capturing.current = false;
    anchor.current = 0;
    lastHeard.current = "";
    setDraft("");
    if (settleTimer.current) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    if (windowTimer.current) {
      clearTimeout(windowTimer.current);
      windowTimer.current = null;
    }
    setState((current) => (current === "listening" ? "armed" : current));
  }, []);

  const submit = useCallback(
    (text: string) => {
      const command = text.trim();
      endCapture();
      cooldownUntil.current = Date.now() + COOLDOWN_MS;
      if (!command) return;
      setNote("");
      live.current.onSubmit(command);
    },
    [endCapture],
  );

  const stop = useCallback(() => {
    localStop.current = true;
    clearTimers();
    const instance = recognizer.current;
    recognizer.current = null;
    capturing.current = false;
    lastHeard.current = "";
    try {
      instance?.abort();
    } catch {
      // `abort` throws when the recogniser never started. Nothing to recover
      // from, and nothing worth telling the user about.
    }
  }, [clearTimers]);

  /**
   * Start one recogniser and wire it to the restart policy.
   *
   * `retry` clears the failure count, which is what the user's "try again"
   * means. Called from inside its own `onend` handler, so its identity has to be
   * stable across renders — a new identity each render would leave the running
   * recogniser pointing at a stale copy.
   */
  const start = useCallback(
    (retry = false) => {
      const Recognition = getWakeRecognition();
      if (!Recognition) {
        setState("failed");
        setNote("This browser cannot watch for her name. The mic button and typing still work.");
        return;
      }
      // Something else owns the microphone, or this listener already does.
      // Starting a second recogniser would throw and the throw is swallowed, so
      // the symptom would be a listener that silently stops working — the exact
      // bug class this whole feature is written against.
      if (held.current || recognizer.current) return;
      if (retry) failures.current = 0;

      clearTimers();

      const instance = new Recognition();
      instance.lang = navigator.language || "en-US";
      // Requested even though it is not honoured, because where it IS honoured
      // the listener survives several sentences instead of one.
      instance.continuous = true;
      instance.interimResults = true;
      instance.maxAlternatives = 1;

      let handledByError = false;

      /**
       * What happens when a session ends. Every ending goes through the policy,
       * because the difference between "silence, start again" and "permission
       * refused, stop asking" is the whole of whether this feature is bearable.
       */
      const handleEnd = (kind: WakeEnd) => {
        const decision = planRestart(kind, failures.current);
        if (kind === "error-other") failures.current += 1;
        else if (kind === "silence") failures.current = 0;
        logMic("wake.end", {
          kind,
          failures: failures.current,
          restart: decision.restart,
          delay: decision.delayMs,
        });

        if (!decision.restart) {
          setState(kind === "stopped" ? "off" : "failed");
          if (decision.note) setNote(decision.note);
          return;
        }
        if (decision.note) setNote(decision.note);
        restartTimer.current = setTimeout(() => {
          restartTimer.current = null;
          // While she is speaking, or while dictation holds the microphone, the
          // loop stays down. Only the effects below bring it back.
          if (live.current.paused || held.current) {
            setState(held.current ? "off" : "paused");
            return;
          }
          start();
        }, decision.delayMs);
      };

      instance.onstart = () => {
        // The moment that separates "start() was called" from "the microphone is
        // open". On a machine where those two never converge, this is the whole
        // diagnosis, and its absence is as informative as the event itself.
        logMic("wake.session.open");
      };

      instance.onresult = (event) => {
        if (Date.now() < cooldownUntil.current) {
          logMic("wake.result.cooldown");
          return;
        }
        // Hearing her own reply is the one failure that makes the loop
        // unusable, so results are dropped outright while she is speaking.
        if (live.current.paused) {
          logMic("wake.result.paused");
          return;
        }

        let transcript = "";
        let finals = 0;
        for (let index = 0; index < event.results.length; index += 1) {
          transcript += event.results[index]?.[0]?.transcript ?? "";
          if (event.results[index]?.isFinal) finals += 1;
        }
        transcript = transcript.trim();
        logMic("wake.result", {
          // Length, never the words.
          chars: transcript.length,
          results: event.results.length,
          finals,
          capturing: capturing.current,
        });
        if (!transcript) return;

        if (!capturing.current) {
          const match = matchWake(transcript, live.current.phraseList);
          logMic("wake.match", { matched: match.matched, heard: match.heard, chars: match.command.length });
          if (!match.matched) return;
          capturing.current = true;
          // Everything before the request belonged to the previous wake.
          anchor.current = Math.max(0, transcript.length - match.command.length);
          setState("listening");
          windowTimer.current = setTimeout(() => {
            windowTimer.current = null;
            // Nothing usable arrived. Go back to watching rather than staying
            // open indefinitely: a listener stuck in "listening" holds the
            // microphone and looks like it is waiting for a request that is
            // never coming.
            const pending = lastHeard.current.trim();
            lastHeard.current = "";
            if (pending) submit(pending);
            else endCapture();
          }, COMMAND_WINDOW_MS);
        }

        const command = transcript.slice(anchor.current).trim();
        lastHeard.current = command;
        setDraft(command);

        const latest = event.results[event.results.length - 1];
        if ((latest?.isFinal ?? false) && command) {
          submit(command);
          return;
        }
        // A partial is not a request yet, but one that stops changing is.
        if (settleTimer.current) clearTimeout(settleTimer.current);
        settleTimer.current = setTimeout(() => {
          settleTimer.current = null;
          const settled = lastHeard.current.trim();
          lastHeard.current = "";
          if (settled) submit(settled);
          else endCapture();
        }, SETTLE_MS);
      };

      instance.onerror = (event) => {
        const reason = event?.error ?? "";
        const kind = endFromError(reason);
        logMic("wake.error", { reason, kind });
        if (kind === "silence") return; // `onend` follows and handles it.
        handledByError = true;
        recognizer.current = null;
        handleEnd(kind);
      };

      instance.onend = () => {
        logMic("wake.onend", { handled: handledByError, held: held.current, paused: live.current.paused });
        if (handledByError) return;
        recognizer.current = null;
        // An end with no error is the ordinary end of a session: silence, a
        // finished utterance, or the browser's own timeout. All of them mean
        // "start again".
        handleEnd("silence");
      };

      recognizer.current = instance;
      setNote("");
      setState("starting");
      logMic("wake.start");
      try {
        instance.start();
      } catch (error) {
        // `start()` throws when a recogniser is already running. That is a race
        // between the restart timer and a late `onend`, not a failure worth
        // surfacing — the running recogniser is already doing the job.
        logMic("wake.start.threw", {
          name: error instanceof Error ? error.name : "unknown",
          held: held.current,
        });
        recognizer.current = null;
      }
    },
    [clearTimers, endCapture, submit],
  );

  // Keep the callbacks' view of the world current.
  useEffect(() => {
    live.current = { paused, onSubmit, phraseList };
  }, [paused, onSubmit, phraseList]);

  /**
   * The switch.
   *
   * Keyed on `enabled` alone. Tearing the recogniser down and rebuilding it
   * whenever the settings object changed identity caused audible dropouts — a
   * save in another panel was enough to cut the microphone mid-sentence.
   */
  useEffect(() => {
    if (!enabled) {
      logMic("wake.off");
      stop();
      setState("off");
      setNote("");
      setDraft("");
      return stop;
    }

    /**
     * The local engine, when it is the selected one.
     *
     * It does not need `SpeechRecognition` at all — that API exists only to
     * reach the browser's speech service, and the whole reason for this path is
     * that the service is unreachable. So the usual capability check is skipped
     * rather than allowed to reject a browser that could otherwise do the job
     * perfectly well without it.
     */
    if (mode === "local") {
      logMic("wake.on", { engine: "local", phrases: phraseList.join("|") });
      localStop.current = false;
      void runLocalLoop();
      return stop;
    }

    const hasApi = getWakeRecognition() !== null;
    logMic("wake.on", {
      engine: "browser",
      api: hasApi,
      phrases: phraseList.join("|"),
      lang: typeof navigator !== "undefined" ? navigator.language : "none",
      secure: typeof window !== "undefined" ? window.isSecureContext : false,
    });
    if (!hasApi) {
      setState("failed");
      setNote("This browser cannot watch for her name. The mic button and typing still work.");
      return;
    }
    failures.current = 0;
    start();
    return stop;
  }, [enabled, mode, runLocalLoop, start, stop]);

  /**
   * Pause while she speaks, resume when she stops.
   *
   * Reads `paused` only, and restarts unconditionally when it goes false: the
   * restart is a no-op if a session is already running, because `start()`
   * throws on an already-started recogniser and that throw is swallowed.
   */
  useEffect(() => {
    if (!enabled || mode === "local") return;
    if (paused) {
      stop();
      setState("paused");
      return;
    }
    failures.current = 0;
    start();
  }, [paused, enabled, mode, start, stop]);

  // A recogniser left open after unmount keeps the microphone indicator on.
  useEffect(() => stop, [stop]);

  const retry = useCallback(() => {
    if (mode === "local") {
      localStop.current = false;
      void runLocalLoop();
      return;
    }
    start(true);
  }, [mode, runLocalLoop, start]);

  /**
   * Hand the microphone over, synchronously and completely.
   *
   * Sets the hold BEFORE stopping, so a restart timer that fires in the same
   * tick cannot start a new session in the gap between the two lines.
   */
  const stopForOther = useCallback(() => {
    held.current = true;
    stop();
    setState("off");
    setNote("");
    setDraft("");
  }, [stop]);

  const resume = useCallback(() => {
    if (!held.current) return;
    held.current = false;
    if (!enabled || live.current.paused) return;
    failures.current = 0;
    start();
  }, [enabled, start]);

  return {
    state,
    note,
    active: state === "armed" || state === "listening" || state === "starting",
    draft,
    retry,
    stop: stopForOther,
    resume,
  };
}
