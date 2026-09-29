"use client";

import { useEffect, useRef, useState } from "react";

import { Bar } from "@/components/xana/Rings";
import {
  deadlineLabel,
  toneFor,
  type CaveGoal,
  type GoalStatus,
} from "@/lib/cave/types";

import type { CaveController } from "./useCave";

/**
 * One goal, as a card in My cave.
 *
 * Everything edits in place. There is no separate edit dialog because the
 * card *is* the record: a modal to change a title would hide the milestones,
 * the deadline and the pace while the user is deciding what the title should
 * be, and those are exactly the things that inform the decision.
 *
 * Two rules the card follows:
 *
 *  - **Nothing saves until it looks like the user finished.** Titles and
 *    reasons commit on blur or Enter, not on every keystroke. A save per
 *    character would be one HTTP request per character.
 *  - **A tick is reversible.** An accidental click on a milestone is the
 *    single easiest mistake to make here, so the same control that ticks it
 *    unticks it, and the server accepts both.
 */

const TONE_TEXT: Record<ReturnType<typeof toneFor>, string> = {
  good: "text-good",
  warn: "text-warn",
  danger: "text-danger",
  idle: "text-faint",
};

const HORIZON_LABEL: Record<CaveGoal["goal"]["horizon"], string> = {
  short: "now",
  mid: "this year",
  long: "long term",
};

export interface GoalCardProps {
  entry: CaveGoal;
  controller: CaveController;
  /** True while this card has an operation in flight. */
  busy: boolean;
  dragging: boolean;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
}

