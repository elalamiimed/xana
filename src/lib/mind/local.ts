/**
 * The local mind — Xana with no API key.
 *
 * This is not a stub. It is a deterministic intent engine that handles the
 * things a personal assistant is actually asked to do: capture, schedule,
 * complete, log, recall, brief, reflect. It parses the utterance, executes the
 * matching action through the real executor, and replies in her voice.
 *
 * Two design commitments:
 *
 *  1. **It refuses rather than guesses.** When nothing matches confidently it
 *     says so and offers what it can do. A wrong calendar entry is worse than
 *     an honest "I didn't follow that."
 *  2. **It reads the life state.** Answers about the day come from the same
 *     `LifeState` the UI renders, so the two can never disagree.
 */

import type {
  ActionIntent,
  Analysis,
  BriefingSection,
  Card,
  LifeState,
  Message,
} from "../core/types";
import { executeAction } from "../actions/executor";
import { parseDuration, parseWhen, stripWhen } from "../core/nlp";
import {
  addDays,
  daysBetween,
  formatDay,
  formatTime,
  humanDuration,
  minutesBetween,
  nowIso,
  toDateKey,
  uid,
} from "../core/time";

export interface LocalMindInput {
  text: string;
  lifeState: LifeState;
  sessionId?: string;
  modality?: "text" | "voice";
}

export interface LocalMindOutput {
  text: string;
  cards?: Card[];
  outcome?: Message["outcome"];
  recalled?: Message["recalled"];
}

const CAPABILITY_GROUPS = [
  {
    label: "capture",
    items: [
      "remind me to call Mom Friday",
      "add a task to review the Aurora deck",
      "note that the plumber quoted 340",
      "remember I prefer mornings for deep work",
    ],
  },
  {
    label: "track",
    items: [
      "log meditation",
      "set a goal to run a half marathon by June",
      "how are my goals doing",
      "reflect on this week",
    ],
  },
  {
    label: "ask",
    items: ["what's my day look like", "what did I decide about the launch", "brief me", "what should I focus on"],
  },
  {
    label: "focus",
    items: ["start a 45 minute focus session on the parser", "protect tomorrow 9 to 11 for deep work"],
  },
];

