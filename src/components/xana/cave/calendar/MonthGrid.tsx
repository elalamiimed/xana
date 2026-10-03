"use client";

/**
 * The month: six rows of days, one chip per entry.
 *
 * WHAT A MONTH IS FOR
 *
 * Not for reading times — the shape of the month is the information. So a cell
 * shows the entries in order with the hour they start at, and everything longer
 * than the cell is a count that opens the day. Three chips and a "+N" is the
 * same bargain every calendar makes, because a month grid where every day shows
 * all eight of its meetings is a month grid that shows two weeks.
 *
 * WHY DRAGGING HERE IS ONLY ABOUT THE DAY
 *
 * There is no clock in this view to be precise about, so a drag asks one
 * question: which cell is under the pointer. The entry keeps its hour — moving
 * "Standup" from Tuesday to Thursday must not also move it from 09:30 to
 * wherever the pointer happened to be, which is the bug a chip that followed the
 * pointer's y would produce.
 *
 * KEYBOARD
 *
 * No `role="grid"`. A grid role promises arrow-key navigation between cells, and
 * this one is a list of focusable things instead: tab reaches every day and every
 * chip, Enter opens what is focused, and the day view is one press away for
 * anything the month can only summarise. Claiming the role without the
 * behaviour would tell a screen reader that something exists which does not —
 * the same mistake the cave refuses to make with `aria-modal`.
 */

import { useMemo } from "react";

import type { CalendarEvent } from "@/lib/core/types";
import {
  bucketDays,
  clockLabel,
  MONTH_CHIPS,
} from "@/lib/calendar/geometry";
import { fromDateKeyInZone, weekdayShortInZone } from "@/lib/core/zone";

import type { CalendarActions } from "./contract";
import type { MonthDrag } from "./useMonthDrag";

export interface MonthGridProps {
  /** The 42 days of the grid, Monday first. */
  days: string[];
  anchor: string;
  today: string;
  events: readonly CalendarEvent[];
  actions: CalendarActions;
  drag: MonthDrag;
  /** False for a feed's record, which is shown but not moved. */
  canEdit: (event: CalendarEvent) => boolean;
  /** Opens a day in the day view. */
  onOpenDay: (day: string) => void;
  /** The record that was just dropped, if any, so it can arrive visibly. */
  landed?: string | null;
}

export default function MonthGrid({
  days,
  anchor,
  today,
  events,
  actions,
  drag,
  canEdit,
  onOpenDay,
  landed,
}: MonthGridProps) {
  const heads = days.slice(0, 7).map((day) => weekdayShortInZone(fromDateKeyInZone(day)));
  const month = anchor.slice(0, 7);
  /**
   * The whole grid's entries, placed once.
   *
   * Asking each of the 42 cells for its own day made every render resolve the
   * zone per day *and* per event, which is what made a view switch a 173ms task
   * (`bucketDays` carries the measurement). One pass, one map, 42 reads.
   */
  const buckets = useMemo(() => bucketDays(events, days), [events, days]);

  return (
    /* No `h-full` and no `min-h-0`: this block is allowed to be taller than the
       room, and the room scrolls. Shrinking the six rows to fit instead is what
       cuts the last week in half, and a month whose last week is half a week is
       not a month. */
    <div className="flex flex-1 flex-col" data-month-grid>
      <div className="cal-week-head shrink-0 border-b border-hairline">
        {heads.map((head, index) => (
          <div key={`${head}-${index}`} className="px-2 py-1.5">
            <span className="label">{head}</span>
          </div>
        ))}
      </div>

      <div className="cal-month-grid">
        {days.map((day) => {
          const bucket = buckets.get(day);
          const allDay = bucket?.allDay ?? [];
          const timed = bucket?.timed ?? [];
          const entries = [
            ...allDay.map((event) => ({ event, time: null as string | null })),
            ...timed.map((placed) => ({ event: placed.event, time: clockLabel(day, placed.startMin) })),
          ];
          const shown = entries.slice(0, MONTH_CHIPS);
          const hidden = entries.length - shown.length;

          return (
            <div
              key={day}
              data-day={day}
              data-outside={day.slice(0, 7) === month ? undefined : "true"}
              data-today={day === today ? "true" : undefined}
              className="cal-cell"
              /* A named group rather than a bare div: `aria-label` on an element
                 with no role is ignored, so the count beside the day number
                 would be a label nobody hears. */
              role="group"
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                // Nine is the hour a new entry gets when a day is pressed rather
                // than an hour: it is the one time of day a calendar can assume
                // without being wrong about the intention.
                actions.beginCreate(day, 9 * 60, 60, box);
              }}
              aria-label={`${day}, ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`}
            >
              <div className="flex items-center justify-between gap-1">
                <button
                  type="button"
                  className="cal-daynum"
                  aria-label={`Open ${day}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenDay(day);
                  }}
                >
                  {String(Number(day.slice(8, 10)))}
                </button>
                {entries.length > 0 ? (
                  <span className="timestamp tabular-nums" aria-hidden="true">
                    {entries.length}
                  </span>
                ) : null}
              </div>

              <div className="mt-1 flex flex-col gap-[2px]">
                {shown.map(({ event, time }) => (
                  <button
                    key={event.id}
                    type="button"
                    data-event={event.id}
                    data-synced={canEdit(event) ? undefined : "true"}
                    className={`cal-chip${landed === event.id ? " cal-settle" : ""}`}
                    title={`${time ? `${time} ` : ""}${event.title}`}
                    aria-label={`${time ? `${time}, ` : "all day, "}${event.title}`}
                    onPointerDown={(pointer) => drag.onChipPointerDown(pointer, event, day)}
                    onClick={(click) => {
                      click.stopPropagation();
                      actions.open(event, click.currentTarget.getBoundingClientRect());
                    }}
                  >
                    {time ? (
                      <span className="cal-chip-time">{time}</span>
                    ) : (
                      /* An all-day entry has no clock to print, so the slot
                         where one would go carries a drawn mark. It used to be
                         the character `•`, which is a glyph standing in for a
                         shape: it takes its size from the font, its position
                         from the baseline, and it is read aloud by a screen
                         reader as "bullet" unless it is hidden. */
                      <span className="cal-dot" aria-hidden="true" />
                    )}
                    <span className="cal-chip-title">{event.title}</span>
                  </button>
                ))}

                {hidden > 0 ? (
                  <button
                    type="button"
                    className="cal-more"
                    onClick={(click) => {
                      click.stopPropagation();
                      onOpenDay(day);
                    }}
                  >
                    {hidden} more
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
