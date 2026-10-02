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

import type { ActionIntent, ActionOutcome, MealName, Task } from "../core/types";
import { TRASH_DAYS } from "../core/types";
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

      case "update_task":
        return finish(updateTask(intent, store));

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

      case "log_health":
        return finish(logHealth(intent, store));

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

      case "delete_task":
        return finish(deleteTask(intent.taskId, store));

      case "clear_tasks":
        return finish(clearTasks(intent.scope ?? "open", store));

      case "delete_event":
        return finish(deleteEvent(intent.eventId, store));

      case "delete_goal":
        return finish(deleteGoal(intent.goalId, store));

      case "forget_memory":
        return finish(forgetMemory(intent.memoryId, store));

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

/**
 * Change a task that already exists.
 *
 * Built as a patch: only the fields the intent actually carries are sent to the
 * store, so "rename it to X" leaves the due date, project and estimate exactly
 * as they were. The message names what changed rather than repeating the whole
 * task, because the user asked for one thing and reading four back is noise.
 *
 * `due: null` and `project: null` are meaningful and different from absent: they
 * clear the field. That distinction is why the intent's optional fields are
 * `string | null` rather than plain optional, and it is the one thing to keep
 * straight if this is ever refactored.
 */
function updateTask(
  intent: Extract<ActionIntent, { type: "update_task" }>,
  store: XanaStore,
): ActionOutcome {
  const existing = store.taskById(intent.taskId);
  if (!existing) {
    return { ok: false, effect: "task.missing", message: "I can't find that one. It may already be gone." };
  }

  /**
   * A title that arrives empty is a transcription failure, not an instruction.
   *
   * "rename it to" with nothing after it is how a voice turn looks when the
   * recogniser dropped the rest of the sentence, and applying it would erase the
   * task's name — the same class of accident as the garbled title this whole
   * path exists to fix.
   */
  if ("title" in intent) {
    const title = intent.title?.trim() ?? "";
    if (title.length < 2) {
      return {
        ok: false,
        effect: "task.unchanged",
        message: "I did not catch the new name, so nothing changed. Say it as \"rename it to …\".",
      };
    }
  }

  const patch: Parameters<XanaStore["updateTask"]>[1] = {};
  if (typeof intent.title === "string") patch.title = intent.title.trim().slice(0, 200);
  if (intent.due !== undefined) patch.due = intent.due;
  if (intent.project !== undefined) patch.project = intent.project;
  if (intent.priority !== undefined) patch.priority = intent.priority;
  if (intent.estimateMinutes !== undefined) patch.estimateMinutes = intent.estimateMinutes;

  if (Object.keys(patch).length === 0) {
    return { ok: false, effect: "task.unchanged", message: "Nothing to change in that one." };
  }

  const task = store.updateTask(intent.taskId, patch);
  if (!task) {
    return { ok: false, effect: "task.missing", message: "That did not take. The task may be gone." };
  }

  const changed: string[] = [];
  if (patch.title !== undefined) changed.push(`renamed to "${task.title}"`);
  if (patch.due !== undefined) changed.push(task.due ? `due ${formatDay(task.due)}` : "due date cleared");
  if (patch.project !== undefined) changed.push(task.project ? `in ${task.project}` : "project cleared");
  if (patch.priority !== undefined) changed.push(`priority ${task.priority}`);
  if (patch.estimateMinutes !== undefined) {
    changed.push(task.estimateMinutes ? `${task.estimateMinutes} minutes` : "estimate cleared");
  }

  return {
    ok: true,
    effect: "task.updated",
    message: `"${existing.title}" — ${changed.join(", ")}.`,
    ids: [task.id],
    refresh: ["tasks", "context"],
  };
}