/** Small helper for the many "did the user say one of these" checks. */
function any(text: string, ...patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/* ------------------------------------------------------------------ */
/* Intent routing                                                      */
/* ------------------------------------------------------------------ */

type Handler = (input: LocalMindInput) => LocalMindOutput | undefined;

/**
 * "remove X", "delete the dentist thing", "clear the list", "cancel the four o'clock"
 *
 * WHY THIS IS FIRST IN THE LIST
 *
 * Every other handler here adds something. This one removes, and a removal verb
 * must never be shadowed by a constructive one — "drop the review" reaching a
 * handler that reads "review" as a title to capture would turn a deletion into a
 * duplicate. It runs first so the destructive reading always wins.
 *
 * THE BULK FORM IS THE ONE PEOPLE ACTUALLY USE
 *
 * "Remove everything" is what someone says when a list has stopped being a plan
 * and become a reproach, and it is exactly the request that produced this
 * handler: the app had no way to take anything out at all, so the only honest
 * answer was a sentence about what it could not do. It goes to the trash, in one
 * piece, and she says so.
 *
 * When a phrase names something, the name is resolved against what she can see —
 * tasks, the calendar, the board, memory — and if nothing matches she says so
 * rather than removing the nearest thing. An assistant that guesses at "remove
 * the proposal" is one you stop asking.
 */
const REMOVAL = /^(?:please\s+|can you\s+|could you\s+|xana,?\s+)*(?:remove|delete|trash|drop|scrap|cancel|bin|forget|clear|empty|wipe)\b\s*(.*)$/i;

/**
 * What counts as "everything".
 *
 * The list, the tasks, or the word everything — and deliberately not a bare
 * pronoun. "Forget it" and "drop it" are how people end a subject, not how they
 * ask for the whole task list to be removed, and a bulk delete that a
 * conversational tic can trigger is a bulk delete nobody should ship.
 */
const BULK_TARGET = /^(?:everything|all)\b/i;
const BULK_NOUN = /^(?:whole\s+)?(?:list|tasks?|to-?dos?)$/i;

/** A target that names nothing: "remove it", "delete that". */
const PRONOUN_TARGET = /^(?:it|that|this|them|those|these|him|her)\b/i;

const handleDelete: Handler = ({ text, lifeState, sessionId }) => {
  const m = REMOVAL.exec(text.trim());
  if (!m) return undefined;

  const raw = (m[1] ?? "").trim().replace(/[.!?]+$/, "");
  const target = raw.replace(/^(?:the|that|those|my|all of the|about)\s+/i, "").trim();
  if (!target) return undefined;

  if (BULK_TARGET.test(target) || BULK_NOUN.test(target)) {
    const outcome = executeAction({ type: "clear_tasks" }, { sessionId });
    return { text: "", outcome };
  }

  // "Forget it" is a sentence, not an instruction.
  if (PRONOUN_TARGET.test(target)) return undefined;

  const found = removalTarget(target, lifeState);
  if (!found) {
    /**
     * How loudly to fail depends on how it was asked.
     *
     * "Remove the dentist thing" named something and could not find it, and
     * saying so is the useful answer. "Forget about my tasks for now and let's
     * talk about this loneliness thing" merely begins with a verb this handler
     * owns, and answering it with a list-matching complaint would be the app
     * arguing with a sentence that was never a request. So a long phrase falls
     * through to the rest of the mind, where it belongs.
     */
    if (target.split(/\s+/).filter(Boolean).length > 5) return undefined;
    return {
      text: `Nothing I can see matches "${target}". Give me the wording from the list and I'll take it out.`,
      outcome: { ok: false, effect: "removal.missing", message: "" },
    };
  }

  const outcome = executeAction(found.intent, { sessionId });
  return { text: "", outcome };
};

/**
 * What "the dentist thing" means, if anything.
 *
 * Tasks first: they are the long list, the one with duplicates and stale items,
 * and the one people ask to be pruned. Then the calendar, then the board, then
 * memory — each step is a smaller and more deliberate collection than the last,
 * and a phrase that matches a task and a memory should remove the task.
 */
function removalTarget(
  phrase: string,
  state: LifeState,
): { intent: ActionIntent; label: string } | undefined {
  const task = bestTaskMatch(phrase, state);
  if (task) return { intent: { type: "delete_task", taskId: task.id }, label: task.title };

  // Today's calendar, plus whatever is next when it is not today — the life
  // state carries one "next" rather than a second day, and a phrase like
  // "cancel the standup" usually means the one that is coming.
  const events = [...state.calendar.today, ...(state.calendar.next ? [state.calendar.next] : [])];
  const event = bestMatch(phrase, events.map((e) => ({ id: e.id, title: e.title })));
  if (event) return { intent: { type: "delete_event", eventId: event.id }, label: event.title };

  const goal = bestMatch(phrase, state.goals.map((g) => ({ id: g.goal.id, title: g.goal.title })));
  if (goal) return { intent: { type: "delete_goal", goalId: goal.id }, label: goal.title };

  const memory = bestMatch(phrase, state.memory.map((hit) => ({ id: hit.memory.id, title: hit.memory.title })));
  if (memory) return { intent: { type: "forget_memory", memoryId: memory.id }, label: memory.title };

  return undefined;
}

/** "remind me to X", "reminder: X", "don't let me forget X"
 *
 * A day without a clock time keeps the day but not midnight: "Friday at 12:00
 * AM" is the wrong thing to say back to someone who said "Friday".
 */
const handleReminder: Handler = ({ text, sessionId }) => {
  const m = /(?:remind me(?: to| about)?|reminder[:\s]+|don'?t let me forget(?: to)?|ping me(?: to)?)\s+(.+)/i.exec(text);
  if (!m) return undefined;

  const body = m[1].trim();
  const when = parseWhen(body);
  const title = when ? stripWhen(body, when.matched) || body : body;

  const remindAt = when?.date ?? defaultReminderTime();
  const outcome = executeAction(
    {
      type: "create_reminder",
      text: title,
      remindAt: remindAt.toISOString(),
      // Carried through so the confirmation does not invent a clock time the
      // user never gave.
      hasTime: when?.hasTime ?? true,
    },
    { sessionId },
  );

  // The executor's message already states the day; add nothing here.
  return { text: "", outcome };
};

/** "add a task to X", "todo: X", "I need to X" */
const handleTask: Handler = ({ text, lifeState, sessionId }) => {
  const explicit = /(?:add (?:a )?task(?: to)?|new task[:\s]+|todo[:\s]+|to-?do[:\s]+|task[:\s]+)\s*(.+)/i.exec(text);
  const implicit = /^(?:i (?:need|have|ought) to|i should|i must|don'?t forget to)\s+(.+)/i.exec(text);
  const m = explicit ?? implicit;
  if (!m) return undefined;

  const body = m[1].trim();
  const when = parseWhen(body);
  const title = when ? stripWhen(body, when.matched) || body : body;
  if (title.length < 2) return undefined;

  const priority: 1 | 2 | 3 | 4 = /\b(urgent|asap|critical|top priority)\b/i.test(body) ? 1 : 3;
  const estimate = parseDuration(body);
  const project = /#([A-Za-z][\w-]*)/.exec(body)?.[1];

  const outcome = executeAction(
    {
      type: "create_task",
      title,
      due: when?.date.toISOString(),
      priority,
      estimateMinutes: estimate,
      project,
    },
    { sessionId },
  );

  const whenPhrase = when ? ` for ${formatDay(when.date)}` : lifeState.tasks.openCount > 6 ? ", and the list is long — I'd put it this week" : "";
  return { text: `Captured${whenPhrase}.`, outcome };
};

/**
 * "schedule X", "book a meeting with Sam Thursday at 2"
 *
 * Deliberately narrow. "Book the flights" is a *task*, not an appointment —
 * treating booking verbs as scheduling is how an assistant quietly fills a
 * calendar with to-dos. An event requires either an explicit scheduling noun
 * (meeting, call, event, appointment, lunch) or a clock time.
 */
const handleEvent: Handler = ({ text, sessionId }) => {
  const m = /(?:schedule|add (?:an? )?(?:event|meeting|appointment)|set up|put)\s+(?:a\s+)?(?:meeting\s+|call\s+|event\s+|appointment\s+)?(.+)/i.exec(text)
    ?? /book\s+(?:a\s+)?(meeting|call|appointment|lunch|dinner|room|table)\b(.*)/i.exec(text);
  if (!m) return undefined;

  const body = m[1].trim() + (m[2] ?? "");
  const when = parseWhen(body);
  if (!when) return undefined; // Booking without a time is how calendars rot.

  // Without a clock time, only explicit scheduling nouns justify an event.
  const hasSchedulingNoun = /\b(meeting|call|event|appointment|lunch|dinner|review|sync|standup|stand-up|1:1|one-on-one|interview|demo)\b/i.test(body);
  if (!when.hasTime && !hasSchedulingNoun) return undefined;

  const rawTitle = stripWhen(body, when.matched) || body;
  const title = rawTitle
    .replace(/^(?:a|an|the)\s+/i, "")
    .replace(/\b(?:meeting|call|event)\s+(?:with|about)\s+/i, (s) => (s.toLowerCase().startsWith("meeting") ? "with " : s))
    .trim();

  const minutes = parseDuration(body) ?? 60;
  const start = when.hasTime ? when.date : withHour(when.date, 10);
  const end = new Date(start.getTime() + minutes * 60_000);

  const outcome = executeAction(
    { type: "create_event", title: title || "Untitled", start: start.toISOString(), end: end.toISOString() },
    { sessionId },
  );
  return { text: "", outcome };
};

/** "mark X done", "I finished X", "X is done" */
const handleComplete: Handler = ({ text, lifeState, sessionId }) => {
  const m = /(?:mark|tick)\s+(.+?)\s+(?:as\s+)?(?:done|complete|finished)|(?:i(?:'ve)?\s+)?(?:finished|completed|done with)\s+(.+)|^(.+?)\s+is done$/i.exec(text);
  if (!m) return undefined;
  const phrase = (m[1] ?? m[2] ?? m[3] ?? "").trim();
  if (phrase.length < 2) return undefined;

  const match = bestTaskMatch(phrase, lifeState);
  if (!match) {
    return {
      text: `Nothing open matches "${phrase}". Give me the wording and I'll close it.`,
      outcome: { ok: false, effect: "task.missing", message: "" },
    };
  }
  const outcome = executeAction({ type: "complete_task", taskId: match.id }, { sessionId });
  return { text: "", outcome };
};

/** "log meditation", "did my run", "meditation done" */
const handleHabit: Handler = ({ text, lifeState, sessionId }) => {
  const m = /^(?:log|did|done with|tick off|check off)\s+(?:my\s+)?(.+?)(?:\s+(?:today|just now|done))?$/i.exec(text);
  if (!m) return undefined;
  const name = m[1].trim().toLowerCase();
  if (name.length < 2) return undefined;

  const habit = lifeState.habits.find(
    (h) => h.name.toLowerCase() === name || h.name.toLowerCase().includes(name) || name.includes(h.name.toLowerCase()),
  );
  if (!habit) return undefined;

  const outcome = executeAction({ type: "log_habit", habitId: habit.id }, { sessionId });
  return { text: "", outcome };
};

/** "remember that X", "note that X", "keep in mind X" */
const handleRemember: Handler = ({ text, sessionId }) => {
  const m = /(?:remember(?: that)?|keep in mind(?: that)?|note that|make a note that|for the record,?)\s+(.+)/i.exec(text);
  if (!m) return undefined;
  const content = m[1].trim();
  if (content.length < 4) return undefined;

  const outcome = executeAction(
    {
      type: "remember",
      kind: "fact",
      title: content.length > 70 ? `${content.slice(0, 67)}…` : content,
      content,
    },
    { sessionId },
  );
  return { text: "Filed. I'll bring it up when it's relevant.", outcome };
};

/** "save a note: X", "journal: X" */
const handleNote: Handler = ({ text, sessionId }) => {
  const m = /(?:save (?:a )?note|new note|journal|note to self)[:\s]+(.+)/i.exec(text);
  if (!m) return undefined;
  const body = m[1].trim();
  if (body.length < 3) return undefined;

  const firstLine = body.split(/[.\n]/)[0].trim();
  const title = firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine || "Note";
  const outcome = executeAction({ type: "create_note", title, body }, { sessionId });
  return { text: "", outcome };
};

/** "set a goal to X by June" */
const handleGoal: Handler = ({ text, sessionId }) => {
  const m = /(?:set (?:a )?goal(?: to)?|new goal[:\s]+|my goal is(?: to)?|i want to)\s+(.+)/i.exec(text);
  if (!m) return undefined;
  const body = m[1].trim();

  const when = parseWhen(body);
  const title = (when ? stripWhen(body, when.matched) || body : body).replace(/^(?:to|that)\s+/i, "").trim();
  if (title.length < 3) return undefined;

  const horizon: "short" | "mid" | "long" = when
    ? addDays(new Date(), 100) > when.date
      ? "short"
      : addDays(new Date(), 400) > when.date
        ? "mid"
        : "long"
    : /marathon|book|launch|learn|master|year/i.test(title)
      ? "long"
      : "mid";

  const outcome = executeAction(
    { type: "create_goal", title, horizon, targetDate: when?.date.toISOString().slice(0, 10) },
    { sessionId },
  );
  return { text: "", outcome };
};

/** "start a 45 minute focus session on X" */
const handleFocus: Handler = ({ text, lifeState, sessionId }) => {
  const m = /(?:start|begin)\s+(?:a\s+)?(?:(\d{1,3})\s*(?:min|minute)s?\s+)?focus(?:\s+session)?(?:\s+on\s+(.+))?/i.exec(text);
  if (!m) return undefined;
  const minutes = m[1] ? Number(m[1]) : 45;
  const label = (m[2] ?? lifeState.tasks.focus[0]?.title ?? "focused work")
    // Strip the article and any coordinating words so the session is titled
    // "scheduler", not "on the scheduler".
    .replace(/^(?:on|for|about)\s+/i, "")
    .replace(/^(?:a|an|the)\s+/i, "")
    .trim() || "focused work";
  const outcome = executeAction({ type: "start_focus", label, minutes }, { sessionId });
  return { text: "", outcome };
};

/** "protect tomorrow 9 to 11 for deep work" */
const handleProtect: Handler = ({ text, sessionId }) => {
  const m = /protect\s+(.+)/i.exec(text);
  if (!m) return undefined;
  const body = m[1].trim();
  const when = parseWhen(body);
  if (!when) return undefined;

  const range = /(\d{1,2})(?::(\d{2}))?\s*(?:to|-|until|–)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(body);
  let start = when.date;
  let end: Date;
  if (range) {
    const sh = Number(range[1]);
    const sm = range[2] ? Number(range[2]) : 0;
    let eh = Number(range[3]);
    const em = range[4] ? Number(range[4]) : 0;
    const meridiem = range[5];
    const adjust = (h: number) => {
      if (meridiem?.toLowerCase() === "pm" && h < 12) return h + 12;
      if (meridiem?.toLowerCase() === "am" && h === 12) return 0;
      if (!meridiem && h >= 1 && h <= 6) return h + 12;
      return h;
    };
    start = new Date(when.date);
    start.setHours(adjust(sh), sm, 0, 0);
    end = new Date(when.date);
    end.setHours(adjust(eh), em, 0, 0);
    if (end <= start) end.setDate(end.getDate() + 1);
  } else {
    end = new Date(start.getTime() + 90 * 60_000);
  }

  const label = stripWhen(body, when.matched)
    .replace(/\b(?:for|to do|to work on)\b/gi, "")
    .replace(/\d{1,2}(?::\d{2})?\s*(?:to|-|until|–)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i, "")
    .replace(/\s+/g, " ")
    .trim() || "deep work";

  const outcome = executeAction(
    { type: "protect_block", title: label, start: start.toISOString(), end: end.toISOString() },
    { sessionId },
  );
  return { text: "", outcome };
};

/**
 * What she says when she briefs you.
 *
 * This used to be nothing at all: both briefing paths returned `text: ""` and
 * let the lead-in table supply a fixed sentence. "Here's the shape of it."
 * read perfectly well and was identical every day, every schedule and every
 * mood — the most-stated line in the product and the least informed by it.
 *
 * The reply is assembled from the life state instead, starting with the piece
 * that already answers "what is this moment": `headline` names the critical
 * nudge, else the imminent event, else what is due, and it is computed from
 * the state rather than chosen from a list.
 *
 * What it deliberately does not do is repeat the card. The card carries the
 * schedule, the overdue list, the focus list, the habits and the weather; a
 * reply that restated them would be a wall of text above a wall of text. So
 * this is the headline plus at most one thing the headline left out. Brevity
 * here is not a style preference — it is what keeps the card worth reading.
 *
 * Exported so `scripts/check-briefing.ts` can assert it responds to the state.
 * The wording is free to change; the responsiveness is not.
 */
export function localBriefingReply(state: LifeState): string {
  const parts = [state.headline];

  // The one thing the headline has no room for: whether there is anything to
  // spend. Only mentioned when energy is actually low, because "you are fine"
  // is noise.
  //
  // The first sentence only. A low-energy note is itself two sentences — the
  // signal and then what to do about it — and taking all of it pushed the
  // briefing to three. The advice belongs in the card's note, where the reader
  // has already decided to look; repeating it here makes the reply the wall of
  // text this function exists to avoid.
  if (state.energy.band === "low") {
    const signal = state.energy.note.split(/(?<=[.!?])\s+/)[0]?.trim();
    if (signal) parts.push(signal);
  }

  return parts.join(" ");
}

/** "brief me", "catch me up", "what's going on" */
const handleBrief: Handler = ({ text, lifeState }) => {
  if (
    !any(
      text,
      /\bbrief(?:ing)?\b/i,
      /\bcatch me up\b/i,
      /\bwhat'?s (?:going on|happening)\b/i,
      /\bfill me in\b/i,
      /\bupdate me\b/i,
      /\bsummar(?:y|ise|ize)\b/i,
    )
  ) {
    return undefined;
  }
  return { text: localBriefingReply(lifeState), cards: [briefingCard(lifeState)] };
};

/** "reflect on this week" */
const handleReflect: Handler = ({ text, sessionId }) => {
  if (!any(text, /\breflect\b/i, /\bhow (?:was|did) (?:my|this) (?:week|month)\b/i)) return undefined;
  const period = /\bmonth\b/i.test(text) ? "monthly" : "weekly";
  const outcome = executeAction({ type: "reflect", period }, { sessionId });
  return { text: "", outcome, cards: [] };
};

/** "how are my goals" */
const handleGoals: Handler = ({ text, lifeState }) => {
  if (!any(text, /\bgoals?\b/i, /\bhow am i doing\b/i)) return undefined;
  if (lifeState.goals.length === 0) {
    return { text: "No goals on the board yet. Tell me one and I'll track it." };
  }
  return {
    text: "",
    cards: [
      {
        kind: "goals",
        title: "Where things stand",
        items: lifeState.goals.map(({ goal, progress }) => ({
          id: goal.id,
          title: goal.title,
          horizon: goal.horizon,
          progress: progress.progress,
          pace: progress.pace,
          note: progress.note,
        })),
      },
    ],
  };
};

/**
 * Questions about the day itself.
 *
 * The patterns are anchored to phrases rather than bare words. An earlier
 * `/\b(?:my|the) day\b/` matched "Mon**day**" and "birth**day**", so nonsense
 * input like "flurble the womp" could return a briefing by accident.
 */
const handleDayQuestion: Handler = ({ text, lifeState }) => {
  const asks = any(
    text,
    /\b(?:my|the) (?:day|schedule|calendar)\b/i,
    /\bwhat'?s next\b/i,
    /\bwhat(?:'s| is) (?:on|coming up)\b/i,
    /\bwhat should i (?:focus|do|work on)\b/i,
    /\bhow does (?:my|the) day\b/i,
    /\banything (?:today|scheduled|on today)\b/i,
    /^\s*(?:my|the) (?:day|schedule)\s*\??\s*$/i,
  );
  if (!asks) return undefined;
  return { text: localBriefingReply(lifeState), cards: [briefingCard(lifeState)] };
};

/**
 * Is the user *reporting* their energy, or *asking* about it?
 *
 * "energy 3" is a report; "how's my energy" is a question. They arrive through
 * the same word, so the deciding question is whether a level is present. The
 * distinction matters because the two do opposite things: one writes the only
 * self-reported number in the app, the other reads a forecast.
 */
function energyLevelIn(text: string): number | undefined {
  const words: Array<[RegExp, number]> = [
    [/\b(?:empty|exhausted|drained|wiped|shattered|running on empty)\b/i, 1],
    [/\b(?:low|tired|sluggish|flat|foggy|rough)\b/i, 2],
    [/\b(?:steady|ok|okay|fine|alright|average|normal|middling)\b/i, 3],
    [/\b(?:sharp|good|strong|solid|clear|fresh)\b/i, 4],
    [/\b(?:peak|great|excellent|brilliant|unstoppable|on fire)\b/i, 5],
  ];

  // Explicit coordinates first: "3/5", "energy: 4", "energy 2". The filler
  // words matter — "my energy is 4" and "energy level 4" are how people
  // actually type it, and a pattern that only accepts a bare adjacency misses
  // both while still looking like it works.
  const explicit =
    /\b([1-5])\s*\/\s*5\b/i.exec(text) ??
    /\benergy\b(?:\s+(?:level|rating|score|reading|is|at|of|around|about|like|today|now|this\s+\w+)){0,3}[^0-9a-z]{0,3}([1-5])\b/i.exec(
      text,
    );
  if (explicit) return Number(explicit[1]);

  // Sentences that are about a level by their shape. "at 3" on its own is not
  // enough — "at 3" is also a time, and this must not swallow it.
  const phrased =
    /\b(?:i(?:'m| am)|feeling|feel|rating|rate|score|put me)\b[^.!?]{0,24}?\b([1-5])\b/i.exec(text) ??
    /\b([1-5])\s*(?:out of|\/)\s*(?:5|five)\b/i.exec(text);
  if (phrased) return Number(phrased[1]);

  for (const [pattern, level] of words) {
    if (pattern.test(text)) return level;
  }
  return undefined;
}

/** "energy 3", "I'm at 2 today", "feeling a 4". Writes the reading. */
const handleLogEnergy: Handler = ({ text, sessionId }) => {
  const level = energyLevelIn(text);
  if (level === undefined) return undefined;
  const outcome = executeAction({ type: "log_energy", level }, { sessionId });
  return { text: "", outcome };
};

/**
 * "had lunch", "ate breakfast", "just ate".
 *
 * Narrow on purpose. A meal word has to appear with the act of eating, so
 * "lunch with Sam at 1" is a scheduling request rather than a claim to have
 * eaten, and the briefing does not get a meal logged for a plan.
 */
const handleLogMeal: Handler = ({ text, sessionId }) => {
  const ate = /\b(?:had|ate|eating|eaten|finished|done with|logging|log)\b/i.test(text);
  const mealWord = /\b(breakfast|lunch|dinner|supper|snack)\b/i.exec(text)?.[1]?.toLowerCase();
  const bare = /\b(?:just ate|i ate|already ate)\b/i.test(text);
  if (!ate && !bare) return undefined;
  if (!mealWord && !bare) return undefined;

  const meal = mealWord === "supper" ? "dinner" : (mealWord as "breakfast" | "lunch" | "dinner" | "snack" | undefined);
  const outcome = executeAction({ type: "log_meal", meal }, { sessionId });
  return { text: "", outcome };
};

/** Energy, in its own words. */
const handleEnergy: Handler = ({ text, lifeState }) => {
  if (!any(text, /\benergy\b/i, /\bhow am i (?:doing|feeling)\b/i, /\btired\b/i)) return undefined;
  return {
    text: "",
    cards: [
      {
        kind: "energy",
        title: "Energy",
        score: lifeState.energy.score,
        band: lifeState.energy.band,
        note: lifeState.energy.note,
        windows: lifeState.energy.windows,
      },
    ],
  };
};

/** Recall: "what did I decide about the launch" */
const handleRecall: Handler = ({ text, lifeState }) => {
  if (!any(text, /\bwhat did i\b/i, /\bremind me (?:what|about)\b/i, /\bwhat do you (?:know|remember)\b/i, /\bdid i (?:decide|say|mention)\b/i, /\bwhat was\b/i)) {
    return undefined;
  }
  if (lifeState.memory.length === 0) {
    return { text: "Nothing in memory on that yet." };
  }
  return {
    text: "",
    cards: [
      {
        kind: "recall",
        title: "From memory",
        hits: lifeState.memory.map((hit) => ({
          id: hit.memory.id,
          title: hit.memory.title,
          content: hit.memory.content,
          score: hit.score,
          kind: hit.memory.kind,
        })),
      },
    ],
    recalled: lifeState.memory.map((h) => ({ id: h.memory.id, title: h.memory.title, score: h.score })),
  };
};

/** Greetings — the social floor. Short, not chirpy. */
const handleGreeting: Handler = ({ text, lifeState }) => {
  if (!/^\s*(?:hey|hi|hello|yo|morning|good morning|evening|good evening|afternoon|good afternoon|xana)[\s!.,]*$/i.test(text)) {
    return undefined;
  }
  const lines = lifeState.headline?.trim();
  return { text: lines ? `${greetingFor(lifeState.partOfDay)}. ${lines}` : `${greetingFor(lifeState.partOfDay)}.` };
};

/** Help. */
const handleHelp: Handler = ({ text }) => {
  if (!any(text, /\bwhat can you\b/i, /\bhelp\b/i, /\bcapabilit/i, /\bwhat do you do\b/i)) return undefined;
  return { text: "", cards: [{ kind: "capabilities", title: "What I can do", groups: CAPABILITY_GROUPS }] };
};

/*
 * Order is precedence. Specific, unambiguous phrasing runs first; the fuzzy
 * fallbacks (observational replies) only get a turn once nothing matched.
 */
/**
 * Order matters, and it is the only place in this file where it does.
 *
 * `handleComplete` matches "finished X" and resolves X against the task list,
 * so it has to run *after* the two handlers that read a fixed vocabulary —
 * energy and meals. "finished dinner" is a meal, and "finished" on its own
 * looks exactly like completing a task. Everything else here keys off nouns
 * that do not collide, so the rest of the order is free.
 */
const HANDLERS: Handler[] = [
  // First, because it is the only one that removes anything: a destructive verb
  // must not be shadowed by a handler that would read the same words as
  // something to add. See the note on `handleDelete`.
  handleDelete,
  handleReminder,
  handleNote,
  handleRemember,
  handleProtect,
  handleFocus,
  handleGoal,
  handleHabit,
  handleReflect,
  handleLogEnergy,
  handleLogMeal,
  handleComplete,
  handleEvent,
  handleTask,
  handleBrief,
  handleDayQuestion,
  handleEnergy,
  handleGoals,
  handleRecall,
  handleHelp,
  handleGreeting,
];

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function localMind(input: LocalMindInput): LocalMindOutput {
  const text = input.text.trim();
  if (text.length === 0) return { text: "I'm here." };

  for (const handler of HANDLERS) {
    let result: LocalMindOutput | undefined;
    try {
      result = handler(input);
    } catch {
      // A handler must never break the conversation.
      continue;
    }
    if (!result) continue;

    // A handler that performed an action returns the executor's sentence,
    // which is already written in her voice.
    if (result.outcome?.message) {
      return { ...result, text: result.outcome.message };
    }
    if (result.cards?.length || result.text) {
      // A card is never dropped in silently: if the handler supplied no words,
      // introduce it. `leadInFor` is exhaustive over Card kinds, so this cannot
      // come back empty.
      return { ...result, text: result.text || leadInFor(result.cards) };
    }
    if (result.outcome && !result.outcome.ok) {
      return { ...result, text: result.outcome.message || "That didn't take." };
    }
  }

  /* --- Nothing matched. Answer what we can, then be honest. --- */
  const observation = observationalReply(text, input.lifeState);
  if (observation) return { text: observation };

  return {
    text:
      "I didn't follow that. I'm better with concrete things — capturing, scheduling, logging, or telling you where the day stands. Ask me what I can do if you want the list.",
  };
}

/**
 * A sentence to introduce a card, so a card is never dropped in silently.
 *
 * This is the fallback, not the usual path: a handler that can say something
 * grounded supplies its own text, as the briefing now does. It exists for the
 * case where a card is attached with nothing to say about it, and it is
 * deliberately plain rather than characterful — a generic line pretending to
 * be a considered one is worse than an obvious placeholder.
 */
function leadInFor(cards: Card[] | undefined): string {
  switch (cards?.[0]?.kind) {
    case "briefing": return "Here's the day.";
    case "goals": return "Here's where they stand.";
    case "energy": return "Reading the day.";
    case "recall": return "This is what I have.";
    case "capabilities": return "This is the shape of me.";
    case "reflection": return "Here's the picture.";
    case "pattern": return "Something I noticed.";
    case "focus": return "Blocked out.";
    case "tasks": return "Here's the list.";
    default: return "Here's what I have.";
  }
}

/**
 * Last resort: does the utterance contain a word that matches something in the
 * life state? If so, say the useful thing rather than admitting defeat.
 */
function observationalReply(text: string, state: LifeState): string | undefined {
  const words = text.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  if (words.length === 0) return undefined;

  const task = state.tasks.focus.find((t) => words.some((w) => t.title.toLowerCase().includes(w)));
  if (task) {
    const due = task.due ? ` Due ${formatDay(task.due)}.` : "";
    return `"${task.title}" is open.${due} Want it closed?`;
  }

  const event = state.calendar.today.find((e) => words.some((w) => e.title.toLowerCase().includes(w)));
  if (event) {
    return `"${event.title}" is at ${formatTime(event.start)}${event.location ? ` in ${event.location}` : ""}.`;
  }

  const memory = state.memory.find((m) =>
    words.some((w) => `${m.memory.title} ${m.memory.content}`.toLowerCase().includes(w)),
  );
  if (memory) {
    return `${memory.memory.title}. ${memory.memory.content.slice(0, 160)}`;
  }

  return undefined;
}

/* ------------------------------------------------------------------ */
/* Cards                                                               */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* The briefing                                                        */
/* ------------------------------------------------------------------ */

/**
 * The next thing on the calendar, and what follows it.
 *
 * "Next" means next: an event that has not started yet. An event currently
 * running is the *focus* section's business, not this one — showing a meeting
 * that started twenty minutes ago under a heading that says "next" is how a
 * briefing teaches someone to stop trusting it.
 */
function nextEvent(state: LifeState, now: Date) {
  const upcoming = state.calendar.today
    .filter((e) => !e.allDay && new Date(e.start) > now)
    .sort((a, b) => a.start.localeCompare(b.start));
  return upcoming[0];
}

/** The event happening right now, if one is. */
function runningEvent(state: LifeState, now: Date) {
  return state.calendar.today
    .filter((e) => !e.allDay)
    .find((e) => new Date(e.start) <= now && new Date(e.end) > now);
}

/** The next window the forecast thinks is worth spending. */
function nextFocusWindow(state: LifeState, now: Date) {
  const hour = now.getHours();
  return state.energy.windows
    .filter((w) => w.endHour > hour)
    .sort((a, b) => b.confidence - a.confidence)[0];
}

/** Overdue, and the dated work that is not late yet. */
function openWork(state: LifeState, now: Date) {
  const overdue = state.tasks.overdue.map((t) => ({
    id: t.id,
    title: t.title,
    daysLate: t.due ? Math.max(1, Math.abs(daysBetween(now, new Date(t.due)))) : 1,
  }));

  const upcoming = state.tasks.focus
    .filter((t) => t.due && new Date(t.due) >= now && !overdue.some((o) => o.id === t.id))
    .map((t) => ({
      id: t.id,
      title: t.title,
      due: t.due as string,
      daysAway: Math.max(0, daysBetween(now, new Date(t.due as string))),
    }))
    .sort((a, b) => a.due.localeCompare(b.due))
    .slice(0, 3);

  /**
   * The day's biggest block.
   *
   * "Biggest" is duration rather than importance, because duration is the only
   * thing the calendar actually knows. It is the event the day is built
   * around, and a list of small tasks buries it.
   */
  const biggest = state.calendar.today
    .filter((e) => !e.allDay)
    .map((e) => ({
      title: e.title,
      start: e.start,
      minutes: Math.max(0, Math.round((new Date(e.end).getTime() - new Date(e.start).getTime()) / 60_000)),
      location: e.location,
    }))
    .sort((a, b) => b.minutes - a.minutes)[0];

  return { overdue, upcoming, openCount: state.tasks.openCount, biggest };
}

/**
 * The three things the energy score is made of.
 *
 * "Energy 43 steady" is a number nobody can argue with, because none of its
 * working is visible. Sleep, meals and how booked the day is are the inputs,
 * and they are the part a person can check against how they actually feel.
 */
function bodyInputs(state: LifeState, now: Date) {
  const latest = state.health.latest;
  const today = state.health.latest?.date === toDateKey(now) ? state.health.latest : undefined;

  // A working day, not a calendar day: 16 waking hours is what there is to
  // spend, and measuring against 24 would make every day look empty.
  const wakingMinutes = 16 * 60;
  const bookedMinutes = state.calendar.today
    .filter((e) => !e.allDay)
    .reduce(
      (acc, e) =>
        acc +
        Math.max(0, Math.round((new Date(e.end).getTime() - new Date(e.start).getTime()) / 60_000)),
      0,
    );

  return {
    sleepHours: latest?.sleepHours,
    meals: { logged: today?.meals ?? 0, of: 3 },
    mood: latest?.mood,
    fitness: {
      activeMinutes: latest?.activeMinutes,
      steps: latest?.steps,
    },
    schedule: {
      bookedMinutes,
      freeMinutes: state.calendar.freeMinutes,
      busyPercent: Math.min(100, Math.round((bookedMinutes / wakingMinutes) * 100)),
    },
  };
}

/**
 * The user's own energy reading, and the forecast's opinion of it.
 *
 * These are two different things and the card shows both, because they can
 * disagree and the disagreement is the interesting part: "you say 2, the
 * numbers say steady" is worth knowing. The reading is what the user reported
 * — the only energy figure in the app that is not inferred.
 */
function energySection(state: LifeState, now: Date) {
  const latest = state.health.latest;
  const reading =
    typeof latest?.energy === "number"
      ? { level: latest.energy, at: latest.energyAt ?? latest.date }
      : undefined;

  // Asked for twice a day, so a reading is stale once the day has moved on
  // from the half of it that the reading belongs to.
  const stale = !reading || hoursBetween(new Date(reading.at), now) >= 8;

  return {
    kind: "energy" as const,
    reading,
    forecast: { score: state.energy.score, band: state.energy.band, note: state.energy.note },
    stale,
    body: bodyInputs(state, now),
  };
}

function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 3_600_000;
}

/**
 * The briefing, as sections rather than sentences.
 *
 * Every section is either populated from the life state or omitted. There is
 * no sentence anywhere in here that says nothing: the previous version pushed
 * "Nothing scheduled." and "Task list is clear." as literal strings, which
 * meant a card that looked identical whether it knew something or not.
 *
 * `analysis` is the model's reading of the measured facts, passed in by the
 * mind layer because this function is synchronous and that call is not. It is
 * optional in the strongest sense: without it the detector's own finding is
 * reported instead, with its evidence and a label naming the source.
 */
export function localBriefingSections(
  state: LifeState,
  now: Date = new Date(),
  analysis?: Analysis,
): BriefingSection[] {
  const sections: BriefingSection[] = [energySection(state, now)];

  const next = nextEvent(state, now);
  if (next) {
    const following = state.calendar.today
      .filter((e) => !e.allDay && e.start > next.start)
      .sort((a, b) => a.start.localeCompare(b.start))[0];
    const free = minutesBetween(now, new Date(next.start));
    sections.push({
      kind: "next",
      event: {
        id: next.id,
        title: next.title,
        start: next.start,
        end: next.end,
        location: next.location,
        running: false,
        minutesUntil: free,
        freeBefore: free > 90 ? free : undefined,
      },
      then: following ? { title: following.title, start: following.start } : undefined,
    });
  }

  const live = runningEvent(state, now);
  const window = nextFocusWindow(state, now);

  /**
   * What the focus log actually says.
   *
   * The section used to show the top task and call it "working", which is a
   * claim about what someone is doing based on what they wrote down. The focus
   * log is the real answer, and it was already in the life state — sessions
   * carry a label, a duration and the media that was playing.
   *
   * An unfinished session is the better answer when there is one: a session
   * that was started and never completed is the closest thing the log has to
   * "this is what you are on". Falling back to a completed one is honest only
   * because the card labels it as the last thing rather than as current work,
   * which the live payload made obvious — it read "writing the launch post"
   * for a session that had already been closed.
   */
  const sessions = state.focus.sessionsThisWeek;
  const latest = sessions.find((s) => !s.completed) ?? sessions[0];
  const session = latest
    ? {
        label: latest.label,
        minutes: latest.minutes,
        media: latest.media,
        completed: latest.completed,
      }
    : undefined;
  const weekMinutes = state.focus.totalMinutes > 0 ? state.focus.totalMinutes : undefined;

  // Only when there is nothing live and nothing underway. A queued task shown
  // beside a running session would be competing with the thing in progress.
  const queued = live || session ? undefined : state.tasks.focus[0];

  if (live || window || session || queued) {
    sections.push({
      kind: "focus",
      live: live
        ? {
            title: live.title,
            endsAt: live.end,
            minutesLeft: Math.max(0, minutesBetween(now, new Date(live.end))),
            location: live.location,
          }
        : undefined,
      window: window
        ? {
            startHour: window.startHour,
            endHour: window.endHour,
            label: window.label,
            band: window.band,
          }
        : undefined,
      session,
      weekMinutes,
      queued: queued ? { id: queued.id, title: queued.title, project: queued.project } : undefined,
    });
  }

  const open = openWork(state, now);
  if (open.overdue.length > 0 || open.upcoming.length > 0 || open.openCount > 0) {
    sections.push({ kind: "open", ...open });
  }

  /**
   * Pattern and recall come from the reading the model made of the measured
   * facts, when there is one. With no model configured the detector's own
   * finding is still shown — with its evidence and a label saying where it
   * came from — because a measured fact is worth reporting even unanalysed.
   * What never happens is prose written to fill the space.
   */
  const reading = analysis;
  const detector = state.patterns[0];

  if (reading?.pattern) {
    sections.push({
      kind: "pattern",
      analysis: reading.pattern.analysis,
      evidence: reading.pattern.evidence,
      confidence: reading.pattern.confidence,
      basis: reading.pattern.basis,
      suggestion: reading.pattern.suggestion,
      detectedBy: "model",
    });
  } else if (detector) {
    /**
     * The detector's own sentence, not only its numbers.
     *
     * This was missing, and the demo caught it: without a model the section
     * rendered the evidence list — "current 7; longest 7; 3/7 this week" —
     * with no statement of what those numbers were about. `observation` is
     * always a real sentence derived from the same data, so withholding it
     * took away the only part that made the evidence legible. It is not
     * templated prose: the numbers in it come from the measurement, and the
     * label underneath says the detector wrote it rather than the model.
     */
    sections.push({
      kind: "pattern",
      analysis: detector.observation,
      evidence: detector.evidence,
      confidence: detector.confidence,
      basis: detector.basis,
      suggestion: detector.suggestion,
      detectedBy: "detector",
    });
  }

  if (reading?.recall?.length) {
    sections.push({ kind: "recall", items: reading.recall, detectedBy: "model" });
  }

  return sections;
}

/** The briefing as a card. */
export function briefingCard(state: LifeState, now: Date = new Date()): Card {
  return {
    kind: "briefing",
    title: greetingFor(state.partOfDay),
    sections: localBriefingSections(state, now),
    generatedAt: nowIso(),
  };
}

export function greetingFor(partOfDay: LifeState["partOfDay"]): string {
  switch (partOfDay) {
    case "morning": return "Morning";
    case "afternoon": return "Afternoon";
    case "evening": return "Evening";
    default: return "Late";
  }
}

/** Wrap an engine's output into a protocol `Message`. */
export function toMessage(
  output: LocalMindOutput,
  engine: string,
  startedAt: number,
): Message {
  return {
    id: uid("msg"),
    role: "xana",
    text: output.text,
    createdAt: nowIso(),
    cards: output.cards,
    outcome: output.outcome,
    engine,
    latencyMs: Date.now() - startedAt,
    recalled: output.recalled,
  };
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Words that carry no meaning when someone is naming a thing to remove.
 *
 * "Delete the dentist thing" is how people talk, and every one of these words
 * would otherwise count against the match: the phrase has two content tokens,
 * only one of which appears in the title, so a scorer that treats them equally
 * reports half a match and refuses. These are the words that make a spoken
 * phrase fuzzy without making it ambiguous.
 */
const FILLER = new Set(["thing", "things", "stuff", "item", "items", "entry", "entries", "one", "ones", "please"]);

/** Best fuzzy match of a phrase against a list of titles. */
function bestMatch(
  phrase: string,
  pool: ReadonlyArray<{ id: string; title: string }>,
): { id: string; title: string } | undefined {
  const needle = phrase.toLowerCase().trim();
  if (needle.length < 2) return undefined;

  const exact = pool.find((item) => item.title.toLowerCase() === needle);
  if (exact) return exact;
  const contains = pool.find(
    (item) => item.title.toLowerCase().includes(needle) || needle.includes(item.title.toLowerCase()),
  );
  if (contains) return contains;

  // Token overlap, for "the dentist thing" matching "Book the dentist follow-up".
  const words = needle.split(/\W+/).filter((w) => w.length > 3 && !FILLER.has(w));
  if (words.length === 0) return undefined;
  let best: { item: { id: string; title: string }; score: number } | undefined;
  for (const item of pool) {
    const title = item.title.toLowerCase();
    const score = words.filter((w) => title.includes(w)).length / words.length;
    // Half the content words is a match, not a maybe. Removal is the one verb
    // with an undo, the reply names what it took, and a phrase with the filler
    // stripped is usually down to the one word that identifies it.
    if (score >= 0.5 && (!best || score > best.score)) best = { item, score };
  }
  return best?.item;
}

/** Best fuzzy match of a phrase against the open task list. */
function bestTaskMatch(phrase: string, state: LifeState): { id: string; title: string } | undefined {
  return bestMatch(phrase, [...state.tasks.focus, ...state.tasks.overdue]);
}

/** Default reminder slot: today at 18:00, or tomorrow if it is already past. */
function defaultReminderTime(now: Date = new Date()): Date {
  const d = new Date(now);
  d.setHours(18, 0, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d;
}

function withHour(date: Date, hour: number): Date {
  const d = new Date(date);
  d.setHours(hour, 0, 0, 0);
  return d;
}
