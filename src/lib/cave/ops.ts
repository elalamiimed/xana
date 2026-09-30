/**
 * My cave: goal and memory operations, as plain functions.
 *
 * One module rather than two dozen route files. Every mutation in the cave
 * is a small, fixed operation on a single record, so they share a shape:
 * take an `op` and a payload, act, return the new state of what changed.
 * That keeps the HTTP layer a router, and keeps everything testable without
 * a server.
 *
 * Two rules hold throughout:
 *
 *  1. **Return the changed thing, not a boolean.** The cave reorders cards
 *     optimistically, so after a drag it needs the authoritative record to
 *     reconcile against — not an acknowledgement.
 *  2. **Falling back to the local engine must always be visible.** Every
 *     mutation invalidates the assembled life state, because goals and
 *     memories are both inputs to it: a goal's pace feeds the briefing, and
 *     a forgotten memory must stop surfacing in recall. Skip that and the
 *     interface contradicts itself one request later.
 */

import { getStore } from "@/lib/core/store";
import { nowIso, toDateKey } from "@/lib/core/time";
import { computeGoalProgress, goalsWithProgress } from "@/lib/derived/goals";
import { invalidateContext } from "@/lib/context/gateway";
import type { CalendarEvent, Goal, GoalStatus, Milestone, Task, TaskStatus } from "@/lib/core/types";

/* ------------------------------------------------------------------ */
/* Shapes                                                             */
/* ------------------------------------------------------------------ */

export interface CaveGoal {
  goal: Goal;
  progress: ReturnType<typeof computeGoalProgress>;
}

export interface GoalPatch {
  title?: string;
  why?: string | null;
  horizon?: Goal["horizon"];
  status?: GoalStatus;
  targetDate?: string | null;
  area?: string | null;
  cadence?: string | null;
  progressOverride?: number | null;
}

export interface CavePayload {
  goals?: CaveGoal[];
  goal?: CaveGoal;
  milestone?: Milestone;
  tasks?: Task[];
  task?: Task;
  events?: CalendarEvent[];
  event?: CalendarEvent;
  memories?: unknown;
  removed?: string;
}

export class CaveError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "CaveError";
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

function withProgress(goal: Goal): CaveGoal {
  return { goal, progress: computeGoalProgress(goal) };
}

/**
 * Every goal, in board order, with its computed pace.
 *
 * Pace is computed here rather than in the browser so the board and the
 * briefing cannot disagree about whether a goal is slipping — both read the
 * same function.
 */
export function listCaveGoals(): CaveGoal[] {
  return goalsWithProgress(getStore().allGoals());
}

/* ------------------------------------------------------------------ */
/* Ids and validation                                                 */
/* ------------------------------------------------------------------ */

/**
 * Accept either a bare id or a raw `xana:` URI.
 *
 * The memory API is reachable from outside the UI, and the unified gateway
 * convention in this project is `xana:<kind>:<id>`. Normalising here means
 * a caller that read an id out of a context payload can pass it straight
 * back without knowing which form the store wants.
 */
const XANA_URI = /^xana:[a-z]+:(.+)$/i;

function bareId(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CaveError(`Expected an id for the ${what}.`);
  }
  const trimmed = value.trim();
  const match = XANA_URI.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function requireGoal(id: string): Goal {
  const goal = getStore().goalById(id);
  if (!goal) throw new CaveError("That goal no longer exists.", 404);
  return goal;
}

function requireMilestone(id: string): Milestone {
  const milestone = getStore().milestoneById(id);
  if (!milestone) throw new CaveError("That milestone no longer exists.", 404);
  return milestone;
}

/** Trim, collapse whitespace, and enforce a length. Returns undefined for blank. */
function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length === 0) return undefined;
  return text.slice(0, max);
}

/**
 * Accept a date as `YYYY-MM-DD` or a full ISO string, and store the day.
 *
 * Only the day is kept, because every date in the cave is a deadline rather
 * than a moment: a target date with a time on it invites "due at 09:00"
 * precision the user never meant and the pace calculation ignores anyway.
 */
function cleanDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (!match) return null;
  const [, y, m, d] = match;
  const probe = new Date(`${y}-${m}-${d}T00:00:00`);
  if (Number.isNaN(probe.getTime())) return null;
  return `${y}-${m}-${d}`;
}

const HORIZONS: Goal["horizon"][] = ["short", "mid", "long"];
const STATUSES: GoalStatus[] = ["active", "paused", "achieved", "dropped"];

function cleanHorizon(value: unknown): Goal["horizon"] | undefined {
  return typeof value === "string" && (HORIZONS as string[]).includes(value)
    ? (value as Goal["horizon"])
    : undefined;
}

function cleanStatus(value: unknown): GoalStatus | undefined {
  return typeof value === "string" && (STATUSES as string[]).includes(value)
    ? (value as GoalStatus)
    : undefined;
}

/* ------------------------------------------------------------------ */
/* The operations                                                     */
/* ------------------------------------------------------------------ */

/**
 * Add a goal.
 *
 * Milestones can arrive with it, because "run a marathon" and its four
 * training steps are one thought, and requiring two round trips to express
 * that would make the quick-add field useless.
 */
export function createGoal(input: Record<string, unknown>): CavePayload {
  const title = cleanText(input.title, 200);
  if (!title) throw new CaveError("A goal needs a title.");

  const horizon = cleanHorizon(input.horizon) ?? "short";
  const milestones = Array.isArray(input.milestones)
    ? input.milestones
        .map((m) =>
          typeof m === "string"
            ? m
            : typeof m === "object" && m !== null
              ? cleanText((m as Record<string, unknown>).title, 200)
              : undefined,
        )
        .filter((t): t is string => Boolean(t))
        .map((t) => ({ title: t }))
    : [];

  const goal = getStore().createGoal({
    title,
    horizon,
    why: cleanText(input.why, 2000),
    status: cleanStatus(input.status) ?? "active",
    targetDate: cleanDate(input.targetDate) ?? undefined,
    area: cleanText(input.area, 60),
    cadence: cleanText(input.cadence, 60),
    milestones,
  });

  invalidateContext();
  return { goal: withProgress(goal) };
}

/**
 * Edit a goal.
 *
 * Only the keys present in the patch are touched, which is what lets a drag
 * send `{status}` alone. An explicit `null` clears a nullable field; an
 * empty string is treated as a clear too, so a user emptying the deadline
 * input does what they expect rather than storing "".
 */
export function updateGoal(input: Record<string, unknown>): CavePayload {
  const id = bareId(input.id, "goal");
  requireGoal(id);

  const patch: GoalPatch = {};
  if ("title" in input) {
    const title = cleanText(input.title, 200);
    if (!title) throw new CaveError("A goal needs a title.");
    patch.title = title;
  }
  if ("why" in input) patch.why = cleanText(input.why, 2000) ?? null;
  if ("area" in input) patch.area = cleanText(input.area, 60) ?? null;
  if ("cadence" in input) patch.cadence = cleanText(input.cadence, 60) ?? null;
  if ("horizon" in input) {
    const horizon = cleanHorizon(input.horizon);
    if (horizon) patch.horizon = horizon;
  }
  if ("status" in input) {
    const status = cleanStatus(input.status);
    if (status) patch.status = status;
  }
  if ("targetDate" in input) patch.targetDate = cleanDate(input.targetDate);
  if ("progressOverride" in input) {
    const raw = input.progressOverride;
    if (raw === null || raw === "") {
      patch.progressOverride = null;
    } else {
      const value = Number(raw);
      if (Number.isFinite(value)) {
        patch.progressOverride = Math.min(1, Math.max(0, value));
      }
    }
  }

  const updated = getStore().updateGoal(id, patch);
  if (!updated) throw new CaveError("That goal no longer exists.", 404);
  invalidateContext();
  return { goal: withProgress(updated) };
}

