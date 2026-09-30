"use client";

import { useMemo, useState } from "react";

import type { Task } from "@/lib/cave/types";

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

export interface TasksRoomProps {
  controller: CaveController;
}

export default function TasksRoom({ controller }: TasksRoomProps) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [project, setProject] = useState("");
  const [priority, setPriority] = useState("3");
  const [confirming, setConfirming] = useState<string | null>(null);

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
    void controller.run("task.create", {
      title: text,
      due: due || null,
      project: project.trim() || null,
      priority: Number(priority),
    });
    // The title and date clear; the project stays, because adding one task to
    // a project usually means adding the next one to the same project.
    setTitle("");
    setDue("");
  };

  const late = tasks.filter((task) => dueLabel(task.due ?? undefined)?.late).length;

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
              type="date"
              value={due}
              onChange={(event) => setDue(event.target.value)}
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
      </div>

      {/* ---------------- the list ---------------- */}
      <ul className="divide-y divide-hairline">
        {tasks.map((task) => {
          const when = dueLabel(task.due ?? undefined);
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
                <button
                  type="button"
                  onClick={() => setConfirming(task.id)}
                  aria-label={`Delete ${task.title}`}
                  className="shrink-0 rounded-[var(--r-sm)] px-2 py-1 text-[11px] font-normal text-faint hover:bg-surface-2 hover:text-danger"
                >
                  delete
                </button>
              )}
            </li>
          );
        })}

        {tasks.length === 0 ? (
          <li className="px-6 py-10 text-center">
            <p className="text-[13px] font-light text-dim">
              Nothing open. Add one above, or tell her about it in the chat.
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
