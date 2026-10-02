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
import { addDays, nowIso, toDateKey } from "@/lib/core/time";
import { computeGoalProgress, goalsWithProgress } from "@/lib/derived/goals";
import { invalidateContext } from "@/lib/context/gateway";
import type {
  CalendarEvent,
  Goal,
  GoalStatus,
  HealthField,
  HealthSample,
  MealName,
  Milestone,
  MoodLabel,
  Task,
  TaskStatus,
  TrashItem,
  TrashKind,
} from "@/lib/core/types";
import { TRASH_KINDS } from "@/lib/core/types";

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
  /** The bin, whenever an operation touched it. */
  trash?: TrashItem[];
  /** The log, whenever an operation touched health. */
  health?: CaveHealth;
  /** The single day an operation wrote, as it now stands. */
  day?: HealthSample;
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
/* Notes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Remove a note.
 *
 * `note` has been one of the bin's kinds since the bin was written — the store
 * knows how to move a note into it and how to put it back — and nothing in the
 * app could reach either: no route called `deleteNote`, so the five notes on
 * this machine were deletable only by opening the database with a SQLite
 * client. Found by trying to empty everything that is not one of the rooms, and
 * finding that the bin had a door on one side only.
 *
 * The note's derived memory is a separate record and keeps its own key, so
 * forgetting the note does not silently take it: that is what the Memory room
 * is for.
 */