export function deleteGoal(input: Record<string, unknown>): CavePayload {
  const id = bareId(input.id, "goal");
  const removed = getStore().deleteGoal(id);
  if (!removed) throw new CaveError("That goal no longer exists.", 404);
  invalidateContext();
  return { removed: id };
}

/**
 * Move a goal within its column, or into another one.
 *
 * `before` and `after` are the sort orders of the neighbours the card was
 * dropped between — either may be null at the ends of a column. Sending the
 * orders rather than an index is what keeps the write to a single row: the
 * server computes a midpoint and stores it, instead of renumbering the
 * column.
 *
 * A status change is applied in the same call, because dragging between
 * columns is both at once and two round trips would leave the card in a
 * column it had already visually left.
 */
export function moveGoal(input: Record<string, unknown>): CavePayload {
  const id = bareId(input.id, "goal");
  requireGoal(id);

  const status = "status" in input ? cleanStatus(input.status) : undefined;
  const before = input.before === null || input.before === undefined ? null : Number(input.before);
  const after = input.after === null || input.after === undefined ? null : Number(input.after);

  if (before !== null && !Number.isFinite(before)) throw new CaveError("`before` must be a number or null.");
  if (after !== null && !Number.isFinite(after)) throw new CaveError("`after` must be a number or null.");

  if (status) getStore().updateGoal(id, { status });
  const moved = getStore().reorderGoal(id, before, after);
  if (!moved) throw new CaveError("That goal no longer exists.", 404);

  invalidateContext();
  return { goal: withProgress(moved) };
}

/**
 * Record that a goal moved.
 *
 * Backs the "something moved" button. A goal with no milestones has nothing
 * to tick, so its staleness would otherwise be measured from its creation
 * date forever and the board would mark it `stalled` no matter how much work
 * went into it. That reads as the interface blaming the user for not
 * completing milestones they never created.
 *
 * This writes a timestamp rather than a hidden marker milestone. An earlier
 * draft of this function created a `__touch__` milestone to satisfy the
 * staleness calculation, which is the kind of shortcut that ends up on
 * screen: the cave renders every milestone as a checkbox, so the user would
 * have seen a row they could not explain or delete.
 */
export function touchGoal(input: Record<string, unknown>): CavePayload {
  const id = bareId(input.id, "goal");
  requireGoal(id);

  const updated = getStore().updateGoal(id, { lastTouchedAt: nowIso() });
  if (!updated) throw new CaveError("That goal no longer exists.", 404);

  invalidateContext();
  return { goal: withProgress(updated) };
}

/* ---------------- milestones ---------------- */

export function createMilestone(input: Record<string, unknown>): CavePayload {
  const goalId = bareId(input.goalId, "goal");
  requireGoal(goalId);
  const title = cleanText(input.title, 200);
  if (!title) throw new CaveError("A milestone needs a title.");

  const milestone = getStore().createMilestone(goalId, {
    title,
    due: cleanDate(input.due) ?? undefined,
  });
  invalidateContext();
  return { milestone, goal: withProgress(requireGoal(goalId)) };
}

/** Toggle a milestone either way, so a misclick is recoverable. */
export function setMilestoneDone(input: Record<string, unknown>): CavePayload {
  const id = bareId(input.id, "milestone");
  const milestone = requireMilestone(id);
  const done = input.done === undefined ? !milestone.done : Boolean(input.done);

  const store = getStore();
  const updated = done ? store.completeMilestone(id) : store.reopenMilestone(id);
  invalidateContext();
  return {
    milestone: updated,
    goal: withProgress(requireGoal(milestone.goalId)),
  };
}

