"use client";

import type { ActionIntent, LifeState, Presence } from "@/lib/api/contract";

import { Bar } from "./Rings";
import GhostButton from "./GhostButton";

/**
 * The peripheral region below the orb (DESIGN.md §6).
 *
 * On a cold start with no conversation this *is* the briefing: energy, the
 * next appointment, what she would put in front of you, and anything she
 * wants to raise before being asked. Rows with nothing to say are dropped
 * rather than rendered empty, so a quiet day leaves the region blank and only
 * the orb remains. That emptiness is the point.
 *
 * After 20s without interaction the whole region fades to `opacity: 0.55`;
 * hover or any interaction brings it back. The caller owns that clock and the
 * hover state, so this component stays a pure render of LifeState.
 */

export interface AmbientCardsProps {
  state: LifeState;
  /** Wired to POST /api/action through the hook. */
  onAct: (intent: ActionIntent) => void;
  presence: Presence;
  engine: "llm" | "local" | null;
  /** True once 20s have passed with no interaction. */
  idle: boolean;
  onInteract: () => void;
  /** Opens settings from the engine line, so the answer is one tap away. */
  onOpenSettings: () => void;
  /**
   * Whether a model is configured, from settings rather than from the last
   * reply. `engine` answers "who answered just now"; this answers "who will
   * answer next", and they diverge exactly when a call fails.
   */
  modelActive: boolean;
  modelName: string;
}

/** A relative day label for an ISO timestamp. Null when unparseable. */
function relativeDay(iso: string): string | null {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const days = Math.round(
    (new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime() -
      startOfToday) /
      86_400_000,
  );

  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) return `in ${days}d`;
  return when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "14:30" in the user's locale, or null when the timestamp is unusable. */
