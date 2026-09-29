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

import type { ActionIntent, Card, LifeState, Message } from "../core/types";
import { executeAction } from "../actions/executor";
import { parseDuration, parseWhen, stripWhen } from "../core/nlp";
import { addDays, formatDay, formatTime, humanDuration, nowIso, uid } from "../core/time";

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
 * "remind me to X", "reminder: X", "don't let me forget X"
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
  return { text: "", cards: [briefingCard(lifeState)] };
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
  return { text: "", cards: [briefingCard(lifeState)] };
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
const HANDLERS: Handler[] = [
  handleReminder,
  handleNote,
  handleRemember,
  handleComplete,
  handleProtect,
  handleFocus,
  handleGoal,
  handleHabit,
  handleReflect,
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

/** A sentence to introduce a card, so a card is never dropped in silently. */
function leadInFor(cards: Card[] | undefined): string {
  switch (cards?.[0]?.kind) {
    case "briefing": return "Here's the shape of it.";
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

/** The daily briefing, assembled from the life state. */
export function briefingCard(state: LifeState): Card {
  const lines: string[] = [];

  const ev = state.calendar.today.filter((e) => !e.allDay);
  if (ev.length === 0) {
    lines.push("Nothing scheduled.");
  } else {
    const first = ev[0];
    lines.push(
      ev.length === 1
        ? `One thing today: ${first.title} at ${formatTime(first.start)}.`
        : `${ev.length} scheduled. First is ${first.title} at ${formatTime(first.start)}.`,
    );
    if (state.calendar.freeMinutes > 90) {
      lines.push(`${humanDuration(state.calendar.freeMinutes)} of it is unscheduled.`);
    }
  }

  if (state.tasks.overdue.length > 0) {
    lines.push(
      state.tasks.overdue.length === 1
        ? `"${state.tasks.overdue[0].title}" is overdue.`
        : `${state.tasks.overdue.length} things are overdue.`,
    );
  }

  if (state.tasks.focus.length > 0) {
    const top = state.tasks.focus.slice(0, 3).map((t) => t.title);
    lines.push(`Focus: ${top.join(" · ")}.`);
  } else {
    lines.push("Task list is clear.");
  }

  const atRisk = state.habits.filter((h) => h.atRisk);
  if (atRisk.length > 0) {
    lines.push(`${atRisk.map((h) => h.name).join(", ")} ${atRisk.length === 1 ? "is" : "are"} at risk today.`);
  }

  if (state.weather && !state.weather.synthetic) {
    lines.push(`${state.weather.temperatureC}° and ${state.weather.condition} in ${state.weather.location}.`);
  }

  lines.push(state.energy.note);

  return {
    kind: "briefing",
    title: greetingFor(state.partOfDay),
    lines,
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

/** Best fuzzy match of a phrase against the open task list. */
function bestTaskMatch(phrase: string, state: LifeState): { id: string; title: string } | undefined {
  const needle = phrase.toLowerCase();
  const pool = [...state.tasks.focus, ...state.tasks.overdue];
  const exact = pool.find((t) => t.title.toLowerCase() === needle);
  if (exact) return exact;
  const contains = pool.find((t) => t.title.toLowerCase().includes(needle) || needle.includes(t.title.toLowerCase()));
  if (contains) return contains;

  // Token overlap, for "the deck thing" matching "Review Aurora deck".
  const words = needle.split(/\W+/).filter((w) => w.length > 3);
  if (words.length === 0) return undefined;
  let best: { task: { id: string; title: string }; score: number } | undefined;
  for (const task of pool) {
    const title = task.title.toLowerCase();
    const score = words.filter((w) => title.includes(w)).length / words.length;
    if (score > 0.5 && (!best || score > best.score)) best = { task, score };
  }
  return best?.task;
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
