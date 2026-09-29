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
      /** What the user is actually working on, from their own task list. */
      working?: { id: string; title: string; project?: string };
    }
  | {
      kind: "open";
      overdue: Array<{ id: string; title: string; daysLate: number }>;
      /** Not late, but soon — the next few things with a date on them. */
      upcoming: Array<{ id: string; title: string; due: string; daysAway: number }>;
      openCount: number;
    }
  | {
      kind: "pattern";
      /** Written by the model from the pattern and the memories behind it. */
      analysis?: string;
      /** The measured facts it was given, so the claim is checkable. */
      evidence: string[];
      /** How sure the detector is, computed from its own sample size. */
      confidence?: number;
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
  /** "ahead" | "on-track" | "slipping" | "stalled" */
  pace: "ahead" | "on-track" | "slipping" | "stalled";
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
  /** 0..1 */
  confidence: number;
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
  /** "connected" | "local" | "offline" | "error" */
  state: "connected" | "local" | "offline" | "error";
  /** Where the data came from: "live" | "local" | "synthetic". */
  mode: "live" | "local" | "synthetic";
  detail?: string;
  durationMs?: number;
}

/* ------------------------------------------------------------------ */
/* Actions (write-back)                                                */
/* ------------------------------------------------------------------ */

export type ActionIntent =
  | { type: "create_task"; title: string; due?: string; project?: string; people?: string[]; priority?: 1 | 2 | 3 | 4; estimateMinutes?: number }
  | { type: "complete_task"; taskId: string }
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
  | { type: "remember"; kind: MemoryKind; title: string; content: string; entities?: string[]; tags?: string[] }
  | { type: "start_focus"; label: string; minutes: number }
  | { type: "protect_block"; title: string; start: string; end: string; reason?: string }
  | { type: "reflect"; period: "weekly" | "monthly" }
  | { type: "brief_me" }
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