function clockTime(iso: string): string | null {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Minutes from `now` until an instant, floored at zero. */
function minutesLeft(iso: string, now: Date): number {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return 0;
  return Math.max(0, Math.round((when.getTime() - now.getTime()) / 60_000));
}

/** "1h 20m" / "45m" — the shape a duration wants in a narrow row. */
function span(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Tones map onto the palette's existing colours — warn is amber, not red. */
const NUDGE_TONE: Record<string, string> = {
  info: "text-dim",
  suggest: "text-dim",
  warn: "text-warn",
  celebrate: "text-good",
};

function Row({
  label,
  children,
  action,
}: {
  label: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-4 py-2.5">
      <span className="label w-[68px] shrink-0">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export default function AmbientCards({
  state,
  onAct,
  presence,
  engine,
  idle,
  onInteract,
  onOpenSettings,
  modelActive,
  modelName,
}: AmbientCardsProps) {
  const next = state.calendar.next;
  const nudges = state.nudges.slice(0, 2);
  const pattern = state.patterns[0];
  const memory = state.memory[0];
  const now = new Date();

  /**
   * Focus means what the focus log says, not the top of the task list.
   *
   * This row used to be the first three open tasks with their estimates and
   * projects — a perfectly good *Open* list, wearing a heading that claims to
   * answer "what am I on right now". Those are different questions: the task
   * list is what you intend, the focus log is what you have given time to, and
   * a panel that answers the second with the first is the panel that made this
   * whole rebuilding effort necessary.
   *
   * An unfinished session is preferred, because a started-and-not-closed
   * session is the closest thing the log has to "this is what you are on".
   */
  const sessions = state.focus.sessionsThisWeek;
  const session = sessions.find((s) => !s.completed) ?? sessions[0];

  /** The next few open tasks by the store's own order — priority, then date. */
  const queued = state.tasks.focus.slice(0, 3);

  /* --- Energy's working, so the score is not a number you must trust. --- */
  const todayHealth = state.health.latest;
  const reported =
    typeof todayHealth?.energy === "number"
      ? { level: todayHealth.energy, at: todayHealth.energyAt ?? todayHealth.date }
      : undefined;
  const sleepHours = state.health.latest?.sleepHours;
  const meals = { logged: todayHealth?.meals ?? 0, of: 3 };

  const wakingMinutes = 16 * 60;
  const bookedMinutes = state.calendar.today
    .filter((e) => !e.allDay)
    .reduce(
      (acc, e) =>
        acc +
        Math.max(0, Math.round((new Date(e.end).getTime() - new Date(e.start).getTime()) / 60_000)),
      0,
    );
  const busyPercent = Math.min(100, Math.round((bookedMinutes / wakingMinutes) * 100));

  /** The event happening right now, if one is. Focus means this first. */
  const live = state.calendar.today.find(
    (e) => !e.allDay && new Date(e.start) <= now && new Date(e.end) > now,
  );

  /** The day's biggest block — what the day is actually about. */
  const biggest = state.calendar.today
    .filter((e) => !e.allDay)
    .map((e) => ({
      title: e.title,
      start: e.start,
      minutes: Math.max(
        0,
        Math.round((new Date(e.end).getTime() - new Date(e.start).getTime()) / 60_000),
      ),
    }))
    .sort((a, b) => b.minutes - a.minutes)[0];

  const hasRows =
    state.energy.score > 0 ||
    Boolean(next) ||
    Boolean(live) ||
    Boolean(session) ||
    queued.length > 0 ||
    nudges.length > 0 ||
    Boolean(pattern) ||
    Boolean(memory);

  if (!hasRows) {
    // Nothing to be peripheral about. The orb is the whole interface.
    return null;
  }

  return (
    <div
      onMouseEnter={onInteract}
      onFocus={onInteract}
      className={`w-full transition-opacity duration-[var(--t-slow)] ease-[var(--ease)] ${
        idle ? "opacity-55" : "opacity-100"
      }`}
    >
      <div className="mx-auto max-w-[var(--content-max)] px-6">
        <div className="label mb-1">Briefing</div>

        <div className="divide-y divide-hairline">
          {/* Energy — the score, and the three things it is made of: sleep,
              meals and how booked the day is. A number with no visible working
              is one a person can only trust or ignore. */}
          <Row label="Energy">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="text-[15px] font-light text-text">
                {Math.round(state.energy.score)}
              </span>
              <span className="text-[13px] font-light text-dim">{state.energy.band}</span>
              {reported ? (
                <span className="timestamp">you said {reported.level}/5</span>
              ) : (
                <span className="timestamp">not reported</span>
              )}
            </div>

            {/* The inputs. Sleep is absent when nothing measured it, and says
                so rather than showing a zero. */}
            <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="timestamp">
                {sleepHours !== undefined ? `${sleepHours.toFixed(1)}h sleep` : "sleep unrecorded"}
              </span>
              <span className="timestamp">{meals.logged} of {meals.of} meals</span>
              <span className="timestamp">schedule {busyPercent}% booked</span>
            </div>

            {state.energy.note ? (
              <p className="mt-1 text-[13px] leading-relaxed font-light text-dim">
                {state.energy.note}
              </p>
            ) : null}
            <div className="mt-2 max-w-[240px]">
              <Bar
                value={state.energy.score / 100}
                label={`Energy ${Math.round(state.energy.score)} out of 100, ${state.energy.band}`}
              />
            </div>
          </Row>

          {/* Next — with a day label, because "next" is often tomorrow. */}
          {next ? (
            <Row label="Next">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="text-[15px] font-light text-text">
                  {clockTime(next.start)
                    ? `${clockTime(next.start)} · ${next.title}`
                    : next.title}
                </span>
                {relativeDay(next.start) ? (
                  <span className="timestamp">{relativeDay(next.start)}</span>
                ) : null}
              </div>
              {next.location ? (
                <p className="mt-0.5 text-[13px] font-light text-dim">
                  {next.location}
                </p>
              ) : null}
              {state.calendar.freeMinutes > 0 ? (
                <p className="mt-0.5 timestamp">
                  {`${Math.round(state.calendar.freeMinutes / 60)}h free after`}
                </p>
              ) : null}
            </Row>
          ) : null}

          {/* Focus — the current event as per the schedule, first. Falling
              back to the focus log, then to the next task, each labelled as
              what it actually is rather than as "what you are on". */}
          {live || session || queued.length > 0 ? (
            <Row label="Focus">
              {live ? (
                <>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <span className="text-[15px] font-light text-text">{live.title}</span>
                    <span className="timestamp">
                      {minutesLeft(live.end, now)} left
                    </span>
                  </div>
                  <p className="mt-0.5 timestamp">
                    on now
                    {live.location ? ` · ${live.location}` : ""}
                  </p>
                </>
              ) : session ? (
                <>
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <span className="text-[15px] font-light text-text">{session.label}</span>
                    <span className="timestamp">
                      {session.completed ? `${session.minutes}m` : `${session.minutes}m so far`}
                    </span>
                  </div>
                  <p className="mt-0.5 timestamp">
                    {session.completed ? "last session" : "in progress"}
                    {session.media ? ` · ${session.media}` : ""}
                    {state.focus.totalMinutes > 0
                      ? ` · ${Math.round(state.focus.totalMinutes / 60)}h this week`
                      : ""}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[15px] font-light text-text">{queued[0].title}</p>
                  <p className="mt-0.5 timestamp">nothing on now · next in the list</p>
                </>
              )}
            </Row>
          ) : null}

          {/* Open — the day's biggest block, then the urgent and unfinished
              work. The nudges live here rather than in a row of their own: a
              separate "Now" was a second name for the same question, which is
              what the user said when they saw it. */}
          {queued.length > 0 || nudges.length > 0 || biggest ? (
            <Row label="Open">
              {biggest ? (
                <div className="mb-2">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <span className="text-[15px] font-light text-text">{biggest.title}</span>
                    <span className="timestamp">{span(biggest.minutes)}</span>
                    {clockTime(biggest.start) ? (
                      <span className="timestamp">{clockTime(biggest.start)}</span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 timestamp">the biggest block today</p>
                </div>
              ) : null}

              {queued.length > 0 ? (
                <>
                  <ul className="space-y-1.5">
                    {queued.map((task) => (
                      <li key={task.id} className="flex items-baseline gap-3">
                        <span className="min-w-0 flex-1 truncate text-[14px] font-light text-text">
                          {task.title}
                        </span>
                        {task.project ? (
                          <span className="timestamp shrink-0">{task.project}</span>
                        ) : null}
                        {task.estimateMinutes ? (
                          <span className="timestamp shrink-0">{`${task.estimateMinutes}m`}</span>
                        ) : null}
                        {task.due ? (
                          <span className="timestamp shrink-0">{relativeDay(task.due)}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 timestamp">
                    {state.tasks.openCount > queued.length
                      ? `${state.tasks.openCount} open in total`
                      : "Nothing else open"}
                  </p>
                </>
              ) : null}

              {nudges.length > 0 ? (
                <ul className="mt-2 space-y-2">
                  {nudges.map((nudge) => (
                    <li
                      key={nudge.id}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
                    >
                      <span
                        className={`text-[13px] leading-relaxed font-light ${
                          NUDGE_TONE[nudge.tone] ?? "text-dim"
                        }`}
                      >
                        {nudge.text}
                      </span>
                      {nudge.action ? (
                        <GhostButton
                          label="show me"
                          onClick={() => {
                            if (nudge.action) onAct(nudge.action);
                          }}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Row>
          ) : null}

          {/* A pattern is only worth the space when it proposes something. */}
          {pattern ? (
            <Row
              label="Pattern"
              action={
                pattern.action ? (
                  <GhostButton
                    label="start focus"
                    onClick={() => {
                      if (pattern.action) onAct(pattern.action);
                    }}
                  />
                ) : null
              }
            >
              <p className="text-[14px] leading-relaxed font-light text-text">
                {pattern.observation}
              </p>
              <p className="mt-0.5 timestamp">
                {`confidence ${Math.round(pattern.confidence * 100)}%`}
              </p>
              {pattern.suggestion ? (
                <p className="mt-1 text-[13px] font-light text-dim">
                  {pattern.suggestion}
                </p>
              ) : null}
            </Row>
          ) : null}

          {/* One recalled memory, with the reason it surfaced. */}
          {memory ? (
            <Row label="Recall">
              <p className="text-[14px] font-light text-text">
                {memory.memory.title}
              </p>
              <p className="mt-0.5 text-[13px] leading-relaxed font-light text-dim">
                {memory.reason}
              </p>
            </Row>
          ) : null}
        </div>

        {/* Which mind is holding the conversation.
         *
         * This reports the *configuration*, not the last reply's engine,
         * and the difference is the whole point. `/api/state` flips to
         * "local" the moment one model call fails, which made a working
         * setup look broken: the user pastes a key, one request is refused,
         * and the interface says "The local mind is answering" forever
         * after. A configured model is a fact about settings, so it is read
         * from settings. The per-reply truth is on the reply itself. */}
        <button
          type="button"
          onClick={onOpenSettings}
          className="timestamp mt-3 rounded-[var(--r-sm)] text-left transition-colors duration-[var(--t-fast)] hover:text-dim"
        >
          {modelActive
            ? `${modelName || "A model"} is configured and answering · settings`
            : engine === "llm"
              ? "The language model is answering."
              : "The local mind is answering · add a model"}
        </button>
      </div>
    </div>
  );
}
