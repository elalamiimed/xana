/**
 * The tools a model may propose, and the read tools it may consult.
 *
 * WHAT THIS FILE IS, AND WHAT IT IS NOT
 *
 * It is a **closed catalog**. Every entry maps to a variant of `ActionIntent`
 * that the deterministic executor already knows how to perform, and there is no
 * entry that takes a query, a URL, a path or a command. That is the entire
 * safety argument for letting a model propose anything at all: the model is not
 * being given a way to act, it is being given a way to *ask for one of
 * thirty-odd specific things*, each of which was already reachable by typing a
 * sentence.
 *
 * The alternatives were considered and rejected, and the rejection is the point
 * rather than an omission:
 *
 *   - A generic "run this SQL" or "call this URL" tool is a remote code
 *     execution surface with extra steps. It is not here.
 *   - A web-fetch tool is the other half of the same problem. This app already
 *     holds private data, so adding untrusted content plus a channel that can
 *     carry it out builds the whole trifecta in one commit. If that is ever
 *     wanted it needs its own analysis, not a line in this array.
 *
 * HANDLERS DO NOT WRITE
 *
 * A `write` tool's handler returns an `ActionIntent`; it never calls
 * `executeAction` itself. The write happens in `./agent`, once, after
 * `./guard` has approved it. A handler that wrote directly would be a second
 * commit path, and a second commit path is where the audit trail and the
 * idempotency key both stop being true.
 */

import type { ActionIntent, LifeState, MealName, MoodLabel } from "../core/types";
import { decomposeGoal } from "./plan";
import {
  resolveEvent,
  resolveGoal,
  resolveHabit,
  resolveMemory,
  resolveTask,
} from "./resolve";

export type ToolSafety = "read" | "write" | "destructive";

export interface ToolContext {
  lifeState: LifeState;
  sessionId: string;
  /**
   * Set when the proposal originated in content Xana did not write.
   *
   * Nothing sets this today, because nothing in the current life state comes
   * from a source that can be instructed. It exists so the fail-closed rule in
   * `./guard` is already written and tested on the day a plugin supplies text
   * that a third party controls: a mail body, a calendar invite, a web page.
   * Adding it later, under pressure, is how that rule ends up missing.
   */
  untrustedSource?: string;
}

export type ToolResult =
  | { ok: true; data: unknown; intent?: ActionIntent }
  | { ok: false; error: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  safety: ToolSafety;
  /**
   * Argument keys whose value must name a record that already exists. The guard
   * refuses the proposal when one does not resolve, and never invents an id.
   */
  resolves?: Array<{ arg: string; kind: "task" | "event" | "goal" | "habit" | "memory" }>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => ToolResult;
}

/* ------------------------------------------------------------------ */
/* Argument coercion                                                   */
/* ------------------------------------------------------------------ */

/**
 * Read a string argument.
 *
 * The provider's own documentation warns that tool arguments are not always
 * valid JSON and that it may "hallucinate parameters", so every field is read
 * defensively and a wrong type is an error rather than a `String(undefined)`
 * that quietly writes the word "undefined" into a title. That has happened to
 * other projects; it is a one-line guard here.
 */
function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requiredStr(
  args: Record<string, unknown>,
  key: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = str(args, key);
  if (!value) return { ok: false, error: `"${key}" is required and must be a non-empty string` };
  return { ok: true, value };
}

const MOODS: MoodLabel[] = ["low", "flat", "good", "bright"];
const MEALS: MealName[] = ["breakfast", "lunch", "dinner", "snack"];

/* ------------------------------------------------------------------ */
/* Write tools                                                         */
/* ------------------------------------------------------------------ */

const createTask: ToolSpec = {
  name: "create_task",
  description:
    "Add a task to the list. Use for anything the user wants to remember to do. Give the date in `due` only when they named one, as YYYY-MM-DD.",
  safety: "write",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "What to do, in a few words." },
      due: { type: "string", description: "Due date as YYYY-MM-DD. Omit if they did not name one." },
      project: { type: "string", description: "Project or list it belongs to, if they said." },
    },
    required: ["title"],
  },
  handler: (args) => {
    const title = requiredStr(args, "title");
    if (!title.ok) return { ok: false, error: title.error };
    const due = str(args, "due");
    return {
      ok: true,
      data: { title: title.value, due },
      intent: {
        type: "create_task",
        title: title.value,
        ...(due ? { due } : {}),
        ...(str(args, "project") ? { project: str(args, "project") as string } : {}),
      },
    };
  },
};

const completeTask: ToolSpec = {
  name: "complete_task",
  description:
    "Mark a task done. `task` must be words from the task's own title, as the user referred to it - not an id.",
  safety: "write",
  resolves: [{ arg: "task", kind: "task" }],
  parameters: {
    type: "object",
    properties: { task: { type: "string", description: "The task's title, or the words the user used for it." } },
    required: ["task"],
  },
  handler: (args, ctx) => {
    const name = requiredStr(args, "task");
    if (!name.ok) return { ok: false, error: name.error };
    const found = resolveTask(name.value, ctx.lifeState);
    if (!found) return { ok: false, error: `no open task matches "${name.value}"` };
    return { ok: true, data: { task: found.title }, intent: { type: "complete_task", taskId: found.id } };
  },
};

