"use client";

import { useMemo, useState } from "react";

import type { Task } from "@/lib/cave/types";

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
  const when = new Date(`${due.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(when.getTime())) return null;

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.round((when.getTime() - startOfToday) / 86_400_000);

  if (days < 0) return { text: `${Math.abs(days)}d late`, late: true };
  if (days === 0) return { text: "today", late: false };
  if (days === 1) return { text: "tomorrow", late: false };
  if (days < 7) return { text: `in ${days}d`, late: false };
  return {
    text: when.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    late: false,
  };
}

/**
 * A date a person would type, as YYYY-MM-DD.
 *
 * Deliberately tiny and deliberately not clever: it understands the four things
 * someone actually says when they reschedule, and returns null for everything
 * else so the caller can leave the stored date alone rather than guess.
 */
function quickDate(input: string, now = new Date()): string | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;

  const shift = (days: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

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

  // A weekday name means the next one of those, which is what people mean.
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const named = days.findIndex((day) => day.startsWith(text) && text.length >= 3);
  if (named >= 0) {
    const today = now.getDay();
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
  const [draft, setDraft] = useState({ title: "", due: "", project: "", priority: "3" });
  const [editError, setEditError] = useState("");
  const [addError, setAddError] = useState("");

  const tasks = controller.tasks;

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
    });
  };

  /**
   * Save the row.
   *
   * Every field is sent as an explicit value rather than only the ones that
   * changed, because the form always shows the whole task — a date the user
   * cleared must arrive as `null`, not be omitted, or clearing it would silently
   * fail. The server distinguishes "absent" from "empty" for exactly this.
   */
  const saveEdit = async (id: string) => {
    const text = draft.title.trim();
    if (!text) {
      setEditError("A task needs a title.");
      return;
    }
    setEditError("");

    const typed = draft.due.trim();
    let nextDue: string | null = draft.due;
    if (typed && !/^\d{4}-\d{2}-\d{2}$/.test(typed)) {
      // A shorthand the calendar field cannot express, resolved locally.
      const resolved = quickDate(typed);
      if (!resolved) {
        setEditError("I cannot read that date. Try “tomorrow”, “friday”, “+3d” or a calendar date.");
        return;
      }
      nextDue = resolved;
    }

    const ok = await controller.run(
      "task.update",
      {
        id,
        title: text,
        due: nextDue === "" ? null : nextDue,
        project: draft.project.trim() || null,
        priority: Number(draft.priority),
      },
      id,
    );
    if (ok) setEditing(null);
    else setEditError(controller.error ?? "That edit did not save.");
  };

  /** One shortcut, applied to the draft rather than saved outright. */
  const nudgeDue = (days: number | null) => {
    if (days === null) {
      setDraft((d) => ({ ...d, due: "" }));
      return;
    }
    const base = draft.due ? new Date(`${draft.due}T00:00:00`) : new Date();
    const from = Number.isNaN(base.getTime()) ? new Date() : base;
    const next = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
    setDraft((d) => ({
      ...d,
      due: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`,
    }));
  };

  return (
    <div>
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
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveEdit(task.id);
                  }}
                  className="flex flex-wrap items-end gap-3"
                >
                  <label className="min-w-[220px] flex-1">
                    <span className="label">task</span>
                    <input
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

                  <div className="flex items-center gap-2">
                    <button type="submit" className="btn btn-primary">
                      Save
                    </button>
                    <button type="button" onClick={() => setEditing(null)} className="btn">
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
                        className="rounded-[var(--r-sm)] border border-hairline px-2 py-1 text-[11px] font-normal text-dim transition-colors duration-[var(--t-fast)] hover:bg-surface-2 hover:text-text"
                      >
                        {option.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => nudgeDue(null)}
                      className="rounded-[var(--r-sm)] border border-hairline px-2 py-1 text-[11px] font-normal text-faint transition-colors duration-[var(--t-fast)] hover:bg-surface-2 hover:text-dim"
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
              <button
                type="button"
                onClick={() =>
                  void controller.run("task.setStatus", { id: task.id, status: "done" }, task.id)
                }
                aria-label={`Mark ${task.title} done`}
                title="Mark done"
                className="mt-[3px] grid h-4 w-4 shrink-0 place-items-center rounded-full border border-hairline-2 text-transparent transition-colors duration-[var(--t-fast)] hover:border-good hover:text-good"
              >
                <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true">
                  <path
                    d="M1 4.6 3.4 7 8 1.6"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
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
                    className="rounded-[var(--r-sm)] px-2 py-1 text-[11px] font-normal text-danger hover:bg-surface-2"
                  >
                    delete for good
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(null)}
                    className="rounded-[var(--r-sm)] px-2 py-1 text-[11px] font-normal text-dim hover:bg-surface-2"
                  >
                    keep
                  </button>
                </div>
              ) : (
                <div className="flex shrink-0 items-center gap-1">
                  {/* Edit sits before delete and is the quieter of the two,
                      because the destructive one should never be the easier
                      target to hit by accident. */}
                  <button
                    type="button"
                    onClick={() => openEditor(task)}
                    aria-label={`Edit ${task.title}`}
                    className="rounded-[var(--r-sm)] px-2 py-1 text-[11px] font-normal text-faint hover:bg-surface-2 hover:text-text"
                  >
                    edit
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirming(task.id)}
                    aria-label={`Delete ${task.title}`}
                    className="rounded-[var(--r-sm)] px-2 py-1 text-[11px] font-normal text-faint hover:bg-surface-2 hover:text-danger"
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
              {emptyNote(
                controller.loading,
                "Nothing open. Add one above, or tell her about it in the chat.",
              )}
            </p>
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
