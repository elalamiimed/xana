"use client";

/**
 * The week and the day: a real time grid.
 *
 * THE THREE THINGS IT DRAWS
 *
 * Rules, columns, blocks. The rules are two repeating gradients rather than
 * forty-eight elements; the columns are the days, one element each; and a block
 * is positioned from its own numbers — `top` from the minute it starts, `height`
 * from how long it lasts, `left` and `width` from which of the day's overlap
 * columns it landed in. Nothing here measures anything: every pixel comes from
 * `@/lib/calendar/geometry`, which is the same module the checks run against.
 *
 * WHY THE HOUR RULES AND THE BLOCK HEIGHTS CANNOT DRIFT
 *
 * `--cal-hour` is written by this component from the same `hourHeight` the
 * geometry was given, so a block that starts at 14:00 starts on the line that
 * says two. Two independent numbers here would put every block a few pixels off
 * its own hour, which is the kind of wrongness you can see but not name.
 *
 * NOW, AND WHERE THE VIEW OPENS
 *
 * A day runs from midnight, so an unscrolled week view opens on eight empty
 * hours. The grid scrolls itself to the current time instead — once, with no
 * animation, because a scroll the user did not ask for should not also be a
 * movement they have to watch. The now-line is the one thing on this surface
 * that moves without being touched, and it is one hairline in today's column.
 */

import { useEffect, useMemo, useState } from "react";

import type { CalendarEvent } from "@/lib/core/types";
import {
  blockMinutes,
  bucketDays,
  clockLabel,
  dayLength,
  formatClock,
  gripHeightFor,
  SLOT_MINUTES,
  type DayEvent,
} from "@/lib/calendar/geometry";
import { fromDateKeyInZone, hourInZone, minuteInZone, weekdayShortInZone } from "@/lib/core/zone";

import type { CalendarActions } from "./contract";
import type { MonthDrag } from "./useMonthDrag";
import type { TimeGridDrag } from "./useTimeGridDrag";

export interface TimeGridProps {
  /** The days drawn, in order: seven for a week, one for a day. */
  days: string[];
  today: string;
  events: readonly CalendarEvent[];
  /** Pixels per hour; the same value the geometry was given. */
  hourHeight: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  drag: TimeGridDrag;
  /** The all-day lane reuses the month's day-to-day drag, which is the same question. */
  allDayDrag: MonthDrag;
  actions: CalendarActions;
  /** False for a feed's record, which is shown but not moved or resized. */
  canEdit: (event: CalendarEvent) => boolean;
  /** The record that was just dropped, if any, so it can arrive visibly. */
  landed?: string | null;
  /**
   * True when the pointer is a thumb rather than a mouse.
   *
   * The grip geometry depends on it: a finger needs more of a short block left
   * as body than a cursor does, and without that the grips eat the whole block
   * and the move gesture becomes unreachable. See `gripHeightFor`.
   */
  coarse: boolean;
}

/** The hours that get a label. Midnight is where the day starts, not a label. */
const LABELS = Array.from({ length: 23 }, (_, index) => index + 1);