const updateTask: ToolSpec = {
  name: "update_task",
  description:
    "Change a task that already exists: rename it, move its due date, set its project. Only the fields given are changed.",
  safety: "write",
  resolves: [{ arg: "task", kind: "task" }],
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "The task's current title, or words from it." },
      title: { type: "string", description: "New title. Omit to leave it alone." },
      due: { type: "string", description: "New due date YYYY-MM-DD, or the word none to clear it." },
      project: { type: "string", description: "New project. Omit to leave it alone." },
    },
    required: ["task"],
  },
  handler: (args, ctx) => {
    const name = requiredStr(args, "task");
    if (!name.ok) return { ok: false, error: name.error };
    const found = resolveTask(name.value, ctx.lifeState);
    if (!found) return { ok: false, error: `no open task matches "${name.value}"` };

    const rawDue = str(args, "due");
    const clearsDue = rawDue !== undefined && /^(none|no date|clear)$/i.test(rawDue);
    const newTitle = str(args, "title");
    const project = str(args, "project");
    if (newTitle === undefined && rawDue === undefined && project === undefined) {
      return { ok: false, error: "nothing to change: give at least one of title, due or project" };
    }

    return {
      ok: true,
      data: { task: found.title, title: newTitle, due: rawDue },
      intent: {
        type: "update_task",
        taskId: found.id,
        ...(newTitle !== undefined ? { title: newTitle } : {}),
        ...(rawDue !== undefined ? { due: clearsDue ? null : rawDue } : {}),
        ...(project !== undefined ? { project } : {}),
      },
    };
  },
};

const createEvent: ToolSpec = {
  name: "create_event",
  description:
    "Put something in the calendar. `start` and `end` are local ISO datetimes with no timezone suffix (YYYY-MM-DDTHH:MM). Work out the date from today's date in the LIFE STATE.",
  safety: "write",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      start: { type: "string", description: "Local start, YYYY-MM-DDTHH:MM." },
      end: { type: "string", description: "Local end, YYYY-MM-DDTHH:MM." },
      location: { type: "string" },
    },
    required: ["title", "start", "end"],
  },
  handler: (args) => {
    const title = requiredStr(args, "title");
    if (!title.ok) return { ok: false, error: title.error };
    const start = requiredStr(args, "start");
    if (!start.ok) return { ok: false, error: start.error };
    const end = requiredStr(args, "end");
    if (!end.ok) return { ok: false, error: end.error };

    const startDate = new Date(start.value);
    const endDate = new Date(end.value);
    if (Number.isNaN(startDate.getTime())) return { ok: false, error: `"${start.value}" is not a date I can read` };
    if (Number.isNaN(endDate.getTime())) return { ok: false, error: `"${end.value}" is not a date I can read` };
    if (endDate <= startDate) return { ok: false, error: "the end is not after the start" };

    return {
      ok: true,
      data: { title: title.value, start: start.value, end: end.value },
      intent: {
        type: "create_event",
        title: title.value,
        start: start.value,
        end: end.value,
        ...(str(args, "location") ? { location: str(args, "location") as string } : {}),
      },
    };
  },
};

const createReminder: ToolSpec = {
  name: "create_reminder",
  description:
    "A reminder at a specific moment. `when` is a local ISO datetime with no timezone suffix (YYYY-MM-DDTHH:MM).",
  safety: "write",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string" },
      when: { type: "string", description: "Local datetime, YYYY-MM-DDTHH:MM." },
    },
    required: ["text", "when"],
  },
  handler: (args) => {
    const text = requiredStr(args, "text");
    if (!text.ok) return { ok: false, error: text.error };
    const when = requiredStr(args, "when");
    if (!when.ok) return { ok: false, error: when.error };
    if (Number.isNaN(new Date(when.value).getTime())) {
      return { ok: false, error: `"${when.value}" is not a date I can read` };
    }
    return {
      ok: true,
      data: { text: text.value, when: when.value },
      intent: { type: "create_reminder", text: text.value, remindAt: when.value, hasTime: true },
    };
  },
};

const createGoal: ToolSpec = {
  name: "create_goal",
  description:
    "Record a goal they are committing to. Horizon is short (weeks), mid (months) or long (a year or more). Milestones are added separately with plan_goal.",
  safety: "write",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      horizon: { type: "string", enum: ["short", "mid", "long"] },
      targetDate: { type: "string", description: "YYYY-MM-DD, if they named one." },
      why: { type: "string", description: "Their reason, in their words, if they gave one." },
    },
    required: ["title"],
  },
  handler: (args) => {
    const title = requiredStr(args, "title");
    if (!title.ok) return { ok: false, error: title.error };
    const raw = str(args, "horizon");
    const horizon = raw === "short" || raw === "mid" || raw === "long" ? raw : "mid";
    const targetDate = str(args, "targetDate");
    if (targetDate && Number.isNaN(new Date(targetDate).getTime())) {
      return { ok: false, error: `"${targetDate}" is not a date I can read` };
    }
    return {
      ok: true,
      data: { title: title.value, horizon },
      intent: {
        type: "create_goal",
        title: title.value,
        horizon,
        ...(targetDate ? { targetDate } : {}),
        ...(str(args, "why") ? { why: str(args, "why") as string } : {}),
      },
    };
  },
};

