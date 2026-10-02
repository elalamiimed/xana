"use client";

/**
 * The trash: what was removed, and the way back.
 *
 * WHY IT IS A ROOM AND NOT A DIALOG
 *
 * A deletion that cannot be undone teaches people not to delete — they leave
 * stale tasks on the list forever because removing one costs a decision they
 * cannot take back. The bin is what makes "remove everything" a safe thing to
 * say out loud, so it has to be somewhere a person can find without knowing it
 * exists, which means a room beside the things it holds.
 *
 * WHAT IT SAYS, AND WHY IT SAYS IT TWICE
 *
 * The deadline is on every row ("6 days left") and again in the header, because
 * the one thing a bin must never be is a surprise. It is not decoration: the
 * purge is real, it runs on every read, and a row that is three days from going
 * is a different row from one that has just arrived.
 *
 * WHAT IT WILL NOT DO
 *
 * It never deletes anything for you. `Delete for good` is per row, it is the
 * only irreversible control in the app, and it is styled as such — muted until
 * hovered, never the default. Restoring is the loud one.
 */

import { useState } from "react";

import { TRASH_DAYS, TRASH_LABELS, type TrashItem } from "@/lib/core/types";

import { emptyNote } from "./empty-note";
import type { CaveController } from "./useCave";

export interface TrashRoomProps {
  controller: CaveController;
}

/** "6 days left" / "last day" / "tomorrow is the last day". */
export function expiryLabel(item: TrashItem): string {
  if (item.daysLeft <= 0) return "going now";
  if (item.daysLeft === 1) return "last day";
  return `${item.daysLeft} days left`;
}

/** When it went, in the app's voice: "today", "yesterday", "3 days ago". */
export function deletedLabel(item: TrashItem, now: Date = new Date()): string {
  const then = new Date(item.deletedAt);
  const days = Math.floor((now.getTime() - then.getTime()) / 86_400_000);
  if (days <= 0) {
    return then.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export default function TrashRoom({ controller }: TrashRoomProps) {
  const [confirmEmpty, setConfirmEmpty] = useState(false);

  if (controller.trash.length === 0) {
    return (
      <section className="mx-auto mt-10 w-full max-w-[var(--content-max)] px-6">
        <h3 className="label">Trash</h3>
        <p className="mt-3 max-w-[62ch] text-[13px] leading-relaxed font-light text-dim">
          {emptyNote(
            controller.loading,
            `Empty. Anything you remove — a task, an event, a goal, a note, a memory — lands here first and stays for ${TRASH_DAYS} days, so asking her to remove something is never final. Restoring is always the loud control; deleting for good is the quiet one.`,
          )}
        </p>
      </section>
    );
  }

  return (
    <section className="mx-auto mt-10 w-full max-w-[var(--content-max)] px-6 pb-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="label">Trash</h3>
        <p className="text-[12px] font-normal text-faint">
          {controller.trash.length} item{controller.trash.length === 1 ? "" : "s"}, gone after{" "}
          {TRASH_DAYS} days.
        </p>
      </div>

      <ul className="mt-4 space-y-2">
        {controller.trash.map((item) => (
          <li
            key={`${item.kind}:${item.id}`}
            className="card flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
          >
            <span className="label shrink-0 rounded-full border border-hairline px-2 py-[2px]">
              {TRASH_LABELS[item.kind]}
            </span>

            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] leading-relaxed font-light text-text">{item.title}</p>
              <p className="text-[12px] font-normal text-faint">
                removed {deletedLabel(item)} · {expiryLabel(item)}
                {item.steps
                  ? ` · ${item.steps} step${item.steps === 1 ? "" : "s"} with it`
                  : ""}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => void controller.run("trash.restore", { kind: item.kind, id: item.id }, `restore:${item.id}`)}
                disabled={controller.pending.has(`restore:${item.id}`)}
                className="chip chip-round chip-accent"
              >
                {controller.pending.has(`restore:${item.id}`) ? "restoring…" : "restore"}
              </button>
              <button
                type="button"
                onClick={() => void controller.run("trash.purge", { kind: item.kind, id: item.id }, `purge:${item.id}`)}
                disabled={controller.pending.has(`purge:${item.id}`)}
                title={`Delete this for good — this one cannot be undone, and it would otherwise go in ${item.daysLeft} day${item.daysLeft === 1 ? "" : "s"}`}
                className="chip chip-round chip-danger"
              >
                delete for good
              </button>
            </div>
          </li>
        ))}
      </ul>

      {/* Emptying is the only action here that destroys several things at once,
          so it asks first — in place, rather than with a browser confirm, which
          is the kind of dialog people learn to dismiss without reading. */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        {confirmEmpty ? (
          <>
            <span className="text-[12px] font-normal text-warn">
              Empty the bin? Every item above goes for good.
            </span>
            <button
              type="button"
              onClick={() => {
                setConfirmEmpty(false);
                void controller.run("trash.empty");
              }}
              className="chip chip-round chip-danger"
            >
              yes, empty it
            </button>
            <button
              type="button"
              onClick={() => setConfirmEmpty(false)}
              className="chip chip-round"
            >
              never mind
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmEmpty(true)}
            className="chip chip-round chip-danger"
          >
            empty the bin
          </button>
        )}
      </div>
    </section>
  );
}