export function updateMilestone(input: Record<string, unknown>): CavePayload {
  const id = bareId(input.id, "milestone");
  const milestone = requireMilestone(id);

  const patch: { title?: string; due?: string | null } = {};
  if ("title" in input) {
    const title = cleanText(input.title, 200);
    if (!title) throw new CaveError("A milestone needs a title.");
    patch.title = title;
  }
  if ("due" in input) patch.due = cleanDate(input.due);

  const updated = getStore().updateMilestone(id, patch);
  invalidateContext();
  return { milestone: updated, goal: withProgress(requireGoal(milestone.goalId)) };
}

export function deleteMilestone(input: Record<string, unknown>): CavePayload {
  const id = bareId(input.id, "milestone");
  const milestone = requireMilestone(id);
  getStore().deleteMilestone(id);
  invalidateContext();
  return { removed: id, goal: withProgress(requireGoal(milestone.goalId)) };
}

/* ---------------- memory ---------------- */

/**
 * The memory screen's list.
 *
 * Newest first and capped, because this is a list a person scrolls: an
 * unpaginated dump of every conversation fragment is not a view of a brain,
 * it is a log. `allMemories()` is still the honest source for anything that
 * needs everything.
 */
export function listMemories(input: Record<string, unknown>): CavePayload {
  const limit = Number(input.limit ?? 300);
  const kind = typeof input.kind === "string" ? input.kind : undefined;
  const query = cleanText(input.query, 200)?.toLowerCase();

  let records = getStore().allMemories();
  if (kind) records = records.filter((r) => r.kind === kind);
  if (query) {
    records = records.filter(
      (r) =>
        r.title.toLowerCase().includes(query) ||
        r.content.toLowerCase().includes(query) ||
        r.tags.some((t) => t.toLowerCase().includes(query)),
    );
  }

  // Pinned first, then most recent. The pinned block is what the user has
  // said must not be lost, so it should not be something they scroll to find.
  records.sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });

  return {
    memories: {
      items: records.slice(0, Number.isFinite(limit) ? Math.max(1, limit) : 300),
      stats: getStore().memoryStats(),
    },
  };
}

export function pinMemory(input: Record<string, unknown>): CavePayload {
  const id = bareId(input.id, "memory");
  const pinned = Boolean(input.pinned);
  const memory = getStore().setMemoryPinned(id, pinned);
  if (!memory) throw new CaveError("That memory no longer exists.", 404);
  invalidateContext();
  return { memories: { items: [memory] } };
}

export function forgetMemory(input: Record<string, unknown>): CavePayload {
  const id = bareId(input.id, "memory");
  const removed = getStore().forgetMemory(id);
  if (!removed) throw new CaveError("That memory no longer exists.", 404);
  invalidateContext();
  return { removed: id, memories: { stats: getStore().memoryStats() } };
}