/**
 * The read tool that makes a plan possible without inventing one.
 *
 * `plan_goal` is not a write: it produces a *proposal* and hands it back, so the
 * model can describe the plan and the user can accept it. Turning a goal into
 * six milestones that appear in the database before anyone agreed to them would
 * be the clearest possible case of a model asserting structure the user never
 * asked for.
 *
 * The proposal is deterministic when no model is configured, which is why this
 * is a read tool rather than a model-only convenience: with no key at all, the
 * agent can still answer "what would the steps be?" with a real answer.
 */
const planGoal: ToolSpec = {
  name: "plan_goal",
  description:
    "Propose milestones for a goal. Returns a suggested breakdown WITH DATES for the user to accept or change. This does not save anything - say the plan back to them and let them decide.",
  safety: "read",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "The goal being planned." },
      horizon: { type: "string", enum: ["short", "mid", "long"] },
      targetDate: { type: "string", description: "YYYY-MM-DD, if they named one." },
      why: { type: "string", description: "Their reason, if they gave one." },
    },
    required: ["title"],
  },
  handler: (args) => {
    const title = requiredStr(args, "title");
    if (!title.ok) return { ok: false, error: title.error };
    const raw = str(args, "horizon");
    const horizon = raw === "short" || raw === "mid" || raw === "long" ? raw : "mid";
    const targetDate = str(args, "targetDate");

    /*
     * Synchronous and deterministic, deliberately.
     *
     * A read tool's handler must return, not await: `./agent` calls it inline
     * while building the tool result, and making that path async would mean the
     * loop had to know which tools were slow. `decomposeGoal` needs no model, so
     * the rich version (`decomposeGoalWithModel`) is left to a caller that can
     * afford the round trip, and this returns the skeleton, which is a real
     * answer rather than a stub.
     */
    const proposals = decomposeGoal({ title: title.value, horizon, targetDate });
    if (proposals.length === 0) {
      return { ok: false, error: "I could not build a plan without a horizon or a target date - ask them for one." };
    }
    return {
      ok: true,
      data: {
        goal: title.value,
        milestones: proposals.map((m) => ({ title: m.title, due: m.due })),
        note: "Proposed, not saved. Tell them the shape of it and ask if it looks right before adding anything.",
      },
    };
  },
};

const rememberTool: ToolSpec = {
  name: "remember",
  description:
    "Store a durable fact about the user worth knowing later: a preference, a person, a project, a decision. Not a summary of the conversation, and not a compliment.",
  safety: "write",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "A few words to find it by later." },
      content: { type: "string", description: "The fact, one sentence, in the third person." },
      kind: {
        type: "string",
        enum: ["fact", "preference", "person", "place", "project", "decision", "event"],
      },
    },
    required: ["title", "content"],
  },
  handler: (args) => {
    const title = requiredStr(args, "title");
    if (!title.ok) return { ok: false, error: title.error };
    const content = requiredStr(args, "content");
    if (!content.ok) return { ok: false, error: content.error };
    const rawKind = str(args, "kind");
    const kinds = ["fact", "preference", "person", "place", "project", "decision", "event"] as const;
    const kind = (kinds as readonly string[]).includes(rawKind ?? "") ? (rawKind as (typeof kinds)[number]) : "fact";
    return {
      ok: true,
      data: { title: title.value, kind },
      intent: { type: "remember", kind, title: title.value, content: content.value },
    };
  },
};

const createNote: ToolSpec = {
  name: "create_note",
  description: "Write something down that is not a task and not a fact about the user.",
  safety: "write",
  parameters: {
    type: "object",
    properties: { title: { type: "string" }, body: { type: "string" } },
    required: ["title", "body"],
  },
  handler: (args) => {
    const title = requiredStr(args, "title");
    if (!title.ok) return { ok: false, error: title.error };
    const body = requiredStr(args, "body");
    if (!body.ok) return { ok: false, error: body.error };
    return {
      ok: true,
      data: { title: title.value },
      intent: { type: "create_note", title: title.value, body: body.value },
    };
  },
};

