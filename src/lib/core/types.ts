/**
 * Xana — core domain contracts.
 *
 * Everything in the system agrees on these shapes:
 *   adapters -> LifeState -> /xana/context -> mind -> UI cards
 *
 * Keep this file dependency-free. It is the shared vocabulary.
 */

export const XANA_NAME = "Xana" as const;

/* ------------------------------------------------------------------ */
/* Time & energy                                                       */
/* ------------------------------------------------------------------ */

/** Coarse energy band used for "energy forecast of the day". */
export type EnergyBand = "low" | "steady" | "sharp" | "peak";

export interface EnergyWindow {
  /** Local hour the window starts, 0-23. */
  startHour: number;
  endHour: number;
  band: EnergyBand;
  /** 0..1 confidence that this window is accurate. */
  confidence: number;
  label: string;
  evidence: string[];
}

export interface EnergyForecast {
  /** 0..100 overall capacity for the day. */
  score: number;
  band: EnergyBand;
  windows: EnergyWindow[];
  note: string;
}

/* ------------------------------------------------------------------ */
/* Life data primitives                                                */
/* ------------------------------------------------------------------ */

export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO 8601. */
  start: string;
  end: string;
  location?: string;
  attendees?: string[];
  /** Which adapter produced this: "google", "outlook", "local". */
  source: string;
  /** True when Xana created it. */
  xanaAuthored?: boolean;
  allDay?: boolean;
}

export type TaskStatus = "open" | "doing" | "done" | "dropped";
export type TaskEnergy = "low" | "medium" | "high";

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  /** ISO 8601 due date, if any. */
  due?: string;
  /** Project or area, e.g. "Xana", "Health". */
  project?: string;
  /** People involved — feeds the relationship graph in memory. */
  people?: string[];
  /** Priority 1 (highest) .. 4 (lowest). */
  priority: 1 | 2 | 3 | 4;
  /** Estimated minutes of focused attention required. */
  estimateMinutes?: number;
  energy?: TaskEnergy;
  /** Free-form tags, e.g. ["deep-work"]. */
  tags?: string[];
  source: string;
  createdAt: string;
  completedAt?: string;
}

export interface Habit {
  id: string;
  name: string;
  /** Target cadence, e.g. 5 per week. */
  targetPerWeek: number;
  /** ISO dates (YYYY-MM-DD) on which the habit was completed. */
  completions: string[];
  streak: number;
  longestStreak: number;
  unit?: string;
  cadenceHint?: string;
}

