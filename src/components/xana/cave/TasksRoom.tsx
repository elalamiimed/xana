"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { Task } from "@/lib/cave/types";
import {
  addDaysInZone,
  dateKeyInZone,
  daysBetweenInZone,
  fromDateKeyInZone,
  monthDayInZone,
  weekdayIndexInZone,
} from "@/lib/core/zone";

import { emptyNote } from "./empty-note";
import type { CaveController } from "./useCave";

/**
 * The task list, and the form that fills it.
 *
 * WHY THIS SCREEN EXISTS
 *
 * Capture used to be chat-only. The parser handles "remind me to call Mom
 * Friday" well, and when the thought arrives as a sentence that is still the
 * fastest way in — but a sentence cannot express priority, or a project, or
 * "this is a two-hour job", and there was no form anywhere in the interface
 * that could. A list you can only add to by talking is a list that stays empty
 * when talking does not fit.
 *
 * So this is the second door, not a replacement for the first. Nothing here
 * is required except the title, because a form that demands four fields before
 * it will accept a name is a form nobody fills in.
 *
 * WHY EVERY ROW IS NOW EDITABLE
 *
 * Adding and completing were the only two things this screen could do, so the
 * most common edit there is — moving something to another day — could only be
 * done by deleting the task and retyping it. That throws away the id, the
 * creation date and any history attached to it, and it is not an edit.
 *
 * The row edits in place rather than opening a dialog, because the thing being
 * changed is one field on one line and a modal for that is a modal the user has
 * to dismiss afterwards. The date shortcuts ("today", "tomorrow", "+1w") exist
 * because the reason people reschedule is almost never "the 14th", it is
 * "not today" — and a native date picker makes you find that on a calendar.
 *
 * WHAT A SAVE IS ALLOWED TO TOUCH
 *
 * Only the fields the user actually moved. The patch carries those and nothing
 * else, so a rename cannot clear a due date and a date cannot blank an estimate:
 * a field the save never mentions is a field the save has no opinion about. A
 * field that was emptied is a change and goes as `null`, which the store reads as
 * "clear it" rather than as silence. If nothing moved there is no write at all,
 * because "saved" over an unchanged row is the kind of claim this screen exists
 * to stop making.
 *
 * The dates are the app's days (see `@/lib/core/zone`), not the browser's. A
 * machine in another zone used to resolve "tomorrow" against its own midnight,
 * which is how a task saved for tomorrow lands on the wrong day in the briefing.
 *
 * THE KEYBOARD CONTRACT
 *
 * Opening the editor puts the caret in the first field, Enter saves, Escape
 * cancels and hands focus back to the chip that opened it. A failed save leaves
 * the editor open with the reason beside it and the draft untouched, so nothing
 * typed is lost to a refusal.
 */

const PRIORITY_LABEL: Record<number, string> = {
  1: "first",
  2: "soon",
  3: "normal",
  4: "someday",
};

/** "today" / "3d late" / "in 5d" / a date — said the way a person would. */
function dueLabel(due: string | undefined): { text: string; late: boolean } | null {
  if (!due) return null;
  const when = fromDateKeyInZone(due.slice(0, 10));
  if (Number.isNaN(when.getTime())) return null;

  // Both sides of the subtraction are the app's calendar days, so "today" here
  // is the same today the briefing and the schedule use. Read from the browser
  // instead, a machine an hour either side of midnight disagrees with them.
  const days = daysBetweenInZone(new Date(), when);
  if (Number.isNaN(days)) return null;

  if (days < 0) return { text: `${Math.abs(days)}d late`, late: true };
  if (days === 0) return { text: "today", late: false };
  if (days === 1) return { text: "tomorrow", late: false };
  if (days < 7) return { text: `in ${days}d`, late: false };
  return { text: monthDayInZone(when), late: false };
}

/**
 * A date a person would type, as YYYY-MM-DD.
 *
 * Deliberately tiny and deliberately not clever: it understands the four things
 * someone actually says when they reschedule, and returns null for everything
 * else so the caller can leave the stored date alone rather than guess.
 *
 * The arithmetic is calendar arithmetic in the app's zone. "Tomorrow" means the
 * next day on the user's own calendar, which is not the same as now plus 24
 * hours and is not the browser's day either.
 */