const logHealth: ToolSpec = {
  name: "log_health",
  description:
    "Record part of the user's day: sleep, mood, steps or active minutes. Use only when they are reporting a measurement, and only the fields they actually gave.",
  safety: "write",
  parameters: {
    type: "object",
    properties: {
      sleepHours: { type: "number", description: "Hours slept, e.g. 7.5" },
      sleepQuality: { type: "number", description: "1 to 5" },
      mood: { type: "string", enum: MOODS },
      steps: { type: "number" },
      activeMinutes: { type: "number" },
    },
    required: [],
  },
  handler: (args) => {
    const num = (k: string): number | undefined => {
      const v = args[k];
      return typeof v === "number" && Number.isFinite(v) ? v : undefined;
    };
    const rawMood = str(args, "mood");
    const mood = MOODS.includes(rawMood as MoodLabel) ? (rawMood as MoodLabel) : undefined;

    const intent: ActionIntent = {
      type: "log_health",
      ...(num("sleepHours") !== undefined ? { sleepHours: num("sleepHours") } : {}),
      ...(num("sleepQuality") !== undefined ? { sleepQuality: num("sleepQuality") } : {}),
      ...(mood ? { mood } : {}),
      ...(num("steps") !== undefined ? { steps: num("steps") } : {}),
      ...(num("activeMinutes") !== undefined ? { activeMinutes: num("activeMinutes") } : {}),
    };
    // A body with no fields is refused rather than written: an empty day erases
    // a real reading by being misunderstood. The executor says the same thing;
    // saying it here means the model is told which field it forgot.
    if (Object.keys(intent).length <= 1) {
      return { ok: false, error: "no measurement given: supply at least one of sleepHours, mood, steps, activeMinutes" };
    }
    return { ok: true, data: { logged: Object.keys(intent).filter((k) => k !== "type") }, intent };
  },
};

const logMeal: ToolSpec = {
  name: "log_meal",
  description: "Note that the user has eaten. Only when they say they have.",
  safety: "write",
  parameters: {
    type: "object",
    properties: { meal: { type: "string", enum: MEALS } },
    required: [],
  },
  handler: (args) => {
    const raw = str(args, "meal");
    const meal = MEALS.includes(raw as MealName) ? (raw as MealName) : undefined;
    return { ok: true, data: { meal }, intent: { type: "log_meal", ...(meal ? { meal } : {}) } };
  },
};

const logHabit: ToolSpec = {
  name: "log_habit",
  description: "Tick off a habit the user has for today, e.g. meditation, a walk, reading.",
  safety: "write",
  resolves: [{ arg: "habit", kind: "habit" }],
  parameters: {
    type: "object",
    properties: { habit: { type: "string", description: "The habit's name." } },
    required: ["habit"],
  },
  handler: (args, ctx) => {
    const name = requiredStr(args, "habit");
    if (!name.ok) return { ok: false, error: name.error };
    const found = resolveHabit(name.value, ctx.lifeState);
    if (!found) return { ok: false, error: `no habit matches "${name.value}"` };
    return { ok: true, data: { habit: found.title }, intent: { type: "log_habit", habitId: found.id } };
  },
};

const protectBlock: ToolSpec = {
  name: "protect_block",
  description: "Ring-fence time for deep work on the calendar.",
  safety: "write",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      start: { type: "string", description: "Local, YYYY-MM-DDTHH:MM." },
      end: { type: "string", description: "Local, YYYY-MM-DDTHH:MM." },
      reason: { type: "string" },
    },
    required: ["title", "start", "end"],
  },
  handler: (args) => {
    const title = requiredStr(args, "title");
    if (!title.ok) return { ok: false, error: title.error };
    const start = requiredStr(args, "start");
    if (!start.ok) return { ok: false, error: start.error };
    const end = requiredStr(args, "end");
    if (!end.ok) return { ok: false, error: end.error };
    if (Number.isNaN(new Date(start.value).getTime()) || Number.isNaN(new Date(end.value).getTime())) {
      return { ok: false, error: "the start or end is not a date I can read" };
    }
    return {
      ok: true,
      data: { title: title.value },
      intent: {
        type: "protect_block",
        title: title.value,
        start: start.value,
        end: end.value,
        ...(str(args, "reason") ? { reason: str(args, "reason") as string } : {}),
      },
    };
  },
};

const startFocus: ToolSpec = {
  name: "start_focus",
  description: "Begin a focus session now, for a number of minutes.",
  safety: "write",
  parameters: {
    type: "object",
    properties: {
      label: { type: "string", description: "What they are working on." },
      minutes: { type: "number" },
    },
    required: ["label"],
  },
  handler: (args) => {
    const label = requiredStr(args, "label");
    if (!label.ok) return { ok: false, error: label.error };
    const raw = args.minutes;
    const minutes = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.min(240, Math.round(raw)) : 45;
    return { ok: true, data: { label: label.value, minutes }, intent: { type: "start_focus", label: label.value, minutes } };
  },
};

/* ------------------------------------------------------------------ */
/* Destructive tools - these get a confirmation gate                   */
/* ------------------------------------------------------------------ */