export function updateMemory(input: Record<string, unknown>): CavePayload {
  const id = bareId(input.id, "memory");
  const patch: { title?: string; content?: string; tags?: string[] } = {};
  if ("title" in input) {
    const title = cleanText(input.title, 200);
    if (!title) throw new CaveError("A memory needs a title.");
    patch.title = title;
  }
  if ("content" in input) {
    const content = typeof input.content === "string" ? input.content.trim().slice(0, 4000) : "";
    if (!content) throw new CaveError("A memory needs content.");
    patch.content = content;
  }
  if (Array.isArray(input.tags)) {
    patch.tags = input.tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  const memory = getStore().updateMemory(id, patch);
  if (!memory) throw new CaveError("That memory no longer exists.", 404);
  invalidateContext();
  return { memories: { items: [memory] } };
}

/**
 * Write a memory the user typed themselves.
 *
 * Salience is high and the source is marked `user`, which matters twice: it
 * keeps a deliberate note ranked above the conversation fragments the
 * ingestion pass generates automatically, and it lets the screen
 * distinguish what the user chose to record from what Xana inferred.
 */
export function createMemory(input: Record<string, unknown>): CavePayload {
  const title = cleanText(input.title, 200);
  if (!title) throw new CaveError("A memory needs a title.");
  const content = typeof input.content === "string" ? input.content.trim().slice(0, 4000) : title;

  const kind = typeof input.kind === "string" && input.kind.trim() ? input.kind.trim() : "fact";

  const memory = getStore().remember({
    kind: kind as never,
    title,
    content: content || title,
    entities: Array.isArray(input.entities)
      ? input.entities.filter((e): e is string => typeof e === "string").slice(0, 20)
      : [],
    tags: Array.isArray(input.tags)
      ? input.tags.filter((t): t is string => typeof t === "string").slice(0, 12)
      : [],
    salience: 0.85,
    source: "user",
  });

  if (input.pinned) getStore().setMemoryPinned(memory.id, true);

  invalidateContext();
  return { memories: { items: [getStore().memoryById(memory.id) ?? memory] } };
}

/* ------------------------------------------------------------------ */
/* Tasks                                                              */
/* ------------------------------------------------------------------ */

/**
 * The open list, as the cave sees it.
 *
 * Ordered the way the store orders every task list — priority, then anything
 * without a date, then the nearest date — so the panel and the briefing agree
 * about what is at the top. A second ordering here would be a second opinion
 * about what matters.
 */
export function listCaveTasks(): Task[] {
  return getStore().listTasks({ limit: 200 });
}

function cleanPriority(value: unknown): Task["priority"] | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 4) return undefined;
  return n as Task["priority"];
}

function cleanEstimate(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(24 * 60, Math.round(n));
}

/**
 * Add a task by hand.
 *
 * This exists because capture was chat-only. The chat parser handles "remind
 * me to call Mom Friday" well, and that is the fastest path when the thought
 * arrives as a sentence — but it cannot express priority, or a project, or
 * "this is a two-hour job", and there was no form anywhere in the interface
 * that could. A task list you can only add to by talking is a task list that
 * stays empty when the talking does not fit.
 *
 * Everything except the title is optional, for the same reason the goal
 * quick-add works that way: a form that demands four fields before it accepts
 * a name is a form nobody fills in.
 */
export function createTask(input: Record<string, unknown>): CavePayload {
  const title = cleanText(input.title, 200);
  if (!title) throw new CaveError("A task needs a title.");

  const task = getStore().createTask({
    title,
    due: cleanDate(input.due) ?? undefined,
    project: cleanText(input.project, 60),
    priority: cleanPriority(input.priority) ?? 3,
    estimateMinutes: cleanEstimate(input.estimateMinutes),
    source: "user",
  });

  invalidateContext();
  return { task, tasks: listCaveTasks() };
}

/**
 * Change a task's status.
 *
 * Only the status, deliberately. Title and date edits are the chat's job for
 * now, and a half-built editor is worse than a focused one: this is here so a
 * task can be ticked off and un-ticked, which is the thing done most often.
 */
export function setTaskStatus(input: Record<string, unknown>): CavePayload {
  const id = bareId(input.id, "task");
  const status = typeof input.status === "string" ? (input.status as TaskStatus) : undefined;
  if (!status || !(["open", "doing", "done", "dropped"] as string[]).includes(status)) {
    throw new CaveError("That is not a status a task can have.");
  }
  const task = getStore().updateTaskStatus(id, status);
  if (!task) throw new CaveError("That task no longer exists.", 404);

  invalidateContext();
  return { task, tasks: listCaveTasks() };
}

export function deleteTask(input: Record<string, unknown>): CavePayload {
  const id = bareId(input.id, "task");
  const removed = getStore().deleteTask(id);
  if (!removed) throw new CaveError("That task no longer exists.", 404);

  invalidateContext();
  return { removed: id, tasks: listCaveTasks() };
}

/* ------------------------------------------------------------------ */
/* Schedule                                                           */
/* ------------------------------------------------------------------ */

/**
 * Everything from now until the end of tomorrow, plus today's earlier events.
 *
 * The window is deliberate. "Next", "Focus" and "Open" in the briefing are all
 * questions about right now, and a calendar that only ever showed today would
 * be empty every evening — exactly when someone wants to know what tomorrow
 * looks like.
 */