export default function GoalCard({
  entry,
  controller,
  busy,
  dragging,
  onDragStart,
  onDragEnd,
}: GoalCardProps) {
  const { goal, progress } = entry;
  const tone = toneFor(entry);

  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(goal.title);
  const [why, setWhy] = useState(goal.why ?? "");
  const [editingWhy, setEditingWhy] = useState(false);
  const [newMilestone, setNewMilestone] = useState("");
  const [addingMilestone, setAddingMilestone] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);

  // The server is the authority; when it answers, the local draft follows.
  // Without this, a rejected edit would leave the card displaying a value
  // that was never stored.
  useEffect(() => setTitle(goal.title), [goal.title]);
  useEffect(() => setWhy(goal.why ?? ""), [goal.why]);

  useEffect(() => {
    if (editingTitle) titleRef.current?.focus();
  }, [editingTitle]);

  const commitTitle = () => {
    const next = title.trim();
    setEditingTitle(false);
    if (!next || next === goal.title) {
      setTitle(goal.title);
      return;
    }
    void controller.run("goal.update", { id: goal.id, title: next }, goal.id);
  };

  const commitWhy = () => {
    const next = why.trim();
    setEditingWhy(false);
    if (next === (goal.why ?? "")) return;
    void controller.run("goal.update", { id: goal.id, why: next }, goal.id);
  };

  const addMilestone = () => {
    const text = newMilestone.trim();
    if (!text) {
      setAddingMilestone(false);
      return;
    }
    setNewMilestone("");
    void controller.run("milestone.create", { goalId: goal.id, title: text }, goal.id);
  };

  const doneCount = goal.milestones.filter((m) => m.done).length;

  return (
    <article
      // Draggable from the whole card, but a text field inside cancels it:
      // selecting a word in the title must not start a drag.
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", goal.id);
        onDragStart(goal.id);
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        // Only a text selection being dragged is rejected. The card's own
        // payload is `text/plain`, so the check is on the drag source
        // instead: a field that is being edited sets a flag.
        if (event.target instanceof HTMLElement && event.target.closest("[data-no-drag]")) {
          event.stopPropagation();
        }
      }}
      className={`card card-entry group cursor-grab p-4 active:cursor-grabbing ${
        dragging ? "opacity-40" : "opacity-100"
      } ${busy ? "animate-pulse" : ""}`}
      style={{ transitionProperty: "opacity, border-color, background-color" }}
    >
      {/* ---------------- title ---------------- */}
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${
            tone === "good"
              ? "bg-good"
              : tone === "warn"
                ? "bg-warn"
                : tone === "danger"
                  ? "bg-danger"
                  : "bg-faint"
          }`}
        />
        <div className="min-w-0 flex-1">
          {editingTitle ? (
            <textarea
              ref={titleRef}
              data-no-drag
              rows={2}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  commitTitle();
                }
                if (event.key === "Escape") {
                  setTitle(goal.title);
                  setEditingTitle(false);
                }
              }}
              className="field resize-none text-[14px] leading-snug"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingTitle(true)}
              className="block w-full text-left text-[14px] leading-snug font-normal text-text hover:text-accent"
              title="Click to rename"
            >
              {goal.title}
            </button>
          )}

          {/* Why it matters. Only shown when it exists, or when editing, so
              a board of one-line goals stays readable. */}
          {editingWhy ? (
            <textarea
              data-no-drag
              rows={2}
              value={why}
              autoFocus
              onChange={(event) => setWhy(event.target.value)}
              onBlur={commitWhy}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setWhy(goal.why ?? "");
                  setEditingWhy(false);
                }
              }}
              placeholder="Why does this matter?"
              className="field mt-2 resize-none text-[12px]"
            />
          ) : goal.why ? (
            <button
              type="button"
              onClick={() => setEditingWhy(true)}
              className="mt-1 block w-full text-left text-[12px] leading-relaxed font-light text-dim hover:text-text"
            >
              {goal.why}
            </button>
          ) : null}
        </div>
      </div>

      {/* ---------------- meta row ---------------- */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="timestamp">{HORIZON_LABEL[goal.horizon]}</span>
        <span className={`timestamp ${TONE_TEXT[tone]}`}>{deadlineLabel(entry)}</span>
        {goal.milestones.length > 0 ? (
          <span className="timestamp">
            {doneCount}/{goal.milestones.length} steps
          </span>
        ) : null}
        {goal.area ? <span className="timestamp">{goal.area}</span> : null}
      </div>

      {/* Progress. A bar rather than a ring: these sit in a narrow card, and
          a ring needs a number beside it to be readable at this size. */}
      {(goal.milestones.length > 0 || progress.progress > 0) && (
        <div className="mt-3">
          <Bar
            value={progress.progress}
            label={`${goal.title}, ${Math.round(progress.progress * 100)} percent complete`}
          />
          <p className="mt-1.5 text-[11px] leading-relaxed font-light text-faint">
            {progress.note}
          </p>
        </div>
      )}

      {/* ---------------- milestones ---------------- */}
      {goal.milestones.length > 0 || addingMilestone ? (
        <ul className="mt-3 space-y-1 border-t border-hairline pt-3">
          {goal.milestones.map((milestone) => (
            <li key={milestone.id} className="group/ms flex items-start gap-2">
              <input
                data-no-drag
                type="checkbox"
                checked={milestone.done}
                onChange={(event) =>
                  void controller.run(
                    "milestone.setDone",
                    { id: milestone.id, done: event.target.checked },
                    goal.id,
                  )
                }
                aria-label={`${milestone.title}${milestone.done ? ", done" : ""}`}
                className="mt-[3px] h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--accent)]"
              />
              <span
                className={`min-w-0 flex-1 text-[12px] leading-relaxed font-light ${
                  milestone.done ? "text-faint line-through" : "text-text"
                }`}
              >
                {milestone.title}
              </span>
              {milestone.due ? (
                <span className="timestamp shrink-0">
                  {new Date(`${milestone.due}T00:00:00`).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              ) : null}
              <button
                data-no-drag
                type="button"
                onClick={() => void controller.run("milestone.delete", { id: milestone.id }, goal.id)}
                aria-label={`Delete milestone ${milestone.title}`}
                className="shrink-0 text-faint opacity-0 transition-opacity group-hover/ms:opacity-100 hover:text-danger focus-visible:opacity-100"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {addingMilestone ? (
        <input
          data-no-drag
          autoFocus
          value={newMilestone}
          placeholder="Next step, then Enter"
          onChange={(event) => setNewMilestone(event.target.value)}
          onBlur={addMilestone}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addMilestone();
            }
            if (event.key === "Escape") {
              setNewMilestone("");
              setAddingMilestone(false);
            }
          }}
          className="field mt-2 text-[12px]"
        />
      ) : null}

      {/* ---------------- controls ---------------- */}
      {/* Hidden until hover or focus, so a board of twelve goals is readable
          rather than a wall of buttons. Always reachable by keyboard. */}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          onClick={() => setAddingMilestone(true)}
          className="rounded-[var(--r-sm)] px-2 py-1 text-[11px] font-light text-dim hover:bg-surface-2 hover:text-text"
        >
          + step
        </button>
        <button
          type="button"
          onClick={() => void controller.run("goal.touch", { id: goal.id }, goal.id)}
          title="Record that something moved, so a goal with no steps is not marked stalled"
          className="rounded-[var(--r-sm)] px-2 py-1 text-[11px] font-light text-dim hover:bg-surface-2 hover:text-text"
        >
          moved today
        </button>

        <select
          value={goal.horizon}
          onChange={(event) =>
            void controller.run("goal.update", { id: goal.id, horizon: event.target.value }, goal.id)
          }
          aria-label="Horizon"
          className="select rounded-[var(--r-sm)] bg-transparent px-2 py-1 text-[11px] font-light text-dim hover:bg-surface-2 hover:text-text"
        >
          <option value="short">now</option>
          <option value="mid">this year</option>
          <option value="long">long term</option>
        </select>

        <input
          type="date"
          value={goal.targetDate ?? ""}
          onChange={(event) =>
            void controller.run(
              "goal.update",
              { id: goal.id, targetDate: event.target.value || null },
              goal.id,
            )
          }
          aria-label="Target date"
          className="rounded-[var(--r-sm)] bg-transparent px-2 py-1 text-[11px] font-light text-dim hover:bg-surface-2"
        />

        <span className="flex-1" />

        {confirmingDelete ? (
          <>
            <button
              type="button"
              onClick={() => void controller.run("goal.delete", { id: goal.id }, goal.id)}
              className="rounded-[var(--r-sm)] px-2 py-1 text-[11px] font-light text-danger hover:bg-surface-2"
            >
              delete for good
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              className="rounded-[var(--r-sm)] px-2 py-1 text-[11px] font-light text-dim hover:bg-surface-2"
            >
              keep
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            aria-label={`Delete ${goal.title}`}
            className="rounded-[var(--r-sm)] px-2 py-1 text-[11px] font-light text-faint hover:bg-surface-2 hover:text-danger"
          >
            delete
          </button>
        )}
      </div>

      {/* A card in a non-active column says what moving it back would mean,
          which is the question the column heading cannot answer per card. */}
      {goal.status !== "active" ? (
        <button
          type="button"
          onClick={() =>
            void controller.run("goal.update", { id: goal.id, status: "active" as GoalStatus }, goal.id)
          }
          className="mt-2 w-full rounded-[var(--r-sm)] border border-hairline px-2 py-1.5 text-[11px] font-light text-dim hover:border-accent/40 hover:text-accent"
        >
          put back in play
        </button>
      ) : null}
    </article>
  );
}