/**
 * Removal is `destructive` and gets a question, even though it goes to the
 * trash.
 *
 * The trash is a real safety net: seven days, one click to restore, and it is
 * why `./local`'s removal handler needs no confirmation at all when the *user*
 * asks in their own words. What is different here is that a model chose the
 * target, and the phrase it resolved may be one the user never said. The cost
 * of asking is one turn; the cost of guessing wrong is a task list that
 * silently lost something the user has not thought about yet.
 */
const deleteTask: ToolSpec = {
  name: "delete_task",
  description:
    "Remove a task. Goes to the trash, where it can be restored for seven days. Name the task; do not invent an id.",
  safety: "destructive",
  resolves: [{ arg: "task", kind: "task" }],
  parameters: {
    type: "object",
    properties: { task: { type: "string", description: "The task's title, or words from it." } },
    required: ["task"],
  },
  handler: (args, ctx) => {
    const name = requiredStr(args, "task");
    if (!name.ok) return { ok: false, error: name.error };
    const found = resolveTask(name.value, ctx.lifeState);
    if (!found) return { ok: false, error: `no open task matches "${name.value}"` };
    return { ok: true, data: { task: found.title }, intent: { type: "delete_task", taskId: found.id } };
  },
};

const forgetMemory: ToolSpec = {
  name: "forget_memory",
  description: "Forget a stored fact. Goes to the trash, restorable for seven days.",
  safety: "destructive",
  resolves: [{ arg: "memory", kind: "memory" }],
  parameters: {
    type: "object",
    properties: { memory: { type: "string", description: "The memory's title." } },
    required: ["memory"],
  },
  handler: (args, ctx) => {
    const name = requiredStr(args, "memory");
    if (!name.ok) return { ok: false, error: name.error };
    const found = resolveMemory(name.value, ctx.lifeState);
    if (!found) return { ok: false, error: `no memory matches "${name.value}"` };
    return { ok: true, data: { memory: found.title }, intent: { type: "forget_memory", memoryId: found.id } };
  },
};

export const WRITE_TOOLS: ToolSpec[] = [
  createTask,
  completeTask,
  updateTask,
  createEvent,
  createReminder,
  createGoal,
  rememberTool,
  createNote,
  logHealth,
  logMeal,
  logHabit,
  protectBlock,
  startFocus,
  deleteTask,
  forgetMemory,
];

/* ------------------------------------------------------------------ */
/* Read tools                                                          */
/* ------------------------------------------------------------------ */

/**
 * Reads return JSON and change nothing.
 *
 * They exist because the alternative is worse: without them, a question whose
 * answer is not already in the rendered LIFE STATE has to be answered from the
 * model's imagination or refused. "What did I decide about the launch" is a
 * question about a stored memory, not a reason to guess.
 *
 * Every one of these is a projection of the life state the caller already
 * assembled, so none of them touches the database, and none can be slow.
 */
function readTool(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  project: (ctx: ToolContext) => unknown,
): ToolSpec {
  return { name, description, parameters, safety: "read", handler: (_args, ctx) => ({ ok: true, data: project(ctx) }) };
}