/**
 * Book an event.
 *
 * One place it lands here: her own database. Whether it *also* lands in the
 * user's Google calendar is decided after this returns, by `mirrorToRemote` in
 * `actions/remote.ts`, which the route layer awaits.
 *
 * That split is deliberate and worth understanding before moving it. The
 * executor is synchronous and sits behind thirteen handlers in the local mind,
 * all of which are synchronous dispatchers. Making it async to serve one
 * plugin's write would have rippled through every one of them and through the
 * seed and demo scripts, for a feature that only affects calendar events.
 * Instead the remote write is a second step, named for what it is.
 *
 * `remoteEligible` is how the next step knows this event is a candidate. It is
 * on the outcome rather than inferred from the effect, because "a calendar
 * event was created" and "this event should be mirrored" are different
 * questions: an event read from Google and re-created locally must not be
 * pushed back.
 */
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
    remoteEligible: {
      plugin: "google-calendar",
      kind: "event",
      localId: event.id,
      title: event.title,
      start: intent.start,
      end: intent.end,
      location: intent.location,
      when,
      at,
      clash,
    },
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
  meal: MealName | undefined,
  store: XanaStore,
): ActionOutcome {
  const today = toDateKey();
  const existing = store.healthSamples(1)[0];
  const onToday = existing?.date === today ? existing : undefined;
  const current = onToday?.meals ?? 0;
  const logged = onToday?.mealsLogged ?? [];

  const named = meal && meal !== "snack" ? meal : undefined;
  /**
   * Said twice is not eaten twice.
   *
   * The count was the whole record before the Log room, so "log lunch" twice
   * silently read "2 of 3" — a day that claimed two meals on the strength of one
   * sentence repeated. Now that the names are kept, a second mention of a meal
   * already logged is answered rather than counted. The bare forms ("just ate")
   * still count, because they name nothing to compare against, and refusing them
   * would mean a person who says "I ate" twice gets told they did not.
   */
  if (named && logged.includes(named)) {
    return {
      ok: true,
      effect: "meal.logged",
      message: `${named[0].toUpperCase()}${named.slice(1)} is already logged today.`,
      refresh: ["context"],
    };
  }

  // A snack is worth noting and is not one of the three.
  const counted = meal === "snack" ? current : Math.min(MEAL_ORDER.length, current + 1);
  const names = meal ? [...logged, meal] : logged;
  store.upsertHealth({ date: today, meals: counted, mealsLogged: names, source: "user" });

  const remaining = MEAL_ORDER.length - counted;
  const label = meal ? `${meal[0].toUpperCase()}${meal.slice(1)}` : "Logged";

  return {
    ok: true,
    effect: "meal.logged",
    message:
      remaining <= 0
        ? `${label}. That is all three today.`
        : `${label} — ${counted} of ${MEAL_ORDER.length}.`,
    refresh: ["context"],
  };
}

/**
 * A day's health, reported in words.
 *
 * The whole point of this intent is that it is the only way into the health
 * table for someone without a phone shortcut and an Apple Health export. It
 * writes to today, like the export does: "I slept 7 hours" said at nine in the
 * morning is last night's sleep, and the energy forecast reads it as exactly
 * that — the sample dated today, carrying the hours that ended this morning.
 *
 * The reply repeats the numbers back rather than saying "logged", because this
 * is a number the user cannot see anywhere else at the moment they say it: the
 * briefing that shows sleep only exists while there is no conversation, so a
 * sentence that answered "Logged." would be voicing a value nobody can check.
 */
function logHealth(
  intent: Extract<ActionIntent, { type: "log_health" }>,
  store: XanaStore,
): ActionOutcome {
  const today = toDateKey();
  const sample = {
    date: today,
    sleepHours: cleanReading(intent.sleepHours, 0, 24),
    sleepQuality: cleanReading(intent.sleepQuality, 0, 5),
    mood: intent.mood,
    steps: cleanReading(intent.steps, 0, 200_000),
    activeMinutes: cleanReading(intent.activeMinutes, 0, 1_440),
    source: "user" as const,
  };

  const said: string[] = [];
  if (sample.sleepHours !== undefined) said.push(`${round1(sample.sleepHours)}h of sleep`);
  if (sample.sleepQuality !== undefined) said.push(`sleep quality ${round1(sample.sleepQuality)}/5`);
  if (sample.mood) said.push(`mood ${sample.mood}`);
  if (sample.steps !== undefined) said.push(`${Math.round(sample.steps).toLocaleString()} steps`);
  if (sample.activeMinutes !== undefined) said.push(`${Math.round(sample.activeMinutes)} active minutes`);

  // Nothing usable: refuse rather than write an empty day over a real one. The
  // upsert cannot blank a field, so the danger is not erasure — it is a day
  // appearing in the record, and in the averages, with nothing in it.
  if (said.length === 0) {
    return {
      ok: false,
      effect: "health.missing",
      message: "I heard a health note but no reading in it. Hours of sleep, a mood, steps, or minutes of exercise.",
      refresh: [],
    };
  }

  store.upsertHealth(sample);
  return {
    ok: true,
    effect: "health.logged",
    message: `${said.join(", ")} — noted for today.`,
    // No "health" member in the refresh list: the health tables feed the
    // assembled life state, which `invalidateContext()` has already dropped by
    // the time this returns — the list exists for the *remote* mirrors.
    refresh: ["context"],
  };
}

