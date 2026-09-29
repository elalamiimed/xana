/**
 * The action executor — Xana's hands.
 *
 * Every write-back the assistant can perform goes through `executeAction`.
 * Keeping it in one place means the chat path, the one-tap card buttons and the
 * seed script all produce identical effects and identical sentences.
 *
 * The returned `ActionOutcome.message` is what Xana *says* about what she did.
 * Those strings are part of the product: short, past tense, no exclamation,
 * and never "I have successfully created…".
 */

import type { ActionIntent, ActionOutcome, Task } from "../core/types";
import { getStore, type XanaStore } from "../core/store";
import { invalidateContext } from "../context/gateway";
import { addDays, addMinutes, formatDay, formatTime, toDateKey, uid } from "../core/time";
import { buildReflection, monthlyReflectionInputs, weeklyReflectionInputs } from "../derived/reflection";
import { computeGoalProgress } from "../derived/goals";
import { habitsWithHealth } from "../derived/habits";
import { extractEntities, rememberUtterance } from "../derived/memory";
import { focusSuggestionFor } from "../adapters/media";

export interface ExecuteOptions {
  sessionId?: string;
  store?: XanaStore;
  /** Skip context invalidation (used by the seed script). */
  noInvalidate?: boolean;
}

export function executeAction(intent: ActionIntent, opts: ExecuteOptions = {}): ActionOutcome {
  const store = opts.store ?? getStore();
  const finish = (outcome: ActionOutcome): ActionOutcome => {
    if (!opts.noInvalidate) invalidateContext();
    return outcome;
  };

  try {
    switch (intent.type) {
      case "create_task":
        return finish(createTask(intent, store));

      case "complete_task":
        return finish(completeTask(intent.taskId, store));

      case "create_event":
        return finish(createEvent(intent, store));

      case "create_note":
        return finish(createNote(intent, store));

      case "create_reminder":
        return finish(createReminder(intent, store));

      case "create_goal":
        return finish(createGoal(intent, store));

      case "complete_milestone":
        return finish(completeMilestone(intent.milestoneId, store));

      case "log_habit":
        return finish(logHabit(intent.habitId, intent.date, store));

      case "remember":
        return finish(remember(intent, store, opts.sessionId));

      case "start_focus":
        return finish(startFocus(intent, store));

      case "protect_block":
        return finish(protectBlock(intent, store));

      case "reflect":
        return finish(reflect(intent.period, store));

      case "brief_me":
        // Handled by the mind, which has the life state in hand.
        return { ok: true, effect: "briefing.requested", message: "", refresh: ["context"] };

      case "none":
        return { ok: true, effect: "none", message: "" };

      default: {
        // Exhaustiveness: a new ActionIntent variant fails typecheck here.
        const never: never = intent;
        void never;
        return { ok: false, effect: "action.unknown", message: "I don't have a way to do that yet." };
      }
    }
  } catch (err) {
    return {
      ok: false,
      effect: "action.failed",
      message: `That didn't take — ${err instanceof Error ? err.message : String(err)}.`,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

function createTask(
  intent: Extract<ActionIntent, { type: "create_task" }>,
  store: XanaStore,
): ActionOutcome {
  const people = intent.people?.length ? intent.people : extractEntities(intent.title);
  const task = store.createTask({
    title: intent.title,
    due: intent.due,
    project: intent.project,
    people,
    priority: intent.priority ?? 3,
    estimateMinutes: intent.estimateMinutes,
    source: "xana",
  });

  store.remember({
    kind: "task",
    title: task.title,
    content: `Task captured${task.due ? ` due ${task.due}` : ""}${task.project ? ` in ${task.project}` : ""}.`,
    entities: people,
    tags: ["intention", "key:task-open:" + task.id],
    salience: task.priority <= 2 ? 0.6 : 0.4,
    source: "xana",
  });

  const when = task.due ? ` for ${formatDay(task.due)}` : "";
  return {
    ok: true,
    effect: "task.created",
    message: `Noted — "${task.title}"${when}.`,
    ids: [task.id],
    refresh: ["tasks", "context"],
  };
}

function completeTask(taskId: string, store: XanaStore): ActionOutcome {
  const existing = store.taskById(taskId);
  if (!existing) {
    return { ok: false, effect: "task.missing", message: "I can't find that one. It may already be gone." };
  }
  const task = store.updateTaskStatus(taskId, "done");
  if (!task) {
    return { ok: false, effect: "task.missing", message: "I can't find that one." };
  }
  return {
    ok: true,
    effect: "task.completed",
    message: `"${task.title}" — done.`,
    ids: [task.id],
    refresh: ["tasks", "context"],
  };
}

function createEvent(
  intent: Extract<ActionIntent, { type: "create_event" }>,
  store: XanaStore,
): ActionOutcome {
  const event = store.createEvent({
    title: intent.title,
    start: intent.start,
    end: intent.end,
    location: intent.location,
    source: "xana",
    xanaAuthored: true,
  });

  const overlap = store
    .eventsBetween(intent.start, intent.end)
    .filter((e) => e.id !== event.id);

  const when = formatDay(intent.start);
  const at = formatTime(intent.start);
  const clash = overlap.length > 0 ? ` That clashes with "${overlap[0].title}".` : "";

  return {
    ok: true,
    effect: "event.created",
    message: `Booked "${event.title}" ${when} at ${at}.${clash}`,
    ids: [event.id],
    refresh: ["calendar", "context"],
  };
}

function createNote(
  intent: Extract<ActionIntent, { type: "create_note" }>,
  store: XanaStore,
): ActionOutcome {
  const note = store.createNote({
    title: intent.title,
    body: intent.body,
    tags: intent.tags,
    source: "xana",
  });

  store.remember({
    kind: "note",
    title: note.title,
    content: note.body.slice(0, 1200),
    entities: extractEntities(`${note.title}\n${note.body}`),
    tags: [...(intent.tags ?? []), "key:note:" + note.id],
    salience: 0.6,
    source: "xana",
  });

  return {
    ok: true,
    effect: "note.created",
    message: `Saved "${note.title}".`,
    ids: [note.id],
    refresh: ["memory", "context"],
  };
}

/**
 * A reminder is a task with a time on it. Keeping one store means a reminder
 * can never drift out of sync with the task list — the failure mode of every
 * siloed reminder app.
 *
 * `hasTime` distinguishes "remind me Friday" from "remind me Friday at 3".
 * Without it the confirmation would promise a time the user never gave.
 */
function createReminder(
  intent: Extract<ActionIntent, { type: "create_reminder" }>,
  store: XanaStore,
): ActionOutcome {
  const task = store.createTask({
    title: intent.text,
    due: intent.remindAt,
    priority: 2,
    tags: ["reminder"],
    source: "xana",
  });

  const when =
    intent.hasTime === false
      ? `${formatDay(intent.remindAt)} — say the word if you want a time on it.`
      : `${formatDay(intent.remindAt)} at ${formatTime(intent.remindAt)}.`;

  return {
    ok: true,
    effect: "reminder.created",
    message: `I'll remind you ${when}`,
    ids: [task.id],
    refresh: ["tasks", "context"],
  };
}

function createGoal(
  intent: Extract<ActionIntent, { type: "create_goal" }>,
  store: XanaStore,
): ActionOutcome {
  const goal = store.createGoal({
    title: intent.title,
    horizon: intent.horizon,
    targetDate: intent.targetDate,
    why: intent.why,
    status: "active",
  });

  store.remember({
    kind: "project",
    title: goal.title,
    content: `Goal set (${goal.horizon} term)${goal.why ? `. Why: ${goal.why}` : ""}.`,
    entities: [goal.title],
    tags: ["goal", "key:goal:" + goal.id],
    salience: 0.75,
    source: "xana",
  });

  return {
    ok: true,
    effect: "goal.created",
    message: `"${goal.title}" is on the board. I'll track it.`,
    ids: [goal.id],
    refresh: ["goals", "context"],
  };
}

function completeMilestone(milestoneId: string, store: XanaStore): ActionOutcome {
  const milestone = store.completeMilestone(milestoneId);
  if (!milestone) {
    return { ok: false, effect: "milestone.missing", message: "That milestone isn't there any more." };
  }
  const goal = store.goalById(milestone.goalId);
  const progress = goal ? computeGoalProgress(goal) : undefined;
  const pct = progress ? ` ${Math.round(progress.progress * 100)}% of the way.` : "";
  return {
    ok: true,
    effect: "milestone.completed",
    message: `"${milestone.title}" closed.${pct}`,
    ids: [milestone.id, milestone.goalId],
    refresh: ["goals", "context"],
  };
}

function logHabit(habitId: string, date: string | undefined, store: XanaStore): ActionOutcome {
  const day = date ?? toDateKey();
  const habit = store.logHabit(habitId, day);
  if (!habit) {
    return { ok: false, effect: "habit.missing", message: "I don't have that habit on file." };
  }
  const health = habitsWithHealth([habit])[0];
  const streakLine = health.streak > 1 ? ` ${health.streak} days running.` : "";
  return {
    ok: true,
    effect: "habit.logged",
    message: `${habit.name} — logged.${streakLine}`,
    ids: [habit.id],
    refresh: ["habits", "context"],
  };
}

function remember(
  intent: Extract<ActionIntent, { type: "remember" }>,
  store: XanaStore,
  sessionId?: string,
): ActionOutcome {
  const mem = store.remember({
    kind: intent.kind,
    title: intent.title,
    content: intent.content,
    entities: intent.entities?.length ? intent.entities : extractEntities(`${intent.title} ${intent.content}`),
    tags: intent.tags ?? [],
    salience: 0.7,
    source: "xana",
    sessionId,
  });
  return {
    ok: true,
    effect: "memory.written",
    message: `I'll remember that.`,
    ids: [mem.id],
    refresh: ["memory", "context"],
  };
}

function startFocus(
  intent: Extract<ActionIntent, { type: "start_focus" }>,
  store: XanaStore,
): ActionOutcome {
  const media = focusSuggestionFor("sharp");
  const session = store.startFocus(intent.label, intent.minutes, media);
  return {
    ok: true,
    effect: "focus.started",
    message: `${intent.minutes} minutes on "${intent.label}". ${media}.`,
    ids: [session.id],
    refresh: ["context"],
  };
}

/**
 * Protect a block: create the event *and* name what it is defending against, so
 * the calendar entry carries its own justification.
 */
function protectBlock(
  intent: Extract<ActionIntent, { type: "protect_block" }>,
  store: XanaStore,
): ActionOutcome {
  const event = store.createEvent({
    title: `Protected: ${intent.title}`,
    start: intent.start,
    end: intent.end,
    source: "xana",
    xanaAuthored: true,
  });
  const minutes = Math.round((new Date(intent.end).getTime() - new Date(intent.start).getTime()) / 60_000);
  const why = intent.reason ? ` ${intent.reason}` : "";
  return {
    ok: true,
    effect: "block.protected",
    message: `${formatDay(intent.start)} ${formatTime(intent.start)}–${formatTime(intent.end)} is yours. ${minutes} minutes.${why}`,
    ids: [event.id],
    refresh: ["calendar", "context"],
  };
}

function reflect(period: "weekly" | "monthly", store: XanaStore): ActionOutcome {
  const base = {
    tasks: store.listTasks({ status: ["open", "doing", "done"], limit: 500 }),
    goals: store.listGoals(["active", "achieved"]).map((goal) => ({ goal, progress: computeGoalProgress(goal) })),
    habits: store.listHabits(),
    focus: store.focusBetween(addDays(new Date(), -30).toISOString(), new Date().toISOString()),
    health: store.healthSamples(60),
  };
  const inputs =
    period === "weekly" ? weeklyReflectionInputs(base) : monthlyReflectionInputs(base);
  const saved = store.saveReflection(buildReflection(inputs));

  store.remember({
    kind: "reflection",
    title: `${period === "weekly" ? "Weekly" : "Monthly"} reflection`,
    content: saved.body,
    entities: [],
    tags: ["reflection", period, "key:reflection:" + saved.id],
    salience: 0.65,
    source: "xana",
  });

  return {
    ok: true,
    effect: "reflection.created",
    message: `Here's the ${period} picture.`,
    ids: [saved.id],
    refresh: ["context"],
  };
}

/* ------------------------------------------------------------------ */
/* Convenience: the reminder parser's output feeds createReminder      */
/* ------------------------------------------------------------------ */

export function reminderIntent(text: string, remindAt: Date): ActionIntent {
  return { type: "create_reminder", text, remindAt: remindAt.toISOString() };
}

export function minutesFromNow(minutes: number, now: Date = new Date()): string {
  return addMinutes(now, minutes).toISOString();
}

export { uid };