export const READ_TOOLS: ToolSpec[] = [
  readTool("get_tasks", "The open task list, with due dates and projects.", { type: "object", properties: {}, required: [] }, (ctx) => ({
    openCount: ctx.lifeState.tasks.openCount,
    overdue: ctx.lifeState.tasks.overdue.map((t) => ({ title: t.title, due: t.due })),
    focus: ctx.lifeState.tasks.focus.slice(0, 12).map((t) => ({ title: t.title, due: t.due, project: t.project })),
    completedThisWeek: ctx.lifeState.tasks.completedThisWeek,
  })),
  planGoal,
  readTool("get_calendar", "Today's calendar and what is next.", { type: "object", properties: {}, required: [] }, (ctx) => ({
    today: ctx.lifeState.calendar.today.map((e) => ({ title: e.title, start: e.start, end: e.end, location: e.location })),
    next: ctx.lifeState.calendar.next ? { title: ctx.lifeState.calendar.next.title, start: ctx.lifeState.calendar.next.start } : undefined,
    freeMinutes: ctx.lifeState.calendar.freeMinutes,
  })),
  readTool("get_goals", "Every goal with its computed progress and pace.", { type: "object", properties: {}, required: [] }, (ctx) =>
    ctx.lifeState.goals.map(({ goal, progress }) => ({
      title: goal.title,
      horizon: goal.horizon,
      why: goal.why,
      targetDate: goal.targetDate,
      percent: Math.round(progress.progress * 100),
      pace: progress.pace,
      note: progress.note,
      milestones: goal.milestones.map((m) => ({ title: m.title, done: m.done, due: m.due })),
    })),
  ),
  readTool("get_memory", "The memories recall has surfaced for this conversation.", { type: "object", properties: {}, required: [] }, (ctx) =>
    ctx.lifeState.memory.slice(0, 10).map((hit) => ({
      title: hit.memory.title,
      content: hit.memory.content,
      kind: hit.memory.kind,
      pinned: hit.memory.pinned,
    })),
  ),
  readTool("get_energy", "The energy reading and the forecast behind it.", { type: "object", properties: {}, required: [] }, (ctx) => ({
    score: ctx.lifeState.energy.score,
    band: ctx.lifeState.energy.band,
    note: ctx.lifeState.energy.note,
    windows: ctx.lifeState.energy.windows,
  })),
  /**
   * Health, as its own tool.
   *
   * This was missing and it mattered: asked how her sleep had been tracking, the
   * model answered "I don't have sleep data - nothing I can see tracks it". The
   * life state was carrying sleep figures the whole time; there was simply no
   * tool that returned them, so the honest-sounding answer was wrong. That is
   * the same defect as the goals one, in a different corner, and it is the
   * reason the prompt now names every read tool explicitly.
   */
  readTool("get_health", "Sleep, mood, steps and active minutes - the latest reading, the averages, and the recent trend.", { type: "object", properties: {}, required: [] }, (ctx) => {
    const h = ctx.lifeState.health;
    return {
      latest: h.latest
        ? {
            date: h.latest.date,
            sleepHours: h.latest.sleepHours,
            sleepQuality: h.latest.sleepQuality,
            mood: h.latest.mood,
            steps: h.latest.steps,
            activeMinutes: h.latest.activeMinutes,
          }
        : undefined,
      sleepAvgHours: h.sleepAvgHours,
      sleepDebtHours: h.sleepDebtHours,
      /**
       * The mood trend is what the state actually carries.
       *
       * This tool originally tried to return a `recent` list of per-day samples,
       * which does not exist on `LifeState.health` - and the typecheck caught it,
       * which is the whole reason the tools are written against real types rather
       * than against what the model would like to have. The trend is the honest
       * available answer, and a per-day history would be a store query, i.e. a
       * different design, not a slip of the keyboard.
       */
      moodTrend: h.moodTrend,
    };
  }),
  readTool("get_habits", "Habits and how the week is going for each.", { type: "object", properties: {}, required: [] }, (ctx) =>
    ctx.lifeState.habits.map((h) => ({ name: h.name, thisWeek: h.thisWeek, target: h.targetPerWeek, streak: h.streak, atRisk: h.atRisk })),
  ),
  readTool("get_patterns", "Measured patterns the detectors found, with their evidence.", { type: "object", properties: {}, required: [] }, (ctx) =>
    ctx.lifeState.patterns.map((p) => ({ observation: p.observation, confidence: p.confidence, basis: p.basis, evidence: p.evidence })),
  ),
  readTool("get_day", "The headline summary of right now.", { type: "object", properties: {}, required: [] }, (ctx) => ({
    generatedAt: ctx.lifeState.generatedAt,
    partOfDay: ctx.lifeState.partOfDay,
    headline: ctx.lifeState.headline,
  })),
];

export const ALL_TOOLS: ToolSpec[] = [...READ_TOOLS, ...WRITE_TOOLS];

const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function findTool(name: string): ToolSpec | undefined {
  return BY_NAME.get(name);
}

/**
 * The catalog as the provider wants it.
 *
 * **The order is fixed and must stay fixed.** These definitions are part of the
 * cached prompt prefix, and the cache matches on an exact prefix: reordering
 * this array, or letting a tool's description change between calls in one
 * session, throws away the cache for every request that follows. A stable array
 * is worth more here than a tidier one, so nothing in this function is allowed
 * to depend on state. (Measured: a cache-hit token costs a fiftieth of a miss
 * on the current price list.)
 */