/**
 * A reading from speech, kept inside what a body can actually do.
 *
 * `Number.isFinite` rejects NaN and Infinity; the range check rejects the
 * plausible-sounding nonsense a misheard sentence produces ("I slept 11 hours"
 * is fine, "I slept 711" is a parse that went wrong), and anything outside the
 * range is dropped rather than clamped. Clamping would write a number nobody
 * said and then show it back to them as their own reading.
 */
function cleanReading(value: number | undefined, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < min || value > max) return undefined;
  return value;
}

function round1(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
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
/* Taking things back out                                              */
/* ------------------------------------------------------------------ */

/**
 * How a deletion is announced.
 *
 * Every one of these says where the thing went and how long it has, because
 * that is the difference between a destructive act and a reversible one — and
 * the user cannot tell which they just performed unless she says so. It is one
 * clause, not a paragraph: the reassurance belongs in the sentence, not after
 * it.
 */
const TRASH_CLAUSE = `in the trash for ${TRASH_DAYS} days`;

function deleteTask(taskId: string, store: XanaStore): ActionOutcome {
  const task = store.taskById(taskId);
  if (!task) {
    return { ok: false, effect: "task.missing", message: "That one is not on the list — it may already be gone." };
  }
  if (!store.deleteTask(taskId)) {
    return { ok: false, effect: "task.missing", message: "I couldn't remove that one." };
  }
  return {
    ok: true,
    effect: "task.deleted",
    message: `"${task.title}" — gone. It's ${TRASH_CLAUSE} if that was wrong.`,
    ids: [taskId],
    refresh: ["tasks", "context"],
  };
}

/**
 * The whole list, in one move.
 *
 * Read first, then removed one at a time, so the reply can count them and the
 * bin holds each separately. A single `DELETE ... WHERE` would be faster and
 * would also make "actually, not that one" impossible to answer.
 */
function clearTasks(scope: "open" | "all", store: XanaStore): ActionOutcome {
  const tasks = store.listTasks(scope === "all" ? {} : { status: ["open", "doing"] });
  if (tasks.length === 0) {
    return {
      ok: true,
      effect: "tasks.cleared",
      message: scope === "all" ? "There is nothing on the list to remove." : "Nothing is open — there is nothing to clear.",
      refresh: ["tasks", "context"],
    };
  }

  const removed = store.deleteTasks(tasks.map((task) => task.id));
  const noun = removed.length === 1 ? "task" : "tasks";
  return {
    ok: true,
    effect: "tasks.cleared",
    message: `Removed ${removed.length} open ${noun}. They're ${TRASH_CLAUSE} if that was a mistake.`,
    ids: removed,
    refresh: ["tasks", "context"],
  };
}

function deleteEvent(eventId: string, store: XanaStore): ActionOutcome {
  const event = store.eventById(eventId);
  if (!event) {
    return { ok: false, effect: "event.missing", message: "That isn't on the calendar any more." };
  }
  store.deleteEvent(eventId);
  const when = `${formatDay(event.start)} at ${formatTime(event.start)}`;
  return {
    ok: true,
    effect: "event.deleted",
    message: `"${event.title}" (${when}) — cancelled. It's ${TRASH_CLAUSE}.`,
    ids: [eventId],
    refresh: ["calendar", "context"],
  };
}

function deleteGoal(goalId: string, store: XanaStore): ActionOutcome {
  const goal = store.goalById(goalId);
  if (!goal) {
    return { ok: false, effect: "goal.missing", message: "That goal isn't on the board any more." };
  }
  store.deleteGoal(goalId);
  const milestones = goal.milestones.length > 0 ? ` and its ${goal.milestones.length} milestone${goal.milestones.length === 1 ? "" : "s"}` : "";
  return {
    ok: true,
    effect: "goal.deleted",
    message: `"${goal.title}"${milestones} — off the board, ${TRASH_CLAUSE}.`,
    ids: [goalId],
    refresh: ["goals", "context"],
  };
}

function forgetMemory(memoryId: string, store: XanaStore): ActionOutcome {
  const memory = store.memoryById(memoryId);
  if (!memory) {
    return { ok: false, effect: "memory.missing", message: "I don't have that in memory." };
  }
  store.forgetMemory(memoryId);
  return {
    ok: true,
    effect: "memory.forgotten",
    message: `Forgotten — "${memory.title}". It's ${TRASH_CLAUSE} if you want it back.`,
    ids: [memoryId],
    refresh: ["memory", "context"],
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
