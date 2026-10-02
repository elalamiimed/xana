"use client";

import type { RenderedMessage } from "./useXana";
import CardView from "./CardView";

/**
 * One conversation turn.
 *
 *   user   — right-aligned, dim, no cards, no metadata
 *   xana   — left-aligned in `--text`, her cards beneath (staggered 40ms each,
 *            capped at 4), and a quiet `engine · latency` line when the wire
 *            gave us one
 *   system — a centred statement. Used for a failure, never for a greeting.
 *
 * The stagger is an inline `animation-delay` on top of the shared `card-entry`
 * keyframe; the reduced-motion block in globals.css forces that delay to zero
 * so the cards still arrive, just together and without travel.
 */

const STAGGER_MS = 40;
const STAGGER_CAP = 4;

export interface TurnProps {
  message: RenderedMessage;
  /** Only the newest reply shows its metadata line. Keeps the column quiet. */
  showMeta?: boolean;
}

/**
 * The metadata line under a reply.
 *
 * A model failure is rendered in the warning tone rather than the faint one,
 * because it is the answer to a question the user is actively asking. Every
 * other line here is a quiet footnote; "the provider rejected the API key"
 * is not, and burying it in the same grey as `local · 6ms` is how a broken
 * key looks like a working setup.
 */
function MetaLine({ meta, failed }: { meta: string; failed: boolean }) {
  if (failed) {
    return (
      <p className="text-[12px] leading-relaxed font-normal tracking-[0.04em] text-warn">
        {meta}
      </p>
    );
  }
  return <p className="timestamp">{meta}</p>;
}

export default function Turn({ message, showMeta = false }: TurnProps) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="body-text max-w-[80%] text-right text-dim">
          {message.text}
        </p>
      </div>
    );
  }

  if (message.role === "system") {
    return (
      <p className="text-center text-[13px] leading-relaxed font-light text-faint">
        {message.text}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="body-text max-w-[92%]">
        {message.text}
      </p>

      {message.cards.length > 0 ? (
        <div className="space-y-3">
          {message.cards.map((card, index) => (
            <div
              key={`${message.id}-card-${index}`}
              className="card-entry"
              style={{
                animationDelay: `${Math.min(index, STAGGER_CAP) * STAGGER_MS}ms`,
              }}
            >
              <CardView card={card} />
            </div>
          ))}
        </div>
      ) : null}

      {showMeta && message.meta ? (
        <MetaLine meta={message.meta} failed={message.modelFailed} />
      ) : null}
    </div>
  );
}
