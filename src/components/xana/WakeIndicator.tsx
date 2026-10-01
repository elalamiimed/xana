"use client";

import type { WakeState } from "./useWakeListener";

/**
 * Whether she is listening, said plainly and in one line.
 *
 * A microphone that is open without saying so is the single most objectionable
 * thing an always-on assistant can do, and this is the whole defence against it.
 * The line above the input always states which of the two states she is in — and
 * the two are genuinely different things to a user:
 *
 *   - *watching for her name*: the microphone is open, but nothing the user says
 *     is a request until they say her name. Only the name is looked for.
 *   - *listening for the request*: she heard the name, and the next thing said
 *     is the question. This is the state where a user needs to know that she is
 *     waiting, because otherwise they sit in silence wondering whether it worked.
 *
 * The old dictation path told the user nothing until it failed, which is why a
 * working microphone looked like a broken button. This is the same lesson
 * applied before the fact rather than after.
 *
 * `role="status"` rather than `aria-live` on a plain paragraph: the state
 * changes are short and worth announcing, and `status` is the polite live region
 * meant for exactly this.
 */

const LABELS: Record<WakeState, string> = {
  off: "",
  starting: "Opening the microphone…",
  armed: "Listening for her name",
  listening: "Go ahead — I am listening",
  paused: "Waiting until she stops speaking",
  failed: "",
};

export interface WakeIndicatorProps {
  state: WakeState;
  /** The request being assembled, shown back to the user as it is heard. */
  draft: string;
  /** Why listening stopped, when it did. */
  note: string;
  /** Force a restart. Only offered when listening stopped for a fixable reason. */
  onRetry: () => void;
  /** Switch always-listening off. */
  onDismiss: () => void;
}

export default function WakeIndicator({
  state,
  draft,
  note,
  onRetry,
  onDismiss,
}: WakeIndicatorProps) {
  // Nothing to say, and nothing to show. A control that is off needs no banner.
  if (state === "off") return null;

  if (state === "failed") {
    return (
      <div
        role="status"
        className="mb-2 flex w-full items-start gap-2 rounded-2xl border border-warn/24 bg-warn/04 px-4 py-2"
      >
        <span aria-hidden="true" className="mt-[7px] block h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
        <p className="flex-1 text-[12px] leading-relaxed font-normal text-warn">
          {note || "Listening stopped."}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 text-[12px] font-normal text-dim underline decoration-hairline underline-offset-2 transition-colors duration-[var(--t-fast)] hover:text-text"
        >
          Try again
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 text-[12px] font-normal text-faint transition-colors duration-[var(--t-fast)] hover:text-dim"
        >
          Turn off
        </button>
      </div>
    );
  }

  const listening = state === "listening";

  return (
    <div role="status" className="mb-2 flex w-full items-center gap-2 px-4">
      {/* A mark rather than an icon: two states, both a dot, one of them
          breathing. A spinner would say "busy"; this says "open". */}
      <span
        aria-hidden="true"
        className={`block h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-[var(--t-fast)] ${
          listening ? "bg-accent" : "bg-accent/48"
        }`}
        style={listening ? { animation: "breath 1.4s var(--ease) infinite" } : undefined}
      />

      <p
        className={`flex-1 truncate text-[12px] leading-relaxed font-normal ${
          listening ? "text-accent" : "text-faint"
        }`}
      >
        {LABELS[state]}
        {/* Her own words, echoed as they arrive. This is the feedback that makes
            hands-free usable: without it the user cannot tell a misheard name
            from a microphone that is not working. */}
        {listening && draft ? <span className="text-dim"> — “{draft}”</span> : null}
      </p>

      {listening ? (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 text-[12px] font-normal text-faint transition-colors duration-[var(--t-fast)] hover:text-dim"
        >
          Never mind
        </button>
      ) : null}
    </div>
  );
}
