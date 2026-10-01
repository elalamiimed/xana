"use client";

/**
 * A flight recorder for the microphone.
 *
 * The microphone path fails in the browser, and a browser is the one thing that
 * cannot be run in the environment this was built in — Edge dies on launch under
 * the sandbox, no CDP port, no console to read. So the failures that matter are
 * invisible from here, and every attempt to fix them becomes a guess.
 *
 * This closes that gap: the interesting events are sent to the server, which
 * holds the last few hundred in memory, and `GET /api/mic-log` reads them back.
 * The user runs the app, says her name, and the actual error name arrives here
 * as data instead of being described to me second-hand.
 *
 * WHAT IS DELIBERATELY NOT SENT
 *
 * No transcript text, ever. What is sent is the *shape* of an event: the error
 * name, the state transition, the transcript's length, whether the browser
 * thought a result was final. A diagnostic that ships the user's words to a log
 * to prove a microphone works is a worse trade than leaving the bug unfixed, and
 * the length is enough to tell "heard nothing" from "heard something and
 * rejected it".
 *
 * Failures here are swallowed. A diagnostic that can break the feature it is
 * diagnosing is not worth having.
 */

const ENDPOINT = "/api/mic-log";
/** Bounded so a loop cannot flood the endpoint. */
const MAX_EVENTS = 60;

let queue: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let sent = 0;
/** Set once the endpoint says it is not recording, so it is asked only once. */
let disabled = false;

/**
 * Record one event.
 *
 * Two paths, because the important events happen at the two worst moments for a
 * fetch: the page is being torn down (a restart on unload) or the clipboard of
 * time is a burst (several state changes in a tick). `sendBeacon` survives
 * unload and a batched `fetch` covers the burst.
 */
export function logMic(event: string, detail: Record<string, string | number | boolean> = {}): void {
  if (typeof window === "undefined" || disabled) return;

  const parts = [event];
  for (const [key, value] of Object.entries(detail)) {
    // Lengths instead of text, so a transcript never leaves the machine.
    parts.push(`${key}=${typeof value === "string" && value.length > 40 ? `${value.slice(0, 40)}…` : String(value)}`);
  }
  queue.push(parts.join(" "));
  if (queue.length > MAX_EVENTS) queue = queue.slice(-MAX_EVENTS);

  if (flushTimer) return;
  flushTimer = setTimeout(flush, 400);
}

/** Send what has accumulated, once. */
function flush(): void {
  flushTimer = null;
  if (queue.length === 0 || disabled) return;
  if (sent > 200) {
    // A runaway loop is itself the finding. Stop, and say so in the log once.
    if (!disabled) {
      disabled = true;
      void post(["log-abandoned after 200 flushes"]);
    }
    return;
  }
  const batch = queue;
  queue = [];
  sent += 1;
  void post(batch);
}

async function post(lines: string[]): Promise<void> {
  try {
    await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lines }),
      keepalive: true,
    });
  } catch {
    // The server may be gone, or this may be an unload. Neither is the user's
    // problem, and a diagnostic must never become one.
  }
}

/**
 * Flush on the way out.
 *
 * A restart that happens during unload would otherwise be lost, and that is
 * exactly the kind of ending worth seeing.
 */
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (queue.length === 0) return;
    const lines = queue;
    queue = [];
    try {
      const blob = new Blob([JSON.stringify({ lines })], { type: "application/json" });
      navigator.sendBeacon?.(ENDPOINT, blob);
    } catch {
      // Ignored for the same reason as `post`.
    }
  });
}

/** Whether logging is still active, for a caller that wants to say so. */
export function micLogging(): boolean {
  return !disabled;
}
