"use client";

/**
 * The log: what a day actually contained, and the way to write it down.
 *
 * WHY THIS ROOM EXISTS
 *
 * Every health field in this app arrived from somewhere else — a phone posting
 * to `/api/health/ingest`, an Apple Health export in a watched folder — and the
 * briefing said "sleep unrecorded", "0 of 3 meals", "mood unrecorded" over a
 * database that could hold all four perfectly well. Meals and energy could be
 * spoken; sleep, mood, steps and active minutes had no way in at all. A person
 * without a phone shortcut could read that panel for a year and never fill one
 * of its numbers, which is exactly what happened.
 *
 * WHAT IT IS NOT
 *
 * Not a dashboard. There is no chart, no streak, no target line, and nothing
 * here congratulates anyone: the app's own rule is that being told "well done"
 * for eating lunch is how a person stops telling you things. It shows the last
 * week so a number has a place to sit, and it writes on the tap.
 *
 * WHY THE WEEK IS THE WHOLE WINDOW
 *
 * Seven days, because that is the unit the rest of the app already reasons in:
 * `sleepAvgHours` is a seven-day average, `sleepDebtHours` a seven-day debt, and
 * the pattern detectors pair last night with today. A longer strip would let
 * someone see a number the forecast does not use.
 *
 * CORRECTING, NOT JUST ADDING
 *
 * Every row can be cleared. A log you can only add to is a log that is wrong the
 * first time you tap the wrong day, and health has no trash of its own — so
 * clearing is the undo, it sits beside the value it removes, and it is the same
 * operation whether the reading was typed here or arrived from a phone.
 */

import { useCallback, useEffect, useState } from "react";

import type { MealName, MoodLabel } from "@/lib/cave/types";
import { dayFullLabel, dayHasReading, dayOfMonth, daySlotLabel, healthDays } from "@/lib/cave/types";

import { emptyNote } from "./empty-note";
import type { CaveController } from "./useCave";

export interface HealthRoomProps {
  controller: CaveController;
}

/** The four moods, in the order they run from low to bright. */
const MOODS: ReadonlyArray<{ id: MoodLabel; label: string }> = [
  { id: "low", label: "low" },
  { id: "flat", label: "flat" },
  { id: "good", label: "good" },
  { id: "bright", label: "bright" },
];

/** Breakfast, lunch, dinner — the three the briefing counts — then snacks. */
const MEALS: ReadonlyArray<{ id: MealName; label: string }> = [
  { id: "breakfast", label: "breakfast" },
  { id: "lunch", label: "lunch" },
  { id: "dinner", label: "dinner" },
  { id: "snack", label: "snack" },
];

