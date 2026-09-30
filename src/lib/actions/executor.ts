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
import {
  addDays,
  addMinutes,
  formatDay,
  formatTime,
  humanDuration,
  nowIso,
  toDateKey,
  uid,
} from "../core/time";
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

      case "log_energy":
        return finish(logEnergy(intent.level, intent.at, store));

      case "log_meal":
        return finish(logMeal(intent.meal, store));

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

/**
 * The user telling her how they feel, on a scale of one to five.
 *
 * Every other energy figure in the app is inferred — from sleep, from the
 * circadian curve, from how booked the day is. This one is asked for, which
 * makes it the only honest answer to "how much have I got today", and the only
 * one that can disagree with the forecast.
 *
 * The reply says something the user does not already know, or it says nothing
 * extra. "Low" on a day with four hours of meetings is worth flagging; "4"
 * on an empty day is not worth a paragraph, so it gets one clause and stops.
 */
function logEnergy(level: number, at: string | undefined, store: XanaStore): ActionOutcome {
  const clamped = Math.max(1, Math.min(5, Math.round(level)));
  const today = toDateKey();
  const when = at ?? nowIso();

  store.upsertHealth({ date: today, energy: clamped, energyAt: when, source: "user" });

  const context = energyContext(store);
  const label = ENERGY_LABELS[clamped];

  return {
    ok: true,
    effect: "energy.logged",
    message: `${clamped}/5 — ${label}.${context}`,
    refresh: ["context"],
  };
}

const ENERGY_LABELS: Record<number, string> = {
  1: "running on empty",
  2: "low",
  3: "steady",
  4: "sharp",
  5: "at your peak",
};

/** The day's three meals, which is what the briefing counts against. */
const MEAL_ORDER = ["breakfast", "lunch", "dinner"] as const;

/**
 * A meal eaten.
 *
 * Counted rather than described, because the only question the briefing asks
 * is whether they have eaten — "2 of 3" answers it, and a food diary would be
 * a different product. A snack counts towards the day without pretending to be
 * a meal, so it does not push the count past three.
 *
 * The reply names what happened rather than celebrating it. Being told "well
 * done" for eating lunch is the kind of praise that makes a person stop
 * telling you things.
 */
function logMeal(
  meal: "breakfast" | "lunch" | "dinner" | "snack" | undefined,
  store: XanaStore,
): ActionOutcome {
  const today = toDateKey();
  const existing = store.healthSamples(1)[0];
  const current = existing?.date === today ? (existing.meals ?? 0) : 0;

  // A snack is worth noting and is not one of the three.
  const counted = meal === "snack" ? current : Math.min(MEAL_ORDER.length, current + 1);
  store.upsertHealth({ date: today, meals: counted, source: "user" });

  const remaining = MEAL_ORDER.length - counted;
  const named = meal ? `${meal[0].toUpperCase()}${meal.slice(1)}` : "Logged";

  return {
    ok: true,
    effect: "meal.logged",
    message:
      remaining <= 0
        ? `${named}. That is all three today.`
        : `${named} — ${counted} of ${MEAL_ORDER.length}.`,
    refresh: ["context"],
  };
}

/**
 * One clause about what that reading means against the rest of the day.
 *
 * Derived, not stored: it is a comparison between what the user just said and
 * what the calendar and last night say, so it has to be computed at the moment
 * they say it. Returns an empty string when there is nothing to add, which is
 * the common case and the whole point.
 */
function energyContext(store: XanaStore): string {
  const today = toDateKey();
  const events = store.eventsBetween(`${today}T00:00:00`, `${today}T23:59:59`).filter((e) => !e.allDay);
  let meetingMinutes = 0;
  for (const event of events) {
    meetingMinutes += Math.max(
      0,
      Math.round((new Date(event.end).getTime() - new Date(event.start).getTime()) / 60_000),
    );
  }

  const latest = store.healthSamples(1)[0];
  const slept = latest?.sleepHours;
  const reading = latest?.energy ?? 3;

  if (reading <= 2 && meetingMinutes >= 180) {
    return ` That is ${humanDuration(meetingMinutes)} of calendar against it — worth deciding now what gets dropped.`;
  }
  if (reading >= 4 && typeof slept === "number" && slept < 6.5) {
    return ` On ${slept.toFixed(1)}h of sleep, so it is borrowed rather than yours.`;
  }
  if (reading <= 2) return " Keep the day small.";
  if (reading >= 4 && meetingMinutes === 0) return " The day is clear for it.";
  return "";
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