function quickDate(input: string, now = new Date()): string | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;

  const shift = (days: number) => dateKeyInZone(addDaysInZone(now, days));

  if (text === "today") return shift(0);
  if (text === "tomorrow") return shift(1);
  if (text === "yesterday") return shift(-1);

  // "+3d", "3d", "+2w", "1w" — enough arithmetic for "next week", no more.
  const relative = /^\+?(\d+)\s*([dw])$/.exec(text);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    if (Number.isFinite(amount)) return shift(unit === "w" ? amount * 7 : amount);
  }

  // A weekday name means the next one of those, which is what people mean. The
  // list starts on Monday because that is the order the zone module counts
  // weekdays in; three letters is the shortest unambiguous prefix either way.
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const named = days.findIndex((day) => day.startsWith(text) && text.length >= 3);
  if (named >= 0) {
    const today = weekdayIndexInZone(now);
    const ahead = (named - today + 7) % 7 || 7;
    return shift(ahead);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return null;
}

export interface TasksRoomProps {
  controller: CaveController;
}

export default function TasksRoom({ controller }: TasksRoomProps) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [project, setProject] = useState("");
  const [priority, setPriority] = useState("3");
  const [confirming, setConfirming] = useState<string | null>(null);
  /** The task currently being edited in place, by id. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    title: "",
    due: "",
    project: "",
    priority: "3",
    estimate: "",
  });
  const [editError, setEditError] = useState("");
  const [addError, setAddError] = useState("");
  /** The field the empty state points at, so its one action has a target. */
  const titleRef = useRef<HTMLInputElement | null>(null);
  /** The first field of the open editor, so opening it lands the caret there. */
  const editTitleRef = useRef<HTMLInputElement | null>(null);
  /** Every row's edit chip, so cancelling can hand focus back to the one that opened it. */
  const editChips = useRef(new Map<string, HTMLButtonElement | null>());
  /** The row whose chip should take focus once its editor closes. */
  const refocus = useRef<string | null>(null);

  const tasks = controller.tasks;

  // Opening moves the caret into the editor; closing gives it back to the chip
  // that opened it. Without the second half, Escape drops a keyboard user at the
  // top of the document and the row they were working on is a Tab hunt away.
  // Both run after the commit, so the target exists by the time they ask.
  useEffect(() => {
    if (editing) editTitleRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (editing !== null) return;
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    editChips.current.get(id)?.focus();
  }, [editing]);

  /** The projects already in use, so the field offers what exists. */
  const projects = useMemo(() => {
    const seen = new Set<string>();
    for (const task of tasks) if (task.project) seen.add(task.project);
    return [...seen].sort();
  }, [tasks]);

  const add = () => {
    const text = title.trim();
    if (!text) return;

    // Resolve the same shorthand the edit form accepts. A `type="date"` input
    // here used to mean a typed "tomorrow" was discarded without a word — the
    // field silently refused to hold a value it could not parse, and the task
    // was created with no date at all.
    const typed = due.trim();
    let resolved: string | null = null;
    if (typed) {
      resolved = /^\d{4}-\d{2}-\d{2}$/.test(typed) ? typed : quickDate(typed);
      if (!resolved) {
        setAddError("I cannot read that date. Try “tomorrow”, “friday”, “+3d”, or leave it empty.");
        return;
      }
    }
    setAddError("");

    void controller.run("task.create", {
      title: text,
      due: resolved,
      project: project.trim() || null,
      priority: Number(priority),
    });
    // The title and date clear; the project stays, because adding one task to
    // a project usually means adding the next one to the same project.
    setTitle("");
    setDue("");
  };

  const late = tasks.filter((task) => dueLabel(task.due ?? undefined)?.late).length;

  const openEditor = (task: Task) => {
    setConfirming(null);
    setEditError("");
    setEditing(task.id);
    setDraft({
      title: task.title,
      due: task.due ? task.due.slice(0, 10) : "",
      project: task.project ?? "",
      priority: String(task.priority),
      estimate: task.estimateMinutes ? String(task.estimateMinutes) : "",
    });
  };

  /** Close the editor and give the caret back to the chip that opened it. */
  const closeEditor = (id: string) => {
    refocus.current = id;
    setEditing(null);
    setEditError("");
  };

  /**
   * What actually changed, as a patch.
   *
   * Only the fields the user moved, because every field the patch mentions is a
   * field the store will overwrite. That is the whole reason a rename cannot
   * clear a due date: the date is not in the patch, so it is not something this
   * save can have an opinion about. A field that was emptied is a change and
   * goes as `null`, which the store reads as "clear it" rather than as silence.
   *
   * Returns a sentence instead of a patch when a typed value cannot be read. It
   * is deliberately not resolved by guessing: "next tuesday" is refused here for
   * the same reason the store refuses it, so a typo can never become a deletion.
   */
  const changedFields = (task: Task): Record<string, unknown> | string => {
    const patch: Record<string, unknown> = {};

    const title = draft.title.trim();
    if (title !== task.title) patch.title = title;

    const typed = draft.due.trim();
    let nextDue: string | null = null;
    if (typed) {
      const resolved = /^\d{4}-\d{2}-\d{2}$/.test(typed) ? typed : quickDate(typed);
      if (!resolved) {
        return "I cannot read that date. Try “tomorrow”, “friday”, “+3d” or a calendar date.";
      }
      nextDue = resolved;
    }
    if (nextDue !== (task.due ? task.due.slice(0, 10) : null)) patch.due = nextDue;

    const project = draft.project.trim() || null;
    if (project !== (task.project ?? null)) patch.project = project;

    const priority = Number(draft.priority);
    if (priority !== task.priority) patch.priority = priority;

    const estimateText = draft.estimate.trim();
    let nextEstimate: number | null = null;
    if (estimateText) {
      nextEstimate = Number(estimateText);
      // Checked here rather than left to the store, because the store clamps and
      // the other one of these (the date) taught this file what clamping costs.
      if (!Number.isInteger(nextEstimate) || nextEstimate < 1 || nextEstimate > 1440) {
        return "An estimate is a whole number of minutes, 1 to 1440.";
      }
    }
    if (nextEstimate !== (task.estimateMinutes ?? null)) patch.estimateMinutes = nextEstimate;

    return patch;
  };

  /**
   * Save the row.
   *
   * The patch is built from what moved, so the request is a description of the
   * edit rather than a replacement of the record. If nothing moved there is no
   * request at all: the editor closes, because reporting a save over an unchanged
   * row is a claim about work that did not happen.
   */
  const saveEdit = async (task: Task) => {
    if (!draft.title.trim()) {
      setEditError("A task needs a title.");
      return;
    }

    const changed = changedFields(task);
    if (typeof changed === "string") {
      setEditError(changed);
      return;
    }
    setEditError("");

    if (Object.keys(changed).length === 0) {
      closeEditor(task.id);
      return;
    }

    const ok = await controller.run("task.update", { id: task.id, ...changed }, task.id);
    if (ok) closeEditor(task.id);
    else setEditError(controller.error ?? "That edit did not save.");
  };

  /** One shortcut, applied to the draft rather than saved outright. */
  const nudgeDue = (days: number | null) => {
    if (days === null) {
      setDraft((d) => ({ ...d, due: "" }));
      return;
    }
    // The base is whatever the field currently reads, shorthand included, so
    // "+3 days" from a typed "tomorrow" moves tomorrow rather than today. A
    // field holding something unreadable falls back to today, which is the day
    // the shortcut is named against.
    const typed = draft.due.trim();
    const resolved = typed ? (/^\d{4}-\d{2}-\d{2}$/.test(typed) ? typed : quickDate(typed)) : null;
    const base = resolved ? fromDateKeyInZone(resolved) : new Date();
    const from = Number.isNaN(base.getTime()) ? new Date() : base;
    setDraft((d) => ({ ...d, due: dateKeyInZone(addDaysInZone(from, days)) }));
  };

  return (
    <div className="mx-auto w-full max-w-[var(--content-max)]">
      {/* ---------------- add one ---------------- */}
      <div className="border-b border-hairline px-6 py-5">
        <h3 className="text-[15px] font-normal text-text">Add a task</h3>
        <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed font-light text-dim">
          Everything but the title is optional. You can also just tell her — “remind me to
          call Mom Friday” still works, and is faster when the thought arrives as a sentence.
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
          className="mt-4 flex flex-wrap items-end gap-3"
        >
          <label className="min-w-[220px] flex-1">
            <span className="label">task</span>
            <input
              ref={titleRef}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="What needs doing?"
              aria-label="Task title"
              className="field mt-1.5"
            />
          </label>

          <label>
            <span className="label">due</span>
            <input
              value={due}
              onChange={(event) => setDue(event.target.value)}
              placeholder="tomorrow"
              aria-label="Due date"
              className="field mt-1.5 w-[170px]"
            />
          </label>

          <label>
            <span className="label">project</span>
            <input
              value={project}
              onChange={(event) => setProject(event.target.value)}
              placeholder="optional"
              list="cave-projects"
              aria-label="Project"
              className="field mt-1.5 w-[160px]"
            />
            <datalist id="cave-projects">
              {projects.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          </label>

          <label>
            <span className="label">priority</span>
            <select
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
              aria-label="Priority"
              className="field select mt-1.5 w-[130px]"
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {PRIORITY_LABEL[n]}
                </option>
              ))}
            </select>
          </label>

          <button type="submit" disabled={!title.trim()} className="btn btn-primary">
            Add
          </button>
        </form>
        {addError ? (
          <p aria-live="polite" className="mt-2 text-[12px] leading-relaxed text-danger">
            {addError}
          </p>
        ) : null}
      </div>

      {/* ---------------- the list ---------------- */}
      <ul className="divide-y divide-hairline">
        {tasks.map((task) => {
          const when = dueLabel(task.due ?? undefined);

          if (editing === task.id) {
            return (
              <li key={task.id} className="bg-surface-2/40 px-6 py-4">
                {/* Escape cancels from anywhere in the editor, and Enter is the
                    form's own submit in every text field. The handler sits on
                    the form rather than on each input so the two keys cannot
                    drift apart as fields are added. */}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveEdit(task);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    closeEditor(task.id);
                  }}
                  aria-label={`Edit ${task.title}`}
                  className="flex flex-wrap items-end gap-3"
                >
                  <label className="min-w-[220px] flex-1">
                    <span className="label">task</span>
                    <input
                      ref={editTitleRef}
                      value={draft.title}
                      onChange={(event) => setDraft((d) => ({ ...d, title: event.target.value }))}
                      aria-label="Task title"
                      className="field mt-1.5"
                    />
                  </label>

                  <label>
                    <span className="label">due</span>
                    <input
                      value={draft.due}
                      onChange={(event) => setDraft((d) => ({ ...d, due: event.target.value }))}
                      placeholder="tomorrow"
                      aria-label="Due date"
                      className="field mt-1.5 w-[150px]"
                    />
                  </label>

                  <label>
                    <span className="label">project</span>
                    <input
                      value={draft.project}
                      onChange={(event) => setDraft((d) => ({ ...d, project: event.target.value }))}
                      placeholder="optional"
                      list="cave-projects"
                      aria-label="Project"
                      className="field mt-1.5 w-[150px]"
                    />
                  </label>

                  <label>
                    <span className="label">priority</span>
                    <select
                      value={draft.priority}
                      onChange={(event) => setDraft((d) => ({ ...d, priority: event.target.value }))}
                      aria-label="Priority"
                      className="field select mt-1.5 w-[130px]"
                    >
                      {[1, 2, 3, 4].map((n) => (
                        <option key={n} value={n}>
                          {PRIORITY_LABEL[n]}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    <span className="label">estimate</span>
                    {/* Step 1, not 5. A number input enforces its own `step`
                        against the value it holds, and a step mismatch blocks
                        the whole form before React sees the submit: a task
                        estimated at 7 minutes could not be renamed until the
                        estimate was "fixed" in a field nobody touched. */}
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      step={1}
                      value={draft.estimate}
                      onChange={(event) => setDraft((d) => ({ ...d, estimate: event.target.value }))}
                      placeholder="minutes"
                      aria-label="Estimate in minutes"
                      className="field mt-1.5 w-[130px]"
                    />
                  </label>

                  <div className="flex items-center gap-2">
                    {/* A row that is already saving cannot be asked to save
                        again, which is what a second Enter would do before the
                        first answer landed. */}
                    <button
                      type="submit"
                      disabled={controller.pending.has(task.id)}
                      className="btn btn-primary"
                    >
                      Save
                    </button>
                    <button type="button" onClick={() => closeEditor(task.id)} className="btn">
                      Cancel
                    </button>
                  </div>

                  {/* The reason people reschedule is almost never a date, it is
                      "not today". A calendar picker makes you find that. */}
                  <div className="flex w-full flex-wrap items-center gap-2 pt-1">
                    <span className="timestamp">move to</span>
                    {[
                      { label: "today", days: 0 },
                      { label: "tomorrow", days: 1 },
                      { label: "+3 days", days: 3 },
                      { label: "+1 week", days: 7 },
                    ].map((option) => (
                      <button
                        key={option.label}
                        type="button"
                        onClick={() => nudgeDue(option.days)}
                        className="chip"
                      >
                        {option.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => nudgeDue(null)}
                      className="chip"
                    >
                      clear date
                    </button>
                  </div>

                  {editError ? (
                    <p aria-live="polite" className="w-full text-[12px] leading-relaxed text-danger">
                      {editError}
                    </p>
                  ) : null}
                </form>
              </li>
            );
          }

          return (
            <li key={task.id} className="flex items-start gap-3 px-6 py-3">
              {/* This list is the OPEN list — the endpoint returns open and
                  doing only. So the control is "complete", not a checkbox:
                  a checkbox that ticks and instantly disappears is a control
                  that looks broken and did exactly what it said. */}
              {/* The dot stays 16px; the box around it is what a thumb hits,
                  and it is drawn to the left of the text rather than centred
                  in a 44px box so the rows keep one left edge at every
                  width. */}
              <button
                type="button"
                onClick={() =>
                  void controller.run("task.setStatus", { id: task.id, status: "done" }, task.id)
                }
                aria-label={`Mark ${task.title} done`}
                title="Mark done"
                className="icon-tap -ml-2 flex shrink-0 items-start justify-start text-transparent transition-colors duration-[var(--t-fast)] hover:text-good"
              >
                <span className="mt-[3px] grid h-4 w-4 place-items-center rounded-full border border-hairline-2">
                  <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true">
                    <path
                      d="M1 4.6 3.4 7 8 1.6"
                      stroke="currentColor"
                      strokeWidth="1.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </button>

              <div className="min-w-0 flex-1">
                <p className="text-[14px] leading-snug font-light text-text">{task.title}</p>
                {task.status === "doing" ? (
                  <p className="mt-0.5 timestamp text-accent">in progress</p>
                ) : null}
                <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  {task.priority <= 2 ? (
                    <span className="timestamp text-accent">{PRIORITY_LABEL[task.priority]}</span>
                  ) : null}
                  {task.project ? <span className="timestamp">{task.project}</span> : null}
                  {when ? (
                    <span className={`timestamp ${when.late ? "text-danger" : ""}`}>
                      {when.text}
                    </span>
                  ) : null}
                  {task.estimateMinutes ? (
                    <span className="timestamp">{task.estimateMinutes}m</span>
                  ) : null}
                </div>
              </div>

              {confirming === task.id ? (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      void controller.run("task.delete", { id: task.id }, task.id);
                      setConfirming(null);
                    }}
                    className="chip chip-danger"
                  >
                    delete for good
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="chip"
                  >
                    keep
                  </button>
                </div>
              ) : (
                <div className="flex shrink-0 items-center gap-1">
                  {/* Edit sits before delete and is the quieter of the two,
                      because the destructive one should never be the easier
                      target to hit by accident. Its node is kept so cancelling
                      the editor can put the caret back on it. */}
                  <button
                    ref={(node) => {
                      editChips.current.set(task.id, node);
                    }}
                    type="button"
                    onClick={() => openEditor(task)}
                    aria-label={`Edit ${task.title}`}
                    className="chip"
                  >
                    edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(task.id)}
                    aria-label={`Delete ${task.title}`}
                    className="chip chip-danger"
                  >
                    delete
                  </button>
                </div>
              )}
            </li>
          );
        })}

        {tasks.length === 0 ? (
          <li className="px-6 py-10 text-center">
            <p className="text-[13px] font-light text-dim">
              {emptyNote(controller.loading, "Nothing open.")}
            </p>
            {/* An empty state that teaches gives the one action that fills it,
                and the action is the field above rather than a sentence about
                it. It is held back until the read has answered, because
                offering to start a list is a claim about a list nobody has
                looked at yet. The chat path is still named at the top of the
                room, next to the form, where it belongs. */}
            {controller.loading ? null : (
              <button
                type="button"
                onClick={() => titleRef.current?.focus()}
                className="chip mt-3"
              >
                write one down
              </button>
            )}
          </li>
        ) : null}
      </ul>

      {tasks.length > 0 ? (
        <div className="px-6 py-3">
          <p className="timestamp">
            {tasks.length} open{late > 0 ? ` · ${late} past due` : ""}
          </p>
        </div>
      ) : null}
    </div>
  );
}