export interface HabitWithHealth extends Habit {
  /** completions within the current ISO week. */
  thisWeek: number;
  /** True when the habit is still on pace for its weekly target. */
  onPace: boolean;
  /** Whether the streak is in danger today. */
  atRisk: boolean;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  /** "notion" | "obsidian" | "apple-notes" | "journal" | "local" */
  source: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export type MoodLabel = "low" | "flat" | "good" | "bright";

/** The three meals the briefing counts, plus the one it deliberately does not. */
export type MealName = "breakfast" | "lunch" | "dinner" | "snack";

/**
 * One reading inside a day, nameable from outside the store.
 *
 * Clearing is a verb of its own — `upsertHealth` reads a missing field as "leave
 * this alone", which is right for a phone sending one number and useless for a
 * person who tapped the wrong one — so the set of things that *can* be cleared
 * has to be a closed list rather than a string a caller makes up.
 */
export type HealthField =
  | "sleepHours"
  | "sleepQuality"
  | "steps"
  | "activeMinutes"
  | "restingHeartRate"
  | "mood"
  | "energy"
  | "meals"
  | "mealsLogged";

export interface HealthSample {
  date: string;
  sleepHours?: number;
  sleepQuality?: number;
  steps?: number;
  activeMinutes?: number;
  restingHeartRate?: number;
  mood?: MoodLabel;
  /** What the user says their energy is, 1-5. Their own reading, not ours. */
  energy?: number;
  /** When they said it. A day can hold two readings, so the time matters. */
  energyAt?: string;
  /** Meals logged today, 0-3. Counted, because the briefing asks about them. */
  meals?: number;
  /**
   * Which meals, by name.
   *
   * `meals` was the whole record until the Log room existed: a count, on purpose,
   * because the only question the briefing asks is whether they have eaten. The
   * day a person can also tap "lunch" in a room, a count is no longer enough —
   * "2 of 3" cannot tell you whether breakfast is the one still missing. The
   * count stays the number the briefing and the patterns read; this is the detail
   * behind it, and an empty array is a deliberate "nothing logged", which is not
   * the same as `undefined`, meaning "this door did not touch meals".
   */
  mealsLogged?: MealName[];
  source: string;
}

/**
 * One section of the briefing.
 *
 * The briefing used to be `lines: string[]` — five sentences in a fixed order,
 * every one of them written by a template. A section instead names what it is
 * *about*, so the renderer knows what it is showing and the assembler cannot
 * quietly fall back to prose that has nothing to do with the data.
 *
 * Every section is either present with real content or explicitly empty. There
 * is no "no data" sentence: an empty section is `null`, and the renderer omits
 * it rather than printing a line about the absence of a line.
 */
export type BriefingSection =
  | {
      kind: "energy";
      /** 1-5, as the user reported it. Undefined until they do. */
      reading?: { level: number; at: string };
      /** The forecast's own view, which is computed and is not the same thing. */
      forecast: { score: number; band: EnergyBand; note: string };
      /** True when the reading is stale enough to ask again. */
      stale: boolean;
      /**
       * The body's other inputs, which is what "energy" actually rests on.
       *
       * A single score with no visible working is a number someone has to
       * either trust or ignore. These are the three things it is made of, and
       * each is a fact the user can check against how they feel.
       */
      body: {
        /** Last night, when the health data has it. */
        sleepHours?: number;
        /** Meals logged today, against the three a day is measured in. */
        meals: { logged: number; of: number };
        /** Latest mood report, when available. */
        mood?: MoodLabel;
        /** Movement used by the energy forecast. */
        fitness: { activeMinutes?: number; steps?: number };
        /** How much of the waking day the calendar has taken. */
        schedule: { bookedMinutes: number; freeMinutes: number; busyPercent: number };
      };
    }
  | {
      kind: "next";
      event: {
        id: string;
        title: string;
        start: string;
        end: string;
        location?: string;
        /** True when it has already started and is still running. */
        running: boolean;
        minutesUntil: number;
        /** Free minutes between now and it, when there are any. */
        freeBefore?: number;
      };
      /** What follows it, so "next" is not a dead end. */
      then?: { title: string; start: string };
    }
  | {
      kind: "focus";
      /** The event happening right now, if one is. */
      live?: { title: string; endsAt: string; minutesLeft: number; location?: string };
      /** The best window today to do demanding work, from the forecast. */
      window?: { startHour: number; endHour: number; label: string; band: EnergyBand };
      /**
       * The most recent focus session — what was actually being worked on,
       * with how long was given to it.
       *
       * Distinct from `queued`: this is time already committed, and it comes
       * from the focus log rather than from the task list. A briefing that
       * showed only the task list was describing what someone intended rather
       * than what they had done.
       */
      session?: { label: string; minutes: number; media?: string; completed: boolean };
      /** Focused time this week, across every session. */
      weekMinutes?: number;
      /** The next thing in the list, when nothing is live or underway. */
      queued?: { id: string; title: string; project?: string };
    }
  | {
      kind: "open";
      overdue: Array<{ id: string; title: string; daysLate: number }>;
      /** Not late, but soon — the next few things with a date on them. */
      upcoming: Array<{ id: string; title: string; due: string; daysAway: number }>;
      openCount: number;
      /**
       * The day's biggest single block.
       *
       * The largest event is usually the one the day is actually about — a
       * class, an exam, a review — and it is the thing a list of small tasks
       * buries. Named separately so it cannot be lost among them.
       */
      biggest?: { title: string; start: string; minutes: number; location?: string };
    }
  | {
      kind: "pattern";
      /** Written by the model from the pattern and the memories behind it. */
      analysis?: string;
      /** The measured facts it was given, so the claim is checkable. */
      evidence: string[];
      /** How sure the detector is, computed from its own sample size. */
      confidence?: number;
      /** What that figure estimates, in a few words. */
      basis?: string;
      suggestion?: string;
      detectedBy: "model" | "detector";
    }
  | {
      kind: "recall";
      /** Something the user knows but may not have thought of right now. */
      items: Array<{
        id: string;
        title: string;
        content: string;
        /** Why it surfaced — the reason, not a score. */
        because: string;
      }>;
      detectedBy: "model" | "detector";
    };

export interface WeatherSnapshot {
  location: string;
  /** Celsius. */
  temperatureC: number;
  feelsLikeC: number;
  condition: string;
  /** 0..1 */
  precipitationChance: number;
  highC: number;
  lowC: number;
  sunrise: string;
  sunset: string;
  source: string;
  /** True when this is a synthesised fallback rather than live data. */
  synthetic?: boolean;
}

export interface FocusSession {
  id: string;
  label: string;
  startedAt: string;
  minutes: number;
  /** Media context during the session, if any. */
  media?: string;
  completed: boolean;
}

export interface MediaContext {
  nowPlaying?: string;
  artist?: string;
  /** Suggested focus playlist for the current energy band. */
  focusSuggestion?: string;
  source: string;
}

export interface FinanceSignal {
  label: string;
  value: string;
  /** "up" | "down" | "flat" */
  trend: "up" | "down" | "flat";
  note?: string;
}

export interface MailSignal {
  id: string;
  from: string;
  subject: string;
  /** 0..1 how much Xana thinks this matters. */
  importance: number;
  receivedAt: string;
  needsReply: boolean;
}

/* ------------------------------------------------------------------ */
/* Goals                                                               */
/* ------------------------------------------------------------------ */

export type GoalHorizon = "short" | "mid" | "long";
export type GoalStatus = "active" | "paused" | "achieved" | "dropped";

export interface Milestone {
  id: string;
  goalId: string;
  title: string;
  done: boolean;
  due?: string;
  completedAt?: string;
}

export interface Goal {
  id: string;
  title: string;
  why?: string;
  horizon: GoalHorizon;
  status: GoalStatus;
  /** ISO date the goal was created. */
  createdAt: string;
  targetDate?: string;
  /** Manual progress override 0..1; derived from milestones when absent. */
  progressOverride?: number;
  area?: string;
  cadence?: string;
  /**
   * When something last moved, as an explicit column.
   *
   * Progress pace needs to know how long a goal has been quiet, and it
   * previously inferred that from the newest completed milestone — falling
   * back to the creation date. That has a bad failure mode: a goal with no
   * milestones has nothing to complete, so its "last movement" is always its
   * creation date, and it drifts to `stalled` no matter how much work the
   * user actually did. The interface then blames them for not ticking boxes
   * that do not exist.
   *
   * An explicit column lets the user assert "this moved" without inventing a
   * milestone to prove it.
   */
  lastTouchedAt?: string;
  /**
   * Position within its column in My cave. Lower sorts first.
   *
   * A float rather than an integer, and that is deliberate: dropping a card
   * between two others sets its order to the midpoint of its new
   * neighbours, which is a single-row write. An integer scheme would
   * renumber every card below the drop, so a drag would be an O(n) write
   * and two drags at once would collide.
   *
   * Absent on goals created before the column existed; those sort last, by
   * creation date.
   */
  sortOrder?: number;
  milestones: Milestone[];
}

export interface GoalProgress {
  goalId: string;
  /** 0..1 */
  progress: number;
  milestonesDone: number;
  milestonesTotal: number;
  /** "ahead" | "on-track" | "slipping" | "stalled" | "not-started" */
  pace: "ahead" | "on-track" | "slipping" | "stalled" | "not-started";
  /** Days until targetDate; negative when overdue. */
  daysRemaining?: number;
  /** Human sentence explaining pace. */
  note: string;
}

export interface Reflection {
  id: string;
  /** "weekly" | "monthly" | "on-demand" */
  period: string;
  periodStart: string;
  periodEnd: string;
  body: string;
  highlights: string[];
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Memory (the external brain)                                         */
/* ------------------------------------------------------------------ */

export type MemoryKind =
  | "conversation"
  | "decision"
  | "preference"
  | "person"
  | "place"
  | "project"
  | "event"
  | "note"
  | "task"
  | "reflection"
  | "fact";

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  /** Short title or gist. */
  title: string;
  content: string;
  /** Named entities extracted on write. */
  entities: string[];
  tags: string[];
  /** 0..1 significance; drives what Xana surfaces unprompted. */
  salience: number;
  source: string;
  /** Session this was learned in. */
  sessionId?: string;
  createdAt: string;
  /** ISO date of last successful recall, for spaced-repetition style decay. */
  lastAccessedAt?: string;
  accessCount: number;
  /** Set when superseded by newer contradicting memory. */
  supersededBy?: string;
  /**
   * Pinned memories are exempt from decay and always considered for recall.
   *
   * The use case is a fact that must not be forgotten or diluted: a
   * daughter's birthday, an allergy, the name of a project that is going on
   * for years. Recall is a ranking, so without an explicit pin there is no
   * way for a user to say "this one matters more than the rest" — the blend
   * decides, and it decides from features like recency that a two-year-old
   * fact will always lose.
   */
  pinned?: boolean;
}

export interface MemoryHit {
  memory: MemoryRecord;
  /** 0..1 blended vector + lexical + recency score. */
  score: number;
  /** Why this surfaced, for the UI's "recall" cards. */
  reason: string;
}

/* ------------------------------------------------------------------ */
/* Aggregated life state                                               */
/* ------------------------------------------------------------------ */

export interface LifeState {
  /** ISO timestamp this snapshot was assembled. */
  generatedAt: string;
  /** Local greeting context, e.g. "morning". */
  partOfDay: "night" | "morning" | "afternoon" | "evening";
  /** One-line human summary of the moment. */
  headline: string;
  calendar: {
    today: CalendarEvent[];
    next?: CalendarEvent;
    /** Free minutes remaining in the waking day. */
    freeMinutes: number;
  };
  tasks: {
    /** Ordered by Xana's own triage, most important first. */
    focus: Task[];
    overdue: Task[];
    openCount: number;
    completedThisWeek: number;
  };
  habits: HabitWithHealth[];
  goals: Array<{ goal: Goal; progress: GoalProgress }>;
  health: {
    latest?: HealthSample;
    /** 7-day trailing averages. */
    sleepAvgHours?: number;
    moodTrend: MoodLabel[];
    sleepDebtHours: number;
  };
  weather?: WeatherSnapshot;
  media?: MediaContext;
  finance: FinanceSignal[];
  mail: MailSignal[];
  /** Detected behavioural patterns, e.g. Tuesday deep work. */
  patterns: Pattern[];
  energy: EnergyForecast;
  /** Proactive nudges Xana wants to raise before being asked. */
  nudges: Nudge[];
  /** Which adapters responded, and how. */
  sources: AdapterStatus[];
  /** Recalled memories relevant to now. */
  memory: MemoryHit[];
  focus: {
    sessionsThisWeek: FocusSession[];
    totalMinutes: number;
    lastSession?: FocusSession;
  };
}

/**
 * What the model made of the user's patterns and memories.
 *
 * Deliberately not a field on `LifeState`. The life state is assembled from
 * what the app can observe, and it is rebuilt constantly; this is produced by
 * a network call and is only wanted when a briefing is being drawn. Passing it
 * to the briefing assembler as an argument keeps the model out of the state
 * every other caller reads.
 *
 * Separate from `Pattern`, which is the deterministic detector's output. The
 * detector measures and states a fact; this is a reading of several facts
 * together, which is the part a template cannot do. Absent when no model is
 * configured, and the briefing then shows the detector's own evidence rather
 * than prose invented to fill the gap.
 */
export interface Analysis {
  pattern?: {
    analysis: string;
    evidence: string[];
    confidence?: number;
    /** What that figure estimates, carried through from the detector. */
    basis?: string;
    suggestion?: string;
  };
  recall?: Array<{ id: string; title: string; content: string; because: string }>;
  /** Which patterns and memories it was shown, for auditability. */
  considered: { patterns: number; memories: number };
  at: string;
}

export interface Pattern {
  id: string;
  /** Stable machine name, e.g. "deep-work-tuesday". */
  key: string;
  /** One-line observation in Xana's voice. */
  observation: string;
  /**
   * 0..1. How well the underlying rate holds up, not a vibe.
   *
   * This used to be a mixture of computed fractions and outright literals —
   * `confidence: 0.85` sitting next to `confidence: round(0.4 + share)` — and
   * the card rendered both as "confidence 85%". A number that reads as a
   * measurement while being a constant is worse than no number, so this field
   * is now always derived and never asserted.
   */
  confidence: number;
  /**
   * What that number is confident *about*, in a few words.
   *
   * The percentage was the wall: "confidence 85%" invites the question it
   * cannot answer. This says which rate is being estimated and over what, so
   * the figure can be argued with instead of merely displayed.
   */
  basis: string;
  /** Concrete supporting numbers. */
  evidence: string[];
  /** Suggested action, phrased as a question when appropriate. */
  suggestion?: string;
  /** Optional proposed action the UI can offer as a one-tap button. */
  action?: ActionIntent;
  detectedAt: string;
}

export interface Nudge {
  id: string;
  /** "info" | "suggest" | "warn" | "celebrate" */
  tone: "info" | "suggest" | "warn" | "celebrate";
  text: string;
  /** Higher first. */
  priority: number;
  action?: ActionIntent;
}

export interface AdapterStatus {
  id: string;
  label: string;
  /**
   * "connected" | "local" | "offline" | "error" | "blocked".
   *
   * `blocked` is a plugin whose capabilities the user has not granted. It is
   * separate from `offline` because it is not a fault: nothing is broken and
   * nothing needs fixing, there is a button to press. The header dots read the
   * same vocabulary, so a blocked source shows as waiting rather than as down.
   */
  state: "connected" | "local" | "offline" | "error" | "blocked";
  /** Where the data came from: "live" | "local" | "synthetic". */
  mode: "live" | "local" | "synthetic";
  /**
   * True when the values behind this status are invented rather than read.
   *
   * The distinction `mode` cannot make on its own: an adapter that fails after
   * a successful read reports `synthetic` while still holding the last real
   * answer, and one that has never had a source reports `synthetic` while
   * holding placeholder numbers. The plugin layer shows those differently —
   * "cached" against "synthetic" — because "we could not refresh this" and
   * "we made this up" are not the same thing to tell a user.
   */
  synthetic?: boolean;
  detail?: string;
  durationMs?: number;
}

/* ------------------------------------------------------------------ */
/* The trash                                                           */
/* ------------------------------------------------------------------ */

/**
 * How long a deleted thing stays recoverable.
 *
 * Seven days because that is the window in which a person notices: a task
 * removed by mistake is usually missed the next time they look at the list, and
 * a week covers the weekend, the trip, and the "I will deal with it Monday".
 * Longer than that and the bin becomes a second, worse copy of the database
 * that nobody ever empties.
 *
 * Here rather than in the store because the interface says it out loud — "in
 * the trash for seven days" is a promise to the user, and a second copy of the
 * number in a component is a second copy that can be wrong.
 */
export const TRASH_DAYS = 7;

/** The things a user can delete, and therefore recover. */
export type TrashKind = "task" | "event" | "goal" | "milestone" | "note" | "memory";

export const TRASH_KINDS: readonly TrashKind[] = ["task", "event", "goal", "milestone", "note", "memory"];

/** A label for each kind, for a list a person reads. */
export const TRASH_LABELS: Record<TrashKind, string> = {
  task: "Task",
  event: "Event",
  goal: "Goal",
  milestone: "Milestone",
  note: "Note",
  memory: "Memory",
};

/** One line in the bin. */
export interface TrashItem {
  kind: TrashKind;
  /** The id the record had in its own table, so a restore can name it. */
  id: string;
  title: string;
  deletedAt: string;
  /** Whole days before it is removed for good. Never negative. */
  daysLeft: number;
  /**
   * For a goal: the steps that went into the bin with it.
   *
   * They are not listed as rows of their own — restoring the goal brings them
   * back and deleting it for good takes them with it — so the row carries the
   * count rather than the bin quietly holding more than it says.
   */
  steps?: number;
}

/* ------------------------------------------------------------------ */
/* Actions (write-back)                                                */
/* ------------------------------------------------------------------ */

export type ActionIntent =
  | { type: "create_task"; title: string; due?: string; project?: string; people?: string[]; priority?: 1 | 2 | 3 | 4; estimateMinutes?: number }
  | { type: "complete_task"; taskId: string }
  /**
   * Change something about a task that already exists.
   *
   * The missing verb, and its absence is what produced a lie: the chat was asked
   * to retitle a garbled task, there was no path that could, and the model said
   * "Done." rather than admitting it. Only the fields present are touched, so
   * "rename it" cannot silently clear a due date.
   */
  | {
      type: "update_task";
      taskId: string;
      title?: string;
      due?: string | null;
      project?: string | null;
      priority?: 1 | 2 | 3 | 4;
      estimateMinutes?: number | null;
    }
  | { type: "create_event"; title: string; start: string; end: string; location?: string }
  | { type: "create_note"; title: string; body: string; tags?: string[] }
  | { type: "create_reminder"; text: string; remindAt: string; hasTime?: boolean }
  | { type: "create_goal"; title: string; horizon: GoalHorizon; targetDate?: string; why?: string }
  | { type: "complete_milestone"; milestoneId: string }
  | { type: "log_habit"; habitId: string; date?: string }
  /**
   * The user reporting their own energy, 1-5.
   *
   * The only energy figure in the app that is not inferred from sleep, load
   * or circadian rhythm — it is what they say it is.
   */
  | { type: "log_energy"; level: number; at?: string }
  /**
   * A meal eaten. Counted, not described — the briefing asks whether they have
   * eaten today, and "2 of 3" answers that without a food diary.
   */
  | { type: "log_meal"; meal?: MealName }
  /**
   * The rest of a day's health, said out loud.
   *
   * This is the intent that did not exist. Meals and energy had one each, and
   * sleep — the single input the energy forecast is built on — had no way in at
   * all except a phone posting to `/api/health/ingest` or an Apple Health export
   * sitting in a folder. So a person with neither could read "sleep unrecorded"
   * on the briefing forever, and every sentence they tried ("I slept 7 hours",
   * "record sleep 6.5") came back as "I didn't follow that."
   *
   * One intent rather than five, because they are one act — reporting part of a
   * day — and the executor's reply is built from whichever fields arrived. Every
   * field is optional and a body with none of them is refused rather than
   * silently writing an empty day, which would erase a real reading by being
   * misunderstood.
   */
  | {
      type: "log_health";
      sleepHours?: number;
      sleepQuality?: number;
      mood?: MoodLabel;
      steps?: number;
      activeMinutes?: number;
    }
  | { type: "remember"; kind: MemoryKind; title: string; content: string; entities?: string[]; tags?: string[] }
  | { type: "start_focus"; label: string; minutes: number }
  | { type: "protect_block"; title: string; start: string; end: string; reason?: string }
  | { type: "reflect"; period: "weekly" | "monthly" }
  | { type: "brief_me" }
  /**
   * Taking things back out.
   *
   * Removal is an action like any other because asking for it is how people
   * talk: "scrap the dentist thing", "clear the list", "that meeting is off".
   * Every one of these goes to the trash rather than out of the database — see
   * `trash` in `core/store.ts` — so a sentence misheard is a restore rather
   * than lost work, and the reply can say so.
   */
  | { type: "delete_task"; taskId: string }
  /**
   * The whole open list at once, for "remove everything" and "clear the list".
   *
   * `open` is the default and the useful one: a list that has become a reproach
   * is the thing people want gone. `all` exists so the same verb can mean the
   * whole table when someone genuinely means that, and nothing else reaches for
   * it.
   */
  | { type: "clear_tasks"; scope?: "open" | "all" }
  | { type: "delete_event"; eventId: string }
  | { type: "delete_goal"; goalId: string }
  | { type: "forget_memory"; memoryId: string }
  | { type: "none" };

export interface ActionOutcome {
  ok: boolean;
  /** Machine name of the effect, e.g. "task.created". */
  effect: string;
  /** Human sentence Xana says about it. */
  message: string;
  /** Ids created/affected, for UI linking. */
  ids?: string[];
  /** Card hints the UI should refresh. */
  refresh?: Array<"tasks" | "goals" | "habits" | "memory" | "calendar" | "context">;
  /**
   * This write should also be mirrored into a remote service, if the user has
   * allowed it.
   *
   * Present only on writes that have a remote counterpart — today, a calendar
   * event. The executor stays synchronous and does the local write; the route
   * layer awaits `mirrorToRemote` with this descriptor, which is where the
   * network call and the second permission check live. See
   * `actions/remote.ts` for why the split is here rather than inside the
   * executor.
   */
  remoteEligible?: RemoteEligible;
}

/** A local write that a plugin may be able to repeat somewhere else. */
export interface RemoteEligible {
  /** The plugin whose write capability governs this. */
  plugin: string;
  kind: "event";
  /** The local record, so the remote id can be tied back to it. */
  localId: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  /** Pre-formatted pieces, so the rewritten message matches the original. */
  when: string;
  at: string;
  clash: string;
}

/* ------------------------------------------------------------------ */
/* Conversation                                                        */
/* ------------------------------------------------------------------ */

export interface Message {
  id: string;
  role: "user" | "xana" | "system";
  text: string;
  createdAt: string;
  /** Cards Xana attaches to a reply (briefing, recall, pattern, ...). */
  cards?: Card[];
  /** Action she took while replying. */
  outcome?: ActionOutcome;
  /** Which mind produced this: "llm" or "local". */
  engine?: string;
  /**
   * Why the model did not answer, when one was configured and it failed.
   *
   * Present only on a fallback. It exists because the alternative is
   * indistinguishable from "no model configured": the reply simply says
   * `local`, the user believes their key was ignored, and the actual cause
   * (a rejected key, an unreachable host, a wrong base URL) is nowhere on
   * screen. A failure that cannot be seen cannot be fixed.
   */
  modelError?: string;
  /** Wall-clock ms spent thinking. */
  latencyMs?: number;
  /** Memories consulted while producing this reply. */
  recalled?: Array<{ id: string; title: string; score: number }>;
}

export type Card =
  | {
      kind: "briefing";
      title: string;
      /**
       * The briefing, as sections rather than sentences.
       *
       * `sections` is the briefing. `lines` survives only so an old cached
       * message still renders; nothing writes it any more.
       */
      sections: BriefingSection[];
      /** @deprecated superseded by `sections`. A fixed sentence per section. */
      lines?: string[];
      generatedAt: string;
    }
  | { kind: "recall"; title: string; hits: Array<{ id: string; title: string; content: string; score: number; kind: MemoryKind }> }
  | { kind: "pattern"; title: string; observation: string; evidence: string[]; confidence: number; suggestion?: string }
  | { kind: "goals"; title: string; items: Array<{ id: string; title: string; horizon: GoalHorizon; progress: number; pace: GoalProgress["pace"]; note: string }> }
  | { kind: "energy"; title: string; score: number; band: EnergyBand; note: string; windows: EnergyWindow[] }
  | { kind: "tasks"; title: string; items: Array<{ id: string; title: string; due?: string; project?: string; priority: number }> }
  | { kind: "reflection"; title: string; body: string; highlights: string[] }
  | { kind: "focus"; title: string; label: string; minutes: number; media?: string }
  | { kind: "capabilities"; title: string; groups: Array<{ label: string; items: string[] }> };

export interface ChatRequest {
  message: string;
  sessionId?: string;
  /** "voice" affects Xana's phrasing (shorter, spoken-friendly). */
  modality?: "text" | "voice";
}

export interface ChatResponse {
  message: Message;
  lifeState?: LifeState;
}