export default function TimeGrid({
  days,
  today,
  events,
  hourHeight,
  scrollRef,
  drag,
  allDayDrag,
  actions,
  canEdit,
  landed,
  coarse,
}: TimeGridProps) {
  const first = days[0] ?? today;
  /** The whole grid's entries, placed once — see `bucketDays`. */
  const buckets = useMemo(() => bucketDays(events, days), [events, days]);
  const lane = days.some((day) => (buckets.get(day)?.allDay.length ?? 0) > 0);

  /**
   * Open on the working day rather than on midnight, once.
   *
   * Deliberately not `scroll-behavior: smooth`: this happens on the frame the
   * room appears, and an animated scroll there would be the app moving under a
   * pointer that has not touched anything yet.
   */
  useEffect(() => {
    const grid = scrollRef.current;
    if (!grid) return;
    const target = (liveMinutes() / 60) * hourHeight - grid.clientHeight / 3;
    grid.scrollTop = Math.max(0, target);
    // Once per hour height, not once per render: this is a first impression, not
    // a scroll position the user has to be held to.
  }, [hourHeight, scrollRef]);

  return (
    <div
      className="cal-time flex h-full min-h-[420px] flex-col"
      style={{ "--cal-hour": `${hourHeight}px` } as React.CSSProperties}
      data-time-grid
      data-days={days.length}
    >
      {/* The head and the all-day lane live outside the vertical scroller and
          inside the horizontal one, so a week on a phone scrolls sideways as one
          piece and the day names never leave their columns. */}
      <div className="min-h-0 flex-1 overflow-x-auto">
        {/* WHY THE WIDTH IS A MINIMUM PER DAY RATHER THAN A MINIMUM FOR THE ROW

            This was `min-w-[560px]` for a seven-day week, which is a row that is
            560px wide whatever the screen is — so on a 390px phone the columns
            were squeezed to 71px each *and* four of them sat past the right edge
            behind a horizontal scroll nothing announced. The day the user cared
            about was technically present and practically invisible.

            A minimum per column instead: `--cal-day-min` is 132px, so a week is
            7x132 + the 64px gutter = 988px and scrolls sideways on a phone while
            each day keeps a width that can hold a time and a title. On a wide
            window the row is narrower than its container, `flex-1` takes over,
            and nothing about the desktop week changes. The side effect is the
            good one: measured at 390x844, a phone now shows three whole days at
            a readable size, which is what every phone calendar does, rather than
            seven unreadable slivers. */}
        <div
          className="flex h-full flex-col"
          style={
            days.length > 1
              ? ({ "--cal-day-min": "132px" } as React.CSSProperties)
              : undefined
          }
        >
          {/* A flex row, not the month's seven-column grid: the day view draws
              one column beside a 56px gutter, and a 7-track grid would leave
              that single day a seventh of the width with six empty tracks
              beside it. Flex with `flex-1` per day gives every view — one day,
              seven days — the same tracks the body below uses. */}
          <div className="flex shrink-0 border-b border-hairline">
            <div className="w-[64px] shrink-0" aria-hidden="true" />
            {days.map((day) => {
              const isToday = day === today;
              return (
                <button
                  key={day}
                  type="button"
                  data-column-head={day}
                  aria-current={isToday ? "date" : undefined}
                  /* The same minimum the body's columns carry (`--cal-day-min`),
                     so a day name never drifts off the column it names. The head
                     rows are buttons rather than `.cal-column` divs — they open
                     the day view — so the rule is repeated here through the same
                     custom property rather than through a shared class. */
                  style={{ minWidth: "var(--cal-day-min, 0)" }}
                  className="flex flex-1 items-baseline justify-center gap-1.5 py-1.5 transition-colors duration-[var(--t-fast)]"
                  onClick={() => actions.openDay(day)}
                >
                  <span className={isToday ? "label text-text" : "label"}>
                    {weekdayShortInZone(fromDateKeyInZone(day))}
                  </span>
                  <span
                    className={
                      isToday
                        ? "text-[13px] font-normal tabular-nums text-accent"
                        : "text-[13px] font-normal tabular-nums text-dim"
                    }
                  >
                    {String(Number(day.slice(8, 10)))}
                  </span>
                </button>
              );
            })}
          </div>

          {lane ? (
            <div className="flex shrink-0 border-b border-hairline" data-allday-lane>
              <div className="w-[64px] shrink-0 px-2 py-1.5">
                <span className="label">all day</span>
              </div>
              <div className="flex flex-1">
                {days.map((day) => (
                  <div key={day} data-day={day} className="cal-column flex-1 p-1">
                    <div className="flex flex-col gap-1">
                      {(buckets.get(day)?.allDay ?? []).map((event) => (
                        <button
                          key={event.id}
                          type="button"
                          data-event={event.id}
                          data-synced={canEdit(event) ? undefined : "true"}
                          className="cal-allday-chip"
                          onPointerDown={(pointer) => allDayDrag.onChipPointerDown(pointer, event, day)}
                          onClick={(click) => actions.open(event, click.currentTarget.getBoundingClientRect())}
                        >
                          <span className="cal-chip-title">{event.title}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-y-auto overflow-x-clip"
            data-time-scroll
          >
            <div className="relative" style={{ height: `${24 * hourHeight}px` }}>
              <div className="relative flex h-full">
                <div className="cal-gutter w-[64px] shrink-0">
                  {LABELS.map((hour) => (
                    <span
                      key={hour}
                      /* `whitespace-nowrap` because a clock reading of eight
                         characters — "03:00 PM" — wraps in a 56px gutter, and a
                         wrapped label is a two-line block centred on its own hour
                         line, which collides with the label above it and reads as
                         a rendering fault. The gutter is 64px for the same
                         reason: it is sized by the longest reading a locale can
                         produce, not by the roundest number. */
                      className="timestamp absolute right-1.5 -translate-y-1/2 whitespace-nowrap tabular-nums"
                      style={{ top: `${hour * hourHeight}px` }}
                    >
                      {clockLabel(first, hour * 60)}
                    </span>
                  ))}
                </div>

                <div className="relative flex flex-1">
                  {/* The hour and half-hour rules, under the blocks. */}
                  <div className="cal-rules cal-rules-half absolute inset-0 z-[1]" aria-hidden="true" />
                  {days.map((day, index) => (
                    <div
                      key={day}
                      data-column={day}
                      data-today={day === today ? "true" : undefined}
                      className="cal-column flex-1"
                      onPointerDown={(pointer) => drag.onSurfacePointerDown(pointer, day)}
                      /* A click here is a tap's own meaning: a finger that
                         lifted inside the hold window never armed, so the
                         pointer engine cancelled and this is what is left of
                         the gesture. A mouse press arms at once and swallows
                         the click, so it never arrives twice. */
                      onClick={(click) => drag.onSurfaceClick(click, day)}
                    >
                      {(buckets.get(day)?.timed ?? []).map((entry) => (
                        <Block
                          key={entry.event.id}
                          entry={entry}
                          day={day}
                          hourHeight={hourHeight}
                          canEdit={canEdit(entry.event)}
                          drag={drag}
                          onOpen={actions.open}
                          onNudge={actions.nudge}
                          before={days[index - 1]}
                          after={days[index + 1]}
                          landed={landed === entry.event.id}
                          coarse={coarse}
                        />
                      ))}
                      {day === today ? <NowLine hourHeight={hourHeight} /> : null}
                    </div>
                  ))}
                </div>

                {/* The drop indicator is a child of the scroller's own content
                    box, not of the columns: its x is measured from the scroller's
                    left edge, and the gutter is part of that distance. */}
                {drag.showIndicator ? (
                  <div ref={drag.indicatorRef} className="cal-drop" aria-hidden="true" data-drop-indicator />
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One entry, placed and sized from its own numbers.
 *
 * The grips are spans rather than buttons because they live inside the block,
 * and a button inside a button is not markup a browser will parse the way it
 * reads. They are a pointer affordance only: the way to change a length without
 * a pointer is the editor's own `minutes` field, which is exact.
 *
 * HOW MUCH OF THE BLOCK THEY TAKE IS COMPUTED, NOT DECLARED
 *
 * The grips and the move gesture want the same pixels, and the block's height is
 * its duration, so a fixed grip height silently deletes the move gesture on
 * short entries — measured at 22px tall with two 14px grips, a 30-minute block
 * had a body of minus six pixels and could be resized but never moved. `gripHeightFor`
 * leaves the body its minimum first and returns zero when what is left is too
 * thin to hit, in which case the whole block moves and the editor is the way to
 * change the length.
 */
function Block({
  entry,
  day,
  hourHeight,
  canEdit,
  drag,
  onOpen,
  onNudge,
  before,
  after,
  landed,
  coarse,
}: {
  entry: DayEvent;
  day: string;
  hourHeight: number;
  canEdit: boolean;
  drag: TimeGridDrag;
  onOpen: CalendarActions["open"];
  /** Move or resize without a pointer. */
  onNudge: CalendarActions["nudge"];
  /** The neighbouring days, for left and right. */
  before?: string;
  after?: string;
  landed: boolean;
  coarse: boolean;
}) {
  const { event } = entry;
  const minutes = blockMinutes(entry);
  const height = (minutes / 60) * hourHeight;
  const time = clockLabel(day, entry.startMin);
  const width = 100 / entry.columns;
  const grip = canEdit ? gripHeightFor(height, coarse) : 0;

  /**
   * The keyboard path, which is the same three edits a drag makes.
   *
   * Up and down are a quarter hour, with shift for the hour people actually
   * think in; left and right are a day. Resizing has no key of its own — the
   * editor's `minutes` field is exact, and a length nudged by a quarter hour at
   * a time is a worse tool than a field that says what it is.
   */
  const nudge = (keyEvent: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!canEdit) return;
    const step = keyEvent.shiftKey ? 60 : SLOT_MINUTES;
    const dayMinutes = dayLength(day);
    const moves: Record<string, () => void> = {
      ArrowUp: () => onNudge(event, day, Math.max(entry.startMin - step, 0), minutes),
      ArrowDown: () =>
        onNudge(event, day, Math.min(entry.startMin + step, dayMinutes - minutes), minutes),
      ArrowLeft: () => before && onNudge(event, before, entry.startMin, minutes),
      ArrowRight: () => after && onNudge(event, after, entry.startMin, minutes),
    };
    const move = moves[keyEvent.key];
    if (!move) return;
    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    move();
  };

  return (
    <button
      type="button"
      data-event={event.id}
      data-start={formatClock(entry.startMin)}
      data-minutes={minutes}
      data-synced={canEdit ? undefined : "true"}
      data-continues-before={entry.continuesBefore ? "true" : undefined}
      data-continues-after={entry.continuesAfter ? "true" : undefined}
      className={`cal-block z-[2]${landed ? " cal-settle" : ""}`}
      style={{
        top: `${(entry.startMin / 60) * hourHeight}px`,
        height: `${height}px`,
        left: `calc(${entry.column * width}% + 1px)`,
        width: `calc(${width}% - 3px)`,
      }}
      title={`${time} · ${event.title}`}
      aria-label={`${time}, ${event.title}, ${minutes} minutes`}
      onPointerDown={(pointer) => drag.onBlockPointerDown(pointer, event, day)}
      onClick={(click) => {
        // A block sits inside its column, and the column's own click means
        // "put something here" — so without this, opening an entry would also
        // open the new-entry form behind it.
        click.stopPropagation();
        onOpen(event, click.currentTarget.getBoundingClientRect());
      }}
      onKeyDown={nudge}
    >
      <span className="block truncate">{event.title}</span>
      {/* The hour is only worth printing when there is room for it; below about
          twenty minutes the title alone is what a person is reading. It carries
          `tabular-nums` so a column of times lines up on the colon, which is
          what the hour gutter beside it already does. */}
      {height >= 26 ? <span className="timestamp tabular-nums">{time}</span> : null}
      {grip > 0 ? (
        <>
          <span
            className="cal-grip"
            data-edge="start"
            aria-hidden="true"
            style={{ height: `${grip}px` }}
            onPointerDown={(pointer) => drag.onHandlePointerDown(pointer, event, day, "start")}
          />
          <span
            className="cal-grip"
            data-edge="end"
            aria-hidden="true"
            style={{ height: `${grip}px` }}
            onPointerDown={(pointer) => drag.onHandlePointerDown(pointer, event, day, "end")}
          />
        </>
      ) : null}
    </button>
  );
}

/** Minutes into the app's day, right now. */
function liveMinutes(): number {
  const now = new Date();
  return hourInZone(now) * 60 + minuteInZone(now);
}

/**
 * The current-time hairline, and the only thing that moves on its own.
 *
 * It keeps its own clock deliberately. The first version held the minute in
 * `TimeGrid`, so every tick re-rendered the whole grid — 23 hour labels, seven
 * columns and every block — to move one line by 0.9 of a pixel. React's diff
 * made the DOM cost zero (a MutationObserver counts one attribute write a
 * minute), but the reconciliation was still paid every minute for as long as the
 * room stayed open. Now the tick stops here.
 */
function NowLine({ hourHeight }: { hourHeight: number }) {
  const [minutes, setMinutes] = useState(() => liveMinutes());

  useEffect(() => {
    const timer = setInterval(() => setMinutes(liveMinutes()), 60_000);
    return () => clearInterval(timer);
  }, []);

  return <span className="cal-now" style={{ top: `${(minutes / 60) * hourHeight}px` }} aria-hidden="true" />;
}