export default function HealthRoom({ controller }: HealthRoomProps) {
  const health = controller.health;
  const today = health?.today ?? "";
  // Named `week`, not `window`: this is a client component, and shadowing the
  // global in a function that might one day need it is the kind of thing that
  // compiles and then fails at the worst moment.
  const week = health ? healthDays(health.today, health.windowDays) : [];
  const weekKey = week.join(",");
  const [selected, setSelected] = useState("");
  /** Typed-but-unsaved numbers, keyed by day and field. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  /**
   * Follow the server's idea of which day it is.
   *
   * Two things this has to get right. A tab left open across midnight should
   * move its "today" with the server's, or a reading typed at 00:10 lands on the
   * wrong slot. And a day with *nothing* in it is still a day you can select —
   * the first thing anyone does here is open an empty day and fill it — so the
   * selection is validated against the week, never against the rows that happen
   * to exist.
   */
  useEffect(() => {
    if (!health) return;
    setSelected((current) => (week.includes(current) ? current : health.today));
    // `week` is rebuilt on every render; its content is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [health, weekKey]);

  const day = health?.days.find((sample) => sample.date === selected);
  const pending = controller.pending;

  const setDraft = useCallback(
    (field: string, text: string) => {
      setDrafts((current) => ({ ...current, [`${selected}:${field}`]: text }));
    },
    [selected],
  );

  /**
   * Commit a typed number.
   *
   * The draft is dropped either way, so the field shows what the database
   * actually holds rather than what was typed at it. A value that is not a
   * number is dropped without a message: the field reverting under the cursor is
   * the whole answer, and a sentence about it would be the app narrating a
   * keystroke. A number outside a day's range is *not* dropped here — the
   * operation refuses it and says so, which is the case worth hearing about.
   */
  const commitNumber = useCallback(
    async (field: string) => {
      const key = `${selected}:${field}`;
      const raw = drafts[key];
      setDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      if (!selected || raw === undefined || raw.trim() === "") return;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return;
      await controller.run("health.log", { date: selected, field, value: parsed }, field);
    },
    [controller, drafts, selected],
  );

  const clear = useCallback(
    async (field: string) => {
      if (!selected) return;
      setDrafts((current) => {
        const next = { ...current };
        delete next[`${selected}:${field}`];
        return next;
      });
      await controller.run("health.clear", { date: selected, field }, field);
    },
    [controller, selected],
  );

  const pick = useCallback(
    async (field: string, value: unknown) => {
      if (!selected) return;
      await controller.run("health.log", { date: selected, field, value }, field);
    },
    [controller, selected],
  );

  const tick = useCallback(
    async (meal: MealName, on: boolean) => {
      if (!selected) return;
      await controller.run("health.meal", { date: selected, meal, on }, `meal:${meal}`);
    },
    [controller, selected],
  );

  if (!health) {
    return (
      <section className="mx-auto mt-10 w-full max-w-[var(--content-max)] px-6">
        <h3 className="label">Log</h3>
        <p className="mt-3 max-w-[62ch] text-[13px] leading-relaxed font-light text-dim">
          {emptyNote(controller.loading, "Nothing logged yet.")}
        </p>
      </section>
    );
  }

  const hasAnything = health.days.some((sample) => dayHasReading(sample));
  const mealsLogged = day?.mealsLogged ?? [];

  return (
    <section className="mx-auto mt-8 w-full max-w-[var(--content-max)] px-6 pb-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="label">Log</h3>
        <p className="text-[12px] font-normal text-faint">
          {hasAnything
            ? `Last ${health.windowDays} days · what the energy forecast is built on.`
            : `The last ${health.windowDays} days, all empty.`}
        </p>
      </div>

      {/* ---------------- the week ---------------- */}
      <ol className="mt-4 flex flex-wrap gap-2" aria-label="Days">
        {week.map((date) => {
          const row = health.days.find((sample) => sample.date === date);
          const active = date === selected;
          return (
            <li key={date}>
              <button
                type="button"
                onClick={() => setSelected(date)}
                aria-pressed={active}
                aria-label={dayFullLabel(date)}
                title={dayFullLabel(date)}
                // A chip, not a chip-shaped button: this is the same selected
                // state as a mood or a meal two rows down, from `.chip`'s own
                // `[aria-pressed="true"]` rule, rather than a second inline
                // spelling of the same two alphas. The three stacked lines sit
                // in an inner column because `.chip`'s own gap is part of its
                // box and would not leave room for them in 58px.
                className="chip h-[58px] w-[62px] flex-col"
              >
                <span className="flex flex-col items-center gap-0.5">
                  <span className="text-[12px] font-normal tracking-[0.02em] text-faint">
                    {daySlotLabel(date, health.today)}
                  </span>
                  <span className="text-[13px] font-light text-text">{dayOfMonth(date)}</span>
                  {/* The one number worth a mark: sleep is what the forecast leans
                      on, and a week of it is the reason to look at a strip rather
                      than at a single day. */}
                  <span className="text-[12px] font-normal text-faint">
                    {row?.sleepHours !== undefined
                      ? `${Number.isInteger(row.sleepHours) ? row.sleepHours : row.sleepHours.toFixed(1)}h`
                      : dayHasReading(row)
                        ? "·"
                        : ""}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {/* ---------------- the day ---------------- */}
      <div className="card mt-5 px-4 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="label">{selected === health.today ? "Today" : dayFullLabel(selected)}</p>
          {day?.source && day.source !== "user" ? (
            <p className="timestamp">from {day.source}</p>
          ) : null}
        </div>

        <div className="mt-3 divide-y divide-hairline">
          <NumberRow
            label="Sleep"
            unit="hours"
            step="0.5"
            max="24"
            value={day?.sleepHours}
            draft={drafts[`${selected}:sleepHours`]}
            onDraft={(text) => setDraft("sleepHours", text)}
            onCommit={() => void commitNumber("sleepHours")}
            onClear={() => void clear("sleepHours")}
            busy={pending.has("sleepHours")}
            hint="Last night, not tonight — this is the reading the forecast leans on hardest."
          />

          <RatingRow
            label="Energy"
            value={day?.energy}
            onPick={(level) => void pick("energy", level)}
            onClear={() => void clear("energy")}
            busy={pending.has("energy")}
            hint="Your own reading, 1–5. The only energy figure in the app that is not inferred."
          />

          <ChipRow
            label="Mood"
            options={MOODS}
            selected={day?.mood ? [day.mood] : []}
            onPick={(id) => void pick("mood", id)}
            onClear={() => void clear("mood")}
            busy={pending.has("mood")}
            hint="Four labels, because a mood is not a score."
          />

          <ChipRow
            label="Meals"
            options={MEALS}
            selected={mealsLogged}
            onPick={(id) => void tick(id as MealName, !mealsLogged.includes(id as MealName))}
            busy={pending.has("meal") || MEALS.some((meal) => pending.has(`meal:${meal.id}`))}
            hint="Tap to tick off. Snacks are noted and are not one of the three the briefing counts."
            trailing={day?.meals !== undefined ? `${day.meals} of 3` : undefined}
          />

          <NumberRow
            label="Steps"
            unit="steps"
            step="100"
            max="200000"
            value={day?.steps}
            draft={drafts[`${selected}:steps`]}
            onDraft={(text) => setDraft("steps", text)}
            onCommit={() => void commitNumber("steps")}
            onClear={() => void clear("steps")}
            busy={pending.has("steps")}
            hint="Whatever your phone says, typed in once."
          />

          <NumberRow
            label="Exercise"
            unit="minutes"
            step="5"
            max="1440"
            value={day?.activeMinutes}
            draft={drafts[`${selected}:activeMinutes`]}
            onDraft={(text) => setDraft("activeMinutes", text)}
            onCommit={() => void commitNumber("activeMinutes")}
            onClear={() => void clear("activeMinutes")}
            busy={pending.has("activeMinutes")}
            hint="Moving on purpose. A walk counts."
          />
        </div>

        <p className="mt-4 max-w-[80ch] text-[12px] leading-relaxed font-normal text-faint">
          Saying it works too: “I slept 7 hours”, “mood: bright”, “8,000 steps”, “45 minutes of yoga”.
          Clearing removes one reading and nothing else — a day with nothing left in it stops existing.
        </p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Rows                                                               */
/* ------------------------------------------------------------------ */

function RowShell({
  label,
  hint,
  trailing,
  children,
}: {
  label: string;
  hint: string;
  trailing?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="label w-[68px] shrink-0">{label}</span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
        {trailing ? <span className="timestamp shrink-0">{trailing}</span> : null}
      </div>
      <p className="mt-1 max-w-[80ch] pl-[84px] text-[12px] leading-relaxed font-normal text-faint">{hint}</p>
    </div>
  );
}

/** A quiet "×" that removes the reading beside it. */
function ClearButton({ onClick, busy, what }: { onClick: () => void; busy: boolean; what: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={`Clear ${what}`}
      title={`Clear ${what}`}
      className="icon-tap grid shrink-0 place-items-center rounded-full text-faint transition-colors duration-[var(--t-fast)] hover:text-danger disabled:opacity-40"
    >
      {/* Drawn rather than typed. It was a "×" character here and an SVG cross
          on the goal card, which is two renderings of one idea and one of them
          is a font glyph that changes shape with the reader's system font. */}
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/**
 * A number, written on blur or Enter.
 *
 * Not on every keystroke: "7." is a keystroke on the way to "7.5", and a field
 * that saved what it saw would write a reading nobody typed and then read it
 * back to them as theirs. Being done with the field means blur or Enter.
 */
function NumberRow({
  label,
  unit,
  step,
  max,
  value,
  draft,
  onDraft,
  onCommit,
  onClear,
  busy,
  hint,
}: {
  label: string;
  unit: string;
  step: string;
  max: string;
  value: number | undefined;
  draft: string | undefined;
  onDraft: (text: string) => void;
  onCommit: () => void;
  onClear: () => void;
  busy: boolean;
  hint: string;
}) {
  const shown = draft ?? (value === undefined ? "" : String(value));
  return (
    <RowShell label={label} hint={hint} trailing={value === undefined ? "not recorded" : undefined}>
      {/* `.field` is `width: 100%`, which is right in a settings form and wrong
          here: a row holding one number would stretch the whole card and push
          its unit to the far edge. Capped rather than overridden, so the iOS
          zoom floor inside that class still applies. */}
      <input
        type="number"
        inputMode="decimal"
        step={step}
        min="0"
        max={max}
        value={shown}
        placeholder="—"
        aria-label={`${label} in ${unit}`}
        disabled={busy}
        onChange={(event) => onDraft(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onCommit();
          }
        }}
        className="field max-w-[104px]"
      />
      <span className="text-[12px] font-normal text-faint">{unit}</span>
      {value !== undefined || (draft ?? "").trim() !== "" ? (
        <ClearButton onClick={onClear} busy={busy} what={`${label.toLowerCase()} for this day`} />
      ) : null}
      {busy ? <span className="timestamp">saving…</span> : null}
    </RowShell>
  );
}

/** 1–5, as five buttons. */
function RatingRow({
  label,
  value,
  onPick,
  onClear,
  busy,
  hint,
}: {
  label: string;
  value: number | undefined;
  onPick: (level: number) => void;
  onClear: () => void;
  busy: boolean;
  hint: string;
}) {
  return (
    <RowShell label={label} hint={hint} trailing={value === undefined ? "not reported" : `${value}/5`}>
      <div role="group" aria-label={label} className="flex items-center gap-1.5">
        {[1, 2, 3, 4, 5].map((level) => (
          <button
            key={level}
            type="button"
            onClick={() => onPick(level)}
            disabled={busy}
            aria-pressed={value === level}
            // `data-on` paints the run up to the chosen number, which is how a
            // 1-5 rating reads at a glance, without claiming those levels are
            // the choice. The chosen state itself is `aria-pressed`, so it is
            // word for word what a mood or a meal chip says.
            data-on={value !== undefined && level <= value}
            aria-label={`${label} ${level} of 5`}
            className="chip chip-round"
          >
            {level}
          </button>
        ))}
      </div>
      {value !== undefined ? (
        <ClearButton onClick={onClear} busy={busy} what={`${label.toLowerCase()} for this day`} />
      ) : null}
    </RowShell>
  );
}

/** One of a few words, or a few meals. */
function ChipRow({
  label,
  options,
  selected,
  onPick,
  onClear,
  busy,
  hint,
  trailing,
}: {
  label: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  selected: readonly string[];
  onPick: (id: string) => void;
  onClear?: () => void;
  busy: boolean;
  hint: string;
  trailing?: string;
}) {
  return (
    <RowShell label={label} hint={hint} trailing={trailing}>
      <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
        {options.map((option) => {
          const on = selected.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onPick(option.id)}
              disabled={busy}
              aria-pressed={on}
              className="chip chip-round"
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {onClear && selected.length > 0 ? (
        <ClearButton onClick={onClear} busy={busy} what={`${label.toLowerCase()} for this day`} />
      ) : null}
    </RowShell>
  );
}