export function deleteNote(input: Record<string, unknown>): CavePayload {
  const id = bareId(input.id, "note");
  if (!getStore().deleteNote(id)) throw new CaveError("That note no longer exists.", 404);

  invalidateContext();
  return { removed: id, trash: listTrash() };
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

/**
 * Edit a task that already exists.
 *
 * The counterpart to `setTaskStatus`, which deliberately does one thing. This is
 * the other half: the title, the date, the priority, the estimate.
 *
 * It exists because the missing verb had a real cost. Moving one task to
 * tomorrow — the most common edit there is, and the one that stops an overdue
 * item being noise on tonight's briefing — meant deleting the task and retyping
 * it, which throws away its id, its creation date and any history attached to
 * it. "Delete and recreate" is not an edit.
 *
 * ONLY the fields present in the input are touched. A patch that carries a title
 * must not blank the due date, and vice versa, which is why each field is
 * checked with `in` rather than read for a truthy value. Clearing a date is a
 * real intention and is expressed with an explicit `null` or an empty string —
 * both are honoured, because a form that has been emptied sends `""` and the
 * user's meaning is unmistakable.
 */
export function updateTask(input: Record<string, unknown>): CavePayload {
  const id = bareId(input.id, "task");
  const patch: Parameters<ReturnType<typeof getStore>["updateTask"]>[1] = {};

  if ("title" in input) {
    const title = cleanText(input.title, 200);
    if (!title) throw new CaveError("A task needs a title.");
    patch.title = title;
  }
  if ("due" in input) {
    /**
     * Three distinct intentions, and conflating them destroys data.
     *
     *   null or ""  -> the user cleared the date. That is an intention.
     *   a valid date-> set it.
     *   anything else -> refuse, loudly.
     *
     * The third case is the one that bit: `cleanDate` returns `null` for an
     * unparseable string, and an earlier version of this mapped that straight
     * into the patch — so "next tuesday" DELETED the deadline instead of being
     * rejected. A typo in a date field silently dropped a commitment, which is
     * the worst possible outcome for the single most common edit there is.
     */
    if (input.due === null || input.due === "") {
      patch.due = null;
    } else {
      const cleaned = cleanDate(input.due);
      if (cleaned === null || cleaned === undefined) {
        throw new CaveError("That is not a date I can read. Use YYYY-MM-DD, or clear it to remove the date.");
      }
      patch.due = cleaned;
    }
  }
  if ("project" in input) {
    patch.project = cleanText(input.project, 60) ?? null;
  }
  if ("priority" in input) {
    const priority = cleanPriority(input.priority);
    if (priority === undefined) throw new CaveError("Priority is 1 to 4 (1 is the most urgent).");
    patch.priority = priority;
  }
  if ("estimateMinutes" in input) {
    patch.estimateMinutes = input.estimateMinutes === null ? null : (cleanEstimate(input.estimateMinutes) ?? null);
  }
  if ("energy" in input) {
    const energy = input.energy === null || input.energy === "" ? null : String(input.energy).trim();
    if (energy !== null && !["low", "medium", "high"].includes(energy)) {
      throw new CaveError("Energy is low, medium or high.");
    }
    patch.energy = energy as Task["energy"] | null;
  }
  if (Array.isArray(input.tags)) {
    patch.tags = input.tags
      .filter((tag): tag is string => typeof tag === "string")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  if (Object.keys(patch).length === 0) throw new CaveError("Nothing to change.");

  const task = getStore().updateTask(id, patch);
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
/* The log                                                            */
/* ------------------------------------------------------------------ */

/**
 * How many days the Log room shows, today included.
 *
 * A week because that is the unit the rest of the app already reasons in —
 * `sleepAvgHours` is a seven-day average, `sleepDebtHours` a seven-day debt, and
 * the pattern detectors pair last night with today. A room with a different
 * window would give the user a way to see a number the forecast does not use.
 */
export const HEALTH_WINDOW_DAYS = 7;

/**
 * The log, as the room needs it.
 *
 * Only the days that exist. The seven slots are the room's business: an empty
 * day is a day with no row, and inventing a row to fill the gap — with a
 * `source` that says "none" — would put a fabricated reading into the same
 * payload the briefing reads, on the day someone later writes a query against
 * it. The client knows today and the window length, which is everything it
 * needs to draw a week with holes in it.
 */
export interface CaveHealth {
  /** Today, in the key the table uses. The newest day that can be written. */
  today: string;
  /** Days with something in them, oldest first. */
  days: HealthSample[];
  windowDays: number;
}

export function listCaveHealth(now: Date = new Date()): CaveHealth {
  const today = toDateKey(now);
  const oldest = toDateKey(addDays(now, -(HEALTH_WINDOW_DAYS - 1)));
  // Sixty days read and then filtered, rather than a query with a range: the
  // table is keyed by day and every health read in the app is "the newest N",
  // so a range scan would be a second query shape for one screen.
  const days = getStore()
    .healthSamples(60)
    .filter((sample) => sample.date >= oldest && sample.date <= today);
  return { today, days, windowDays: HEALTH_WINDOW_DAYS };
}

/** What a person can write by hand, and what counts as a real value. */
const WRITABLE: Record<string, { min: number; max: number; integer?: boolean }> = {
  sleepHours: { min: 0, max: 24 },
  sleepQuality: { min: 1, max: 5 },
  energy: { min: 1, max: 5, integer: true },
  steps: { min: 0, max: 200_000, integer: true },
  activeMinutes: { min: 0, max: 1_440, integer: true },
  restingHeartRate: { min: 20, max: 250, integer: true },
};

const MOODS: readonly MoodLabel[] = ["low", "flat", "good", "bright"] as const;
const MEALS: readonly MealName[] = ["breakfast", "lunch", "dinner", "snack"] as const;

/**
 * Which day an operation writes.
 *
 * Absent means today, which is what every tap in the room does. A `YYYY-MM-DD`
 * is accepted so a day already gone can be corrected — the room shows a week and
 * a week includes yesterday, and a log you can only write to for the next eight
 * hours is not a log. The future is refused: a reading for a day that has not
 * happened is not a correction, it is a typo, and it would sit in the strip
 * looking like a fact about tomorrow.
 */
function cleanDay(value: unknown): string {
  const today = toDateKey();
  if (value === undefined || value === null || value === "") return today;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    throw new CaveError("That is not a date I can write to.");
  }
  const day = value.trim();
  if (day > today) throw new CaveError("That day has not happened yet.");
  return day;
}

function healthPayload(date: string): CavePayload {
  return { health: listCaveHealth(), day: getStore().healthSamples(60).find((s) => s.date === date) };
}

/**
 * One reading, written by hand.
 *
 * The first door into the health table that a person can open without a phone, a
 * shortcut, or an export folder. Everything above it in this file writes a
 * record somebody asked for; this writes the numbers the rest of the app reasons
 * from — sleep above all, which the energy forecast is built on and which,
 * before this, could only arrive from another device.
 */
export function logHealthOp(input: Record<string, unknown>): CavePayload {
  const date = cleanDay(input.date);
  const field = typeof input.field === "string" ? input.field : "";

  if (field === "mood") {
    const mood = input.value;
    if (typeof mood !== "string" || !MOODS.includes(mood as MoodLabel)) {
      throw new CaveError("Mood is one of: low, flat, good, bright.");
    }
    getStore().upsertHealth({ date, mood: mood as MoodLabel, source: "user" });
    invalidateContext();
    return healthPayload(date);
  }

  const bounds = WRITABLE[field];
  if (!bounds) {
    // `meals` is here on purpose: it is a count derived from which meals were
    // logged, and a caller setting it directly would write a number with no
    // record behind it — the exact shape this room exists to replace.
    throw new CaveError("That is not a reading I can record here.");
  }

  const raw = typeof input.value === "number" ? input.value : Number(input.value);
  if (!Number.isFinite(raw) || raw < bounds.min || raw > bounds.max) {
    throw new CaveError(`That reading is outside what a day can hold (${bounds.min}–${bounds.max}).`);
  }
  const value = bounds.integer ? Math.round(raw) : Math.round(raw * 10) / 10;

  getStore().upsertHealth({ date, [field]: value, source: "user" } as HealthSample);
  invalidateContext();
  return healthPayload(date);
}

/**
 * Take one reading back out.
 *
 * The verb the health table never had. Every other kind in the app can be
 * removed and recovered; a health number could only be overwritten, so a tap on
 * the wrong day was permanent — and `upsertHealth` cannot express "nothing",
 * because a missing field there means "leave this alone".
 */
export function clearHealthOp(input: Record<string, unknown>): CavePayload {
  const date = cleanDay(input.date);
  const field = typeof input.field === "string" ? input.field : "";
  const store = getStore();

  if (field === "meals") {
    // Both halves, because they are one fact: the count and the names behind
    // it. Clearing one would leave the other claiming something.
    store.clearHealthField(date, "meals");
    store.clearHealthField(date, "mealsLogged");
  } else if (field === "mealsLogged") {
    store.clearHealthField(date, "mealsLogged");
  } else if (!(field in WRITABLE) && field !== "mood") {
    throw new CaveError("That is not a reading I can clear.");
  } else {
    store.clearHealthField(date, field as HealthField);
  }

  invalidateContext();
  return healthPayload(date);
}

/**
 * A meal, ticked or unticked.
 *
 * The room's four chips are the record here, and the count follows them: once a
 * name is written, the names are what happened that day and `meals` is their
 * length. An unnamed count from the chat ("just ate" twice) is a guess, and a
 * guess is exactly what a room with three chips replaces — so ticking lunch on
 * such a day says one meal is logged, not three.
 *
 * Unticking the last one returns the day to unrecorded rather than leaving a row
 * that says "0 of 3 meals": nothing eaten all day and nothing logged look the
 * same on the briefing, and only one of them is a fact.
 */
export function logMealOp(input: Record<string, unknown>): CavePayload {
  const date = cleanDay(input.date);
  const meal = input.meal;
  if (typeof meal !== "string" || !MEALS.includes(meal as MealName)) {
    throw new CaveError("A meal is one of: breakfast, lunch, dinner, snack.");
  }
  const name = meal as MealName;
  const store = getStore();

  const existing = store.healthSamples(60).find((sample) => sample.date === date);
  const logged = existing?.mealsLogged ?? [];
  const wanted = input.on === false ? false : !logged.includes(name);
  const names = wanted ? [...logged, name] : logged.filter((entry) => entry !== name);

  if (names.length === 0) {
    store.clearHealthField(date, "meals");
    store.clearHealthField(date, "mealsLogged");
  } else {
    // A snack is noted and is not one of the three, exactly as in the executor.
    const counted = Math.min(3, names.filter((entry) => entry !== "snack").length);
    store.upsertHealth({ date, meals: counted, mealsLogged: names, source: "user" });
  }

  invalidateContext();
  return healthPayload(date);
}

/* ------------------------------------------------------------------ */
/* The trash                                                           */
/* ------------------------------------------------------------------ */

/**
 * What is in the bin.
 *
 * A read, but never a cached one: the bin purges itself as it is read, so what
 * this returns is what is really still recoverable — not a list that includes
 * something the deadline has already taken.
 */
export function listTrash(): TrashItem[] {
  return getStore().listTrash();
}

/**
 * The same read, as an operation.
 *
 * The room refreshes itself after a restore without refetching the whole cave,
 * and every operation answers in the same shape — see `CavePayload`.
 */
export function trashPayload(): CavePayload {
  return { trash: listTrash() };
}

/**
 * Put something back.
 *
 * Restores exactly what was removed, which is why the store keeps the whole row
 * rather than a summary of it: a task comes back with its due date, and a memory
 * comes back still findable by recall.
 */
export function restoreFromTrash(input: Record<string, unknown>): CavePayload {
  const { kind, id } = trashRef(input);
  const restored = getStore().restoreFromTrash(kind, id);
  if (!restored) throw new CaveError("That is no longer in the trash.", 404);

  invalidateContext();
  return { trash: listTrash() };
}

/**
 * Delete something for good, ahead of the deadline.
 *
 * The only irreversible verb in the app, so it says so in the name and in the
 * interface: "Delete for good" is a different button from "Restore" and looks
 * like it.
 */
export function purgeFromTrash(input: Record<string, unknown>): CavePayload {
  const { kind, id } = trashRef(input);
  if (!getStore().purgeOne(kind, id)) throw new CaveError("That is no longer in the trash.", 404);
  invalidateContext();
  return { trash: listTrash() };
}

/** Empty the bin, on purpose and with both hands. */
export function emptyTrash(): CavePayload {
  getStore().emptyTrash();
  invalidateContext();
  return { trash: [] };
}

function trashRef(input: Record<string, unknown>): { kind: TrashKind; id: string } {
  const kind = input.kind;
  const id = typeof input.id === "string" ? input.id : "";
  if (typeof kind !== "string" || !TRASH_KINDS.includes(kind as TrashKind)) {
    throw new CaveError("Unknown kind for the trash.");
  }
  if (!id) throw new CaveError("Which one?");
  return { kind: kind as TrashKind, id };
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
  "task.update": updateTask,
  "task.setStatus": setTaskStatus,
  "task.delete": deleteTask,
  "event.create": createEvent,
  "event.delete": deleteEvent,
  "memory.list": listMemories,
  "memory.create": createMemory,
  "memory.update": updateMemory,
  "memory.pin": pinMemory,
  "memory.forget": forgetMemory,
  "note.delete": deleteNote,
  "health.log": logHealthOp,
  "health.clear": clearHealthOp,
  "health.meal": logMealOp,
  "trash.list": trashPayload,
  "trash.restore": restoreFromTrash,
  "trash.purge": purgeFromTrash,
  "trash.empty": emptyTrash,
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