export function toolsJsonSchema(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return ALL_TOOLS.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/**
 * Parse the argument string a provider sent.
 *
 * Never throws. The vendor's own documentation warns the model "does not always
 * generate valid JSON", so a parse failure is an expected input rather than an
 * exception, and the message it produces is handed back to the model so it can
 * try again with a well-formed call.
 */
export function parseToolArguments(
  raw: string,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.trim().length === 0) return { ok: true, args: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "arguments must be a JSON object" };
    }
    return { ok: true, args: parsed as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      error: `arguments were not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Text that should have been a tool call                              */
/* ------------------------------------------------------------------ */

/**
 * Recover a tool call the model wrote as *prose* instead of calling.
 *
 * THE FAILURE THIS EXISTS FOR
 *
 * Observed live, on a real turn, with a real key. Asked to compare two things
 * from different corners of her own data, the model answered - in the reply the
 * user would have read on screen - with this:
 *
 *     <||DSML||tool_calls>
 *     <||DSML||invoke name="get_goals">
 *     </||DSML||invoke>
 *     <||DSML||tool_calls>
 *
 * The tool-call channel and the text channel are separate, and sometimes a model
 * writes its intended call into the wrong one. The result is worse than a
 * refusal: the user sees machine syntax, no tool runs, and because the turn
 * produced *something*, every honesty guard in the project passes it through
 * untouched. `guardUnmadeClaim` looks for a claim that a change happened; this
 * is not a claim, it is a rendering bug wearing the costume of an answer.
 *
 * So the markup is recognised and converted into the call the model meant. The
 * alternative - stripping it and letting the loop continue - would leave the
 * question unanswered while looking tidy, which is the same failure with the
 * evidence removed.
 *
 * The format is not documented and varies by provider and by day, so this
 * matches the *shape* rather than one exact string: any `<|...|>`-style fence
 * around an `invoke name="..."` with optional `<|...|>parameter name="..."`
 * children. When it matches nothing, the text is returned unchanged and nothing
 * downstream changes behaviour.
 */
export interface RecoveredCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * The fence characters a provider wraps a pseudo-tag in.
 *
 * Deliberately a character class rather than one literal, because the same model
 * produced `<||DSML||invoke>` and `<tool_call>` on two runs of the same question
 * (both observed live on 2026-10-09). Matching one exact string would have fixed
 * the instance and not the bug. `normaliseFences` is what consumes these.
 */
const FENCE = String.raw`(?:\|\||<\|)?`;

export function recoverTextToolCalls(content: string): { calls: RecoveredCall[]; cleaned: string } {
  if (typeof content !== "string" || content.length === 0) return { calls: [], cleaned: content ?? "" };

  /**
   * Matching happens against the *normalised* text, not the raw text.
   *
   * This is the fix for the turn that wasted four rounds: the model wrote the
   * DSML fence using U+FF5C FULLWIDTH VERTICAL LINE rather than the ASCII pipe,
   * the patterns here were built from ASCII, and so the recovery found nothing,
   * the announcement check found a tool name and asked again, and the same broken
   * output came back each time. Normalising once, at the top, is what makes every
   * pattern below indifferent to which spelling arrived.
   *
   * The reply the user sees is the normalised text with the markup removed, and
   * normalising only touches angle brackets and pipe runs, so a sentence that
   * never contained a fence comes through byte-identical.
   */
  const canonical = normaliseFences(content);

  const calls: RecoveredCall[] = [];
  let cleaned = canonical;

  /* --- Form 1: `<invoke name="x">...<parameter name="k">v</parameter>...</invoke>` --- */
  const invoke = new RegExp(
    String.raw`<[^>]*?invoke\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*?invoke\s*>`,
    "gi",
  );
  let match: RegExpExecArray | null;
  while ((match = invoke.exec(canonical)) !== null) {
    const args: Record<string, unknown> = {};
    const param = new RegExp(
      String.raw`<[^>]*?parameter\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*?parameter\s*>`,
      "gi",
    );
    let p: RegExpExecArray | null;
    while ((p = param.exec(match[2])) !== null) {
      args[p[1].trim()] = coerceScalar(p[2].replace(/<[^>]*>/g, "").trim());
    }
    calls.push({ name: match[1].trim(), args });
  }
  if (calls.length > 0) cleaned = cleaned.replace(invoke, " ");

  /* --- Form 2: `<tool_call>name</tool_call>` or `<tool_call>name{json}</tool_call>` --- */
  const bare = /<tool_calls?>([\s\S]*?)<\/tool_calls?>/gi;
  while ((match = bare.exec(canonical)) !== null) {
    const inner = match[1].trim();
    // `name`, `name {json}`, or a fenced function-call blob.
    const parts = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\{[\s\S]*\})?$/.exec(inner.replace(/^[`\s]+|[`\s]+$/g, ""));
    if (parts) {
      calls.push({ name: parts[1], args: parts[2] ? safeObject(parts[2]) : {} });
    }
  }
  if (calls.length > 0) cleaned = cleaned.replace(bare, " ");

  if (calls.length === 0) return { calls: [], cleaned: content };

  /**
   * Whatever is left of the markup goes, even if it did not parse.
   *
   * Some of the debris has no matching partner - the observed DSML blob ended
   * with a second opening `<||DSML||tool_calls>` and no close - so a tidy
   * removal of the matched blocks still leaves characters on screen. The user
   * must never read machine syntax, whether or not it was recoverable.
   */
  cleaned = stripToolMarkup(cleaned);
  return { calls, cleaned };
}

/**
 * Collapse the fence characters a provider wraps a pseudo-tag in.
 *
 * THE FENCES ARE NORMALISED FIRST, and that is the whole trick. Three spellings
 * arrived live in one afternoon - `<||DSML||invoke>`, `<|invoke>`,
 * `<tool_call>` - and a pattern built for each is a pattern that misses the
 * fourth. Reducing every variant to a bare `<invoke>` turns an open-ended set
 * into one shape.
 *
 * This is a scan rather than a regex, and it had to become one. The first
 * attempt used a pattern of the form angle-pipe-pipe, optional letters,
 * optional pipes - which looks reasonable and eats the tag name: on the string
 * "less-than pipe i-n-v-o-k-e" the optional [A-Za-z]* swallows the i, and the
 * result is "less-than n-v-o-k-e". It typechecked, it ran, and the only reason
 * it did not ship is that the suite asserts the *detector still fires after
 * normalising* - a test that only checked "is the markup gone" would have
 * passed, because the markup was gone. It had been replaced by nonsense.
 *
 * So inside a tag: drop `<`/`</`, then any run of `|`, then an optional literal
 * `DSML`, then any further run of `|`, then keep the rest. Nothing else is
 * touched, which is what makes it safe on ordinary prose - a sentence does not
 * open an angle bracket with a pipe.
 */
function normaliseFences(text: string): string {
  return (
    text
      /**
       * Full-width punctuation first, and this is not paranoia.
       *
       * The loop log from a real turn shows the model fencing its DSML tag with
       * U+FF5C FULLWIDTH VERTICAL LINE rather than the ASCII pipe (U+007C). The
       * two are indistinguishable in a terminal and in a code review, so the
       * first version of this function matched nothing while looking exactly like
       * it should have matched everything, and four rounds were wasted re-sending
       * the same broken output. (The literal characters are not written here on
       * purpose: `check-encoding.mjs` reads full-width punctuation in a source
       * file as a codepage accident, and it is right to - they arrive here as
       * U+FF5C escapes in the pattern below, which is unambiguous.)
       *
       * A model trained across scripts reaches for the full-width form of
       * punctuation the way it reaches for markdown. Folding these characters
       * costs nothing and is the difference between recovering the call and
       * showing the user machine syntax.
       */
      .replace(/[\uFF5C\uFE31\u2758\u2502\u01C0]/g, "|")
      .replace(/\uFF1C/g, "<")
      .replace(/\uFF1E/g, ">")
      /**
       * The marker goes, the tag name stays, and nothing is inserted.
       *
       * Three spellings arrive and all mean the same thing:
       *   `<||DSML||invoke>`   pipes tight against the tag
       *   `<||DSML|| invoke>`  a space before the name
       *   `</||DSML||invoke>`  closing
       *
       * The first version of this rewrote the match to a bracket and a slash and
       * relied on whatever followed the last pipe run to supply the name - which
       * is the tag name in a well-formed string and a *space* in the second form
       * above. That produced `< invoke`, the pattern below then failed to see
       * `invoke`, and the announcement check spent four rounds asking the model
       * to try again instead of recovering a perfectly good call. Consuming the
       * optional space explicitly is the fix; it is one character, and it was the
       * whole bug. The lesson generalises: a rewriting pass that assumes a
       * well-formed input is a rewriting pass that silently changes meaning on
       * the input that actually arrived.
       */
      .replace(/<\s*(\/?)\s*\|+\s*DSML\s*\|+\s*/gi, "<$1")
      // Any remaining pipe fence directly after the angle bracket: `<|invoke` -> `<invoke`.
      .replace(/<\s*(\/?)\s*\|+\s*/g, "<$1")
  );
}

/**
 * Remove anything that looks like tool-call machinery from a reply.
 *
 * Used both after a successful recovery and as a final safety net on *every*
 * reply the agent returns, because the shape of this markup is not documented
 * and a new variant appearing is a matter of when. A reply carrying unexplained
 * angle brackets is a bug the user sees; a reply with a sentence silently
 * removed is a smaller one, and the honest way to handle an unparseable call is
 * to strip it and let the loop's fallback say something true.
 */
export function stripToolMarkup(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text ?? "";

  const canonical = normaliseFences(text);
  if (!/<(?:tool_calls?|invoke|parameter)\b/i.test(canonical)) return text;

  return (
    canonical
      // Whole blocks, including a trailing one that never got closed.
      .replace(/<tool_calls?>[\s\S]*?(?:<\/tool_calls?>|$)/gi, " ")
      .replace(/<invoke\b[\s\S]*?(?:<\/invoke\s*>|$)/gi, " ")
      // Any straggler tag of the same families.
      .replace(/<\/?(?:tool_calls?|invoke|parameter)\b[^>]*>/gi, " ")
      /**
       * The final sweep, and it only runs because the text was already known to
       * contain markup.
       *
       * What is left by this point is debris from output that was cut off
       * mid-tag - the observed stream ended with `</DSML` and no closing bracket,
       * so the passes above could not match it and the user would have read
       * `</DSML` on screen. Every angle-bracketed token goes, because the
       * alternative is a cleverer pattern that misses the next variant.
       *
       * This is only safe because of the guard at the top of this function: a
       * reply with no tool markup in it returns untouched before reaching here,
       * so ordinary prose can never lose a comparison or a `<3`.
       */
      .replace(/<\/?[A-Za-z_][\w:.-]*\s*\/?>/g, " ")
      .replace(/<\/?\|*\|*[A-Za-z_]*\|*\|*/g, " ")
      // A bare fence marker with nothing after it.
      .replace(/<\|*\|*>/g, " ")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** Does this text carry tool-call machinery at all? */
export function looksLikeToolMarkup(text: string): boolean {
  if (typeof text !== "string") return false;
  return /<(?:tool_calls?|invoke)\b/i.test(normaliseFences(text));
}

function safeObject(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function coerceScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"))) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}
