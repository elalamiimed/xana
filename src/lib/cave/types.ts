/**
 * My cave, as the browser sees it.
 *
 * Types only, and free of `node:*` for the same reason `settings/types.ts`
 * is: the cave screens are client components, and importing anything that
 * touches the filesystem would pull it into the bundle through the back
 * door. The implementation lives in `src/lib/cave/ops.ts` on the server.
 */

import type {
  Goal,
  GoalProgress,
  GoalStatus,
  MemoryKind,
  MemoryRecord,
  Task,
} from "@/lib/core/types";

export type { Goal, GoalProgress, GoalStatus, MemoryKind, MemoryRecord, Task };

/** A goal with its pace already computed by the server. */
export interface CaveGoal {
  goal: Goal;
  progress: GoalProgress;
}

export interface MemoryStats {
  total: number;
  pinned: number;
  byKind: Array<{ kind: string; count: number }>;
}

export interface MemoryPage {
  items: MemoryRecord[];
  stats: MemoryStats;
}

/** The GET payload: everything the screens need to open. */
export interface CaveSnapshot {
  goals: CaveGoal[];
  /** The open task list. */
  tasks: Task[];
  memories: MemoryPage;
}

/** The columns of the board, in order. */
export type BoardColumn = Extract<GoalStatus, "active" | "paused" | "achieved">;

export const BOARD_COLUMNS: readonly {
  id: BoardColumn;
  label: string;
  /** What dropping into this column will do, said plainly. */
  onto: string;
}[] = [
  { id: "active", label: "Working on", onto: "moves it back into play" },
  { id: "paused", label: "Set aside", onto: "parks it without losing it" },
  { id: "achieved", label: "Done", onto: "marks it achieved" },
] as const;

/**
 * A goal's display state, derived once so the card and the column agree.
 *
 * `pace` already encodes slipping and stalled; this adds only the cases the
 * board needs to colour differently, and keeps that decision out of JSX.
 */
export type GoalTone = "good" | "warn" | "danger" | "idle";

export function toneFor(entry: CaveGoal): GoalTone {
  const { goal, progress } = entry;
  if (goal.status === "achieved" || progress.progress >= 1) return "good";
  if (goal.status === "paused") return "idle";
  if (progress.pace === "stalled") return "danger";
  if (progress.pace === "slipping") return "warn";
  // Nothing started is a state worth seeing on the board rather than a neutral
  // one. It is not an alarm — the goal may simply be new — but a card with no
  // movement and a quarter of its window gone should not look identical to one
  // that is tracking.
  if (progress.pace === "not-started") return "warn";
  if (
    progress.daysRemaining !== undefined &&
    progress.daysRemaining <= 3
  ) {
    return "warn";
  }
  return "good";
}

/** "in 4 days" / "3 days late" / "no deadline", in the app's voice. */
export function deadlineLabel(entry: CaveGoal): string {
  const days = entry.progress.daysRemaining;
  if (days === undefined) return "no deadline";
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} late`;
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  if (days <= 45) return `${days} days left`;
  return `due ${new Date(`${entry.goal.targetDate}T00:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`;
}

/**
 * The order a new card should sit between.
 *
 * Returns the `before` and `after` the server needs to compute a midpoint.
 * Kept here rather than in the component because it is the one piece of the
 * drag that has an edge case worth reading twice: a card cannot be its own
 * neighbour, and the neighbours come from the destination column *excluding*
 * the card being moved.
 */
export function neighboursForMove(
  goals: readonly CaveGoal[],
  movingId: string,
  targetStatus: BoardColumn,
  targetIndex: number,
): { before: number | null; after: number | null } {
  const column = goals
    .filter((entry) => entry.goal.status === targetStatus && entry.goal.id !== movingId)
    .sort(compareGoals);

  const beforeEntry = column[targetIndex - 1];
  const afterEntry = column[targetIndex];

  return {
    before: beforeEntry?.goal.sortOrder ?? null,
    after: afterEntry?.goal.sortOrder ?? null,
  };
}

/**
 * Board order: explicit placement first, then creation date.
 *
 * Goals written before the sort column existed have no order, and they must
 * land predictably rather than at a random position determined by how
 * SQLite happened to return NULLs.
 */
export function compareGoals(a: CaveGoal, b: CaveGoal): number {
  const ao = a.goal.sortOrder;
  const bo = b.goal.sortOrder;
  if (ao === undefined && bo === undefined) return a.goal.createdAt.localeCompare(b.goal.createdAt);
  if (ao === undefined) return 1;
  if (bo === undefined) return -1;
  if (ao !== bo) return ao - bo;
  return a.goal.createdAt.localeCompare(b.goal.createdAt);
}

/** Memory kinds offered when writing one by hand. */
export const MEMORY_KINDS: readonly MemoryKind[] = [
  "fact",
  "preference",
  "person",
  "place",
  "project",
  "decision",
  "note",
] as const;