export function listCaveEvents(): CalendarEvent[] {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const to = new Date(from);
  to.setDate(to.getDate() + 2);
  return getStore().eventsBetween(new Date(from).toISOString(), to.toISOString());
}

/** `YYYY-MM-DDTHH:MM` from a date field and a time field, in local time. */
function cleanMoment(date: unknown, time: unknown): string | null {
  if (typeof date !== "string" || date.trim().length === 0) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(date.trim());
  if (!day) return null;
  const clock = typeof time === "string" && /^\d{2}:\d{2}$/.test(time.trim()) ? time.trim() : "09:00";
  const at = new Date(`${day[1]}-${day[2]}-${day[3]}T${clock}:00`);
  if (Number.isNaN(at.getTime())) return null;
  return at.toISOString();
}

function cleanMinutes(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(12 * 60, Math.round(n));
}

/**
 * Put something in the schedule by hand.
 *
 * The schedule is what makes the briefing worth reading — "Next", "Focus" and
 * "Open" are all questions about it — and until now the only way in was a
 * published ICS feed or telling her in the chat. Neither covers the ordinary
 * case: a class that repeats, a lecture moved to Thursday, a study block
 * someone wants to hold themselves to.
 *
 * A time is required and an end is not: most things a person adds have a start
 * and a guess at how long, so the duration has a default rather than a second
 * required field.
 */
export function createEvent(input: Record<string, unknown>): CavePayload {
  const title = cleanText(input.title, 200);
  if (!title) throw new CaveError("An event needs a title.");

  const start = cleanMoment(input.date, input.time);
  if (!start) throw new CaveError("An event needs a date.");

  const minutes = cleanMinutes(input.minutes, 60);
  const end = new Date(new Date(start).getTime() + minutes * 60_000).toISOString();

  const event = getStore().createEvent({
    title,
    start,
    end,
    location: cleanText(input.location, 120),
    allDay: input.allDay === true,
    source: "user",
    xanaAuthored: false,
  });

  invalidateContext();
  return { event, events: listCaveEvents() };
}

export function deleteEvent(input: Record<string, unknown>): CavePayload {
  const id = bareId(input.id, "event");
  const removed = getStore().deleteEvent(id);
  if (!removed) throw new CaveError("That event no longer exists.", 404);

  invalidateContext();
  return { removed: id, events: listCaveEvents() };
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                           */
/* ------------------------------------------------------------------ */

const OPERATIONS = {
  "goal.create": createGoal,
  "goal.update": updateGoal,
  "goal.delete": deleteGoal,
  "goal.move": moveGoal,
  "goal.touch": touchGoal,
  "milestone.create": createMilestone,
  "milestone.setDone": setMilestoneDone,
  "milestone.update": updateMilestone,
  "milestone.delete": deleteMilestone,
  "task.create": createTask,
  "task.setStatus": setTaskStatus,
  "task.delete": deleteTask,
  "event.create": createEvent,
  "event.delete": deleteEvent,
  "memory.list": listMemories,
  "memory.create": createMemory,
  "memory.update": updateMemory,
  "memory.pin": pinMemory,
  "memory.forget": forgetMemory,
} as const;

export type CaveOperation = keyof typeof OPERATIONS;

export function isCaveOperation(value: unknown): value is CaveOperation {
  return typeof value === "string" && value in OPERATIONS;
}

/**
 * Run one operation.
 *
 * Throws `CaveError` for anything the user can act on, which the route turns
 * into a 4xx with the message intact. An unexpected error is allowed to
 * propagate so it surfaces as a 500 and gets logged, rather than being
 * flattened into a reassuring sentence that hides a bug.
 */
export function runCaveOperation(op: CaveOperation, input: Record<string, unknown>): CavePayload {
  return OPERATIONS[op](input);
}
