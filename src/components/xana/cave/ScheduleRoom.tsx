"use client";

/**
 * The calendar: the schedule as a month, a week or a day.
 *
 * WHY THIS REPLACED A TWO-DAY LIST
 *
 * The room used to show today and tomorrow as rows, because those are the two
 * days the briefing asks about — a month view "would be a calendar", said the
 * note in `DESIGN.md`, "and this is not trying to be one". That was true when
 * the only way in was a form. It is not true of a person who has a term, a
 * rota or a week of lectures: a schedule you cannot see the shape of is a
 * schedule you re-type, and the two days on screen were the briefing's window,
 * not the user's.
 *
 * So this is a real calendar, and the form did not go away — it became the thing
 * that opens when you press a slot, which is where the intention actually is.
 *
 * THE FOUR GESTURES
 *
 *   drag a block         -> move it, across days and across hours
 *   drag its edge        -> change when it starts or ends
 *   drag empty grid      -> draw a new entry and type its name
 *   drag a month chip    -> another day, same hour
 *
 * Every one of them is optimistic: the thing moves on the frame the pointer is
 * released and the server is asked afterwards, so the round trip is never
 * something the hand can feel. What the server answers is the authority, and a
 * refusal puts the window back rather than leaving a lie on screen.
 *
 * WHAT IS NOT DRAGGABLE
 *
 * An entry from a feed. `source` other than `user` means somebody else's record:
 * moving it here would look permanent and be undone by the next sync, which is a
 * worse lie than having no gesture at all. It opens, it is readable, and the
 * popover says where it came from.
 *
 * THE CLOCK
 *
 * Every day, hour and "today" on this screen comes from `@/lib/core/zone`. The
 * grid asks the server for a window of *days* and never resolves a midnight
 * itself, which is the whole reason `event.range` answers in days.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CalendarEvent } from "@/lib/core/types";
import type { CaveController } from "./useCave";
import {
  addDays,
  CALENDAR_VIEWS,
  daysForView,
  DEFAULT_MINUTES,
  durationOf,
  formatClock,
  hourHeightFor,
  optimisticCreate,
  optimisticMove,
  optimisticResize,
  periodLabel,
  shiftAnchor,
  windowFor,
  type CalendarView,
} from "@/lib/calendar/geometry";
import { dateKeyInZone, fromDateKeyInZone, hourInZone, minuteInZone, monthDayInZone } from "@/lib/core/zone";

import EventEditor from "./calendar/EventEditor";
import MonthGrid from "./calendar/MonthGrid";
import TimeGrid from "./calendar/TimeGrid";
import { useCalendarWindow, withRecord, withoutRecord } from "./calendar/useCalendarWindow";
import { useMonthDrag } from "./calendar/useMonthDrag";
import { useSwipePage } from "./calendar/useSwipePage";
import { useTimeGridDrag } from "./calendar/useTimeGridDrag";
import type {
  AnchorBox,
  CalendarActions,
  EventDraft,
  EventDraftFields,
} from "./calendar/contract";
import { emptyNote } from "./empty-note";

export interface ScheduleRoomProps {
  controller: CaveController;
}

/** A draft, plus where on screen the editor should sit. */
interface OpenDraft {
  draft: EventDraft;
  at: AnchorBox;
}

export default function ScheduleRoom({ controller }: ScheduleRoomProps) {
  const [view, setView] = useState<CalendarView>("week");
  const [anchor, setAnchor] = useState(() => dateKeyInZone(new Date()));
  const [today, setToday] = useState(() => dateKeyInZone(new Date()));
  const [compact, setCompact] = useState(false);
  const [open, setOpen] = useState<OpenDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [title, setTitle] = useState("");
  /** Where the quick-add line puts what it writes. */
  const [slot, setSlot] = useState<{ dayKey: string; startMin: number }>(() => ({
    dayKey: dateKeyInZone(new Date()),
    startMin: Math.min(23 * 60, Math.ceil((hourInZone(new Date()) * 60 + minuteInZone(new Date())) / 60) * 60),
  }));

  const viewRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /**
   * The element a swipe slides.
   *
   * A wrapper *inside* the room rather than the room itself: the room's own box
   * also holds the header, the quick-add line and the note, and sliding those
   * would move the controls the page turn is being asked for. This is the grid
   * and nothing else, which is also exactly what changes when the period does.
   */
  const stageRef = useRef<HTMLDivElement | null>(null);

  const data = useCalendarWindow(controller, view, anchor);
  const events = data.events;
  const days = useMemo(() => daysForView(view, anchor), [view, anchor]);
  const hourHeight = hourHeightFor(compact);

  /* ---------------- the clock, only as often as it can change ---------------- */

  useEffect(() => {
    const tick = () => setToday(dateKeyInZone(new Date()));
    const timer = setInterval(tick, 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  /**
   * Which pointer is doing the pointing, which is not the same question as how
   * wide the window is: a touchscreen laptop is a fine pointer at 1440px, and a
   * tablet in landscape is a coarse one at 1024px. The drag handles need this
   * and nothing else does — see `gripHeightFor`.
   */
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarse(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  /**
   * Paging moves the quick-add line's target with the view.
   *
   * The line says which day it will write to, and a calendar where "next month"
   * then "Add" wrote into the month you had just left would be one where the
   * sentence beside the field was the only warning. A slot the user picked by
   * pressing a cell is left alone: this only fires when the view itself moves.
   */
  useEffect(() => {
    setSlot((current) => (current.dayKey === anchor ? current : { ...current, dayKey: anchor }));
  }, [anchor]);

  /* ---------------- the actions the grids are handed ---------------- */

  /** A feed's record is shown, never changed here. */
  const canEdit = useCallback((event: CalendarEvent) => event.source === "user", []);

  /**
   * The record that just landed, for one beat.
   *
   * A drop is a movement the user made, so it is allowed to be visible as one:
   * the block fades up from just short of full opacity where it arrived, which
   * is the difference between "that landed" and "that blinked". It is cleared on
   * a timer rather than left set, so the next unrelated render cannot replay it.
   */
  const [landed, setLanded] = useState<string | null>(null);
  const settle = useCallback((id: string) => {
    setLanded(id);
    window.setTimeout(() => setLanded((current) => (current === id ? null : current)), 400);
  }, []);

  /**
   * Write a change, then ask.
   *
   * The optimistic record goes in first so the grid never waits; the answer
   * replaces it when it lands, so what is on screen is eventually the server's
   * own record rather than the guess. A refusal re-reads the window instead of
   * trying to unpick the guess: the server's answer is the only thing that
   * knows what the row actually looks like now.
   */
  const commit = useCallback(
    async (
      op: "event.update" | "event.create" | "event.delete",
      input: Record<string, unknown>,
      optimistic: (list: CalendarEvent[]) => CalendarEvent[],
      pendingKey: string,
    ): Promise<{ ok: boolean; error: string }> => {
      data.setEvents(optimistic);
      const { ok, payload, error } = await controller.runDetailed(op, input, pendingKey);
      if (!ok) {
        data.refresh();
        return { ok, error };
      }
      const answer = payload.event as CalendarEvent | undefined;
      if (answer) data.setEvents((list) => withRecord(list, answer));
      return { ok, error: "" };
    },
    [controller, data],
  );

  const move = useCallback(
    (event: CalendarEvent, dayKey: string, startMin: number) => {
      const allDay = event.allDay === true;
      settle(event.id);
      void commit(
        "event.update",
        allDay
          ? { id: event.id, date: dayKey }
          : { id: event.id, date: dayKey, time: formatClock(startMin), minutes: durationOf(event) },
        (list) => withRecord(list, optimisticMove(event, dayKey, startMin)),
        event.id,
      );
    },
    [commit, settle],
  );

  const resize = useCallback(
    (event: CalendarEvent, dayKey: string, startMin: number, minutes: number) => {
      settle(event.id);
      void commit(
        "event.update",
        { id: event.id, date: dayKey, time: formatClock(startMin), minutes },
        (list) => withRecord(list, optimisticResize(event, dayKey, startMin, minutes)),
        event.id,
      );
    },
    [commit, settle],
  );

  const beginCreate = useCallback(
    (dayKey: string, startMin: number, minutes: number, at: AnchorBox) => {
      setSlot({ dayKey, startMin });
      setEditorError("");
      setOpen({
        draft: { title: "", dayKey, startMin, minutes, location: "", allDay: false },
        at,
      });
    },
    [],
  );

  const openEvent = useCallback((event: CalendarEvent, at: AnchorBox) => {
    setEditorError("");
    setOpen({
      draft: {
        id: event.id,
        title: event.title,
        dayKey: dateKeyInZone(new Date(event.start)),
        startMin: hourInZone(new Date(event.start)) * 60 + minuteInZone(new Date(event.start)),
        minutes: durationOf(event),
        location: event.location ?? "",
        allDay: event.allDay === true,
        source: event.source,
      },
      at,
    });
  }, []);

  const openDay = useCallback((dayKey: string) => {
    setAnchor(dayKey);
    setView("day");
  }, []);

  const actions: CalendarActions = useMemo(
    () => ({ move, resize, nudge: resize, beginCreate, open: openEvent, openDay }),
    [move, resize, beginCreate, openEvent, openDay],
  );

  /* ---------------- the two drag engines ---------------- */

  const monthDrag = useMonthDrag({
    rootRef: viewRef,
    canEdit,
    /* A month drag asks only for another day, so the entry keeps its own hour:
       the minutes handed on are the ones it already starts at. */
    onMove: (event, dayKey) => move(event, dayKey, startOfDayMinutes(event)),
  });

  const createFromDrag = useCallback(
    (dayKey: string, startMin: number, minutes: number) => {
      // Where a drawn slot lands on screen: the slot's own box, so the editor
      // opens next to the thing that was just drawn rather than in a corner.
      beginCreate(dayKey, startMin, minutes, slotBox(scrollRef.current, dayKey, startMin, minutes));
    },
    [beginCreate],
  );

  const gridDrag = useTimeGridDrag({
    scrollRef,
    columns: days,
    hourHeight,
    canEdit,
    onMove: move,
    onResize: resize,
    onCreate: createFromDrag,
  });

  /**
   * Turning the page with a finger.
   *
   * The direction is the content's, not the finger's: `pageStep` returns `1` for
   * "the next period arrives", which is a finger moving left. Both go through
   * `shiftAnchor`, which is the same function the header's chevrons call — a page
   * turn and a chevron must never be able to disagree about what "next week" is,
   * and the only way to guarantee that is for there to be one implementation of
   * it.
   */
  const swipe = useSwipePage({
    surfaceRef: viewRef,
    slideRef: stageRef,
    onPage: useCallback(
      (step: -1 | 1) => setAnchor((current) => shiftAnchor(view, current, step)),
      [view],
    ),
    // A form on screen owns the gesture, and a page turn under a drag would move
    // the grid the user is dropping into.
    enabled: open === null,
  });

  /* ---------------- the editor's two endings ---------------- */

  const save = useCallback(
    async (fields: EventDraftFields) => {
      const draft = open?.draft;
      if (!draft) return;
      setSaving(true);
      setEditorError("");

      let result: { ok: boolean; error: string };

      if (draft.id) {
        const existing = events.find((candidate) => candidate.id === draft.id);
        const input: Record<string, unknown> = {
          id: draft.id,
          title: fields.title,
          date: fields.dayKey,
          location: fields.location,
          allDay: fields.allDay,
        };
        if (!fields.allDay) {
          input.time = formatClock(fields.startMin);
          input.minutes = fields.minutes;
        }
        const optimistic = existing
          ? fields.allDay
            ? optimisticAllDay(existing, fields.dayKey)
            : optimisticResize(existing, fields.dayKey, fields.startMin, fields.minutes)
          : null;
        result = await commit(
          "event.update",
          input,
          (list) =>
            optimistic
              ? withRecord(list, { ...optimistic, title: fields.title, location: fields.location || undefined })
              : list,
          draft.id,
        );
      } else {
        const temporary = optimisticCreate(
          `draft-${Date.now().toString(36)}`,
          fields.title,
          fields.dayKey,
          fields.startMin,
          fields.minutes,
          fields.location || undefined,
        );
        const input: Record<string, unknown> = {
          title: fields.title,
          date: fields.dayKey,
          allDay: fields.allDay,
          location: fields.location,
        };
        if (!fields.allDay) {
          input.time = formatClock(fields.startMin);
          input.minutes = fields.minutes;
        }
        // The guess goes in, and is taken straight back out when the server's
        // own record arrives under a different id.
        data.setEvents((list) => withRecord(list, temporary));
        const answer = await controller.runDetailed("event.create", input, "event.create");
        data.setEvents((list) => withoutRecord(list, temporary.id));
        if (answer.ok && answer.payload.event) {
          data.setEvents((list) => withRecord(list, answer.payload.event as CalendarEvent));
        } else if (!answer.ok) {
          data.refresh();
        }
        result = { ok: answer.ok, error: answer.error };
        setSlot({ dayKey: fields.dayKey, startMin: fields.startMin });
      }

      setSaving(false);
      if (result.ok) setOpen(null);
      else setEditorError(result.error || "That change did not save.");
    },
    [commit, controller, data, events, open],
  );

  const remove = useCallback(async () => {
    const draft = open?.draft;
    if (!draft?.id) return;
    setSaving(true);
    const id = draft.id;
    const result = await commit("event.delete", { id }, (list) => withoutRecord(list, id), id);
    setSaving(false);
    if (result.ok) setOpen(null);
    else setEditorError(result.error || "That did not remove.");
  }, [commit, open]);

  /* ---------------- the quick-add line ---------------- */

  const quickAdd = useCallback(async () => {
    const text = title.trim();
    if (!text) return;
    setTitle("");
    const fields: EventDraftFields = {
      title: text,
      dayKey: slot.dayKey,
      startMin: slot.startMin,
      minutes: DEFAULT_MINUTES,
      location: "",
      allDay: false,
    };
    const temporary = optimisticCreate(
      `draft-${Date.now().toString(36)}`,
      fields.title,
      fields.dayKey,
      fields.startMin,
      fields.minutes,
    );
    data.setEvents((list) => withRecord(list, temporary));
    const { ok, payload } = await controller.runDetailed(
      "event.create",
      { title: fields.title, date: fields.dayKey, time: formatClock(fields.startMin), minutes: fields.minutes },
      "event.create",
    );
    data.setEvents((list) => withoutRecord(list, temporary.id));
    if (ok && payload.event) data.setEvents((list) => withRecord(list, payload.event as CalendarEvent));
    else if (!ok) data.refresh();
  }, [controller, data, slot, title]);

  /* ---------------- what the header says ---------------- */

  const period = periodLabel(view, anchor, days);
  const range = useMemo(() => windowFor(view, anchor), [view, anchor]);
  const busy = controller.loading || data.loading;
  const nothing = !busy && events.length === 0;

  return (
    <div
      /* Two height modes, because the two grids want opposite things.
         A time grid needs a *bounded* box so its own hours can scroll inside it,
         which is `h-full`. A month grid needs to be as tall as six readable
         weeks and no shorter, so it takes `min-h-full`: it fills a tall window
         and makes the room scroll in a short one. Forcing either shape on the
         other is how the month view ended up with its last week cut off. */
      className={`flex flex-col ${view === "month" ? "min-h-full" : "h-full min-h-[520px]"}`}
      data-calendar
      data-view={view}
      data-anchor={anchor}
      data-window={`${range.from}..${range.to}`}
    >
      {/* ---------------- periods and views ---------------- */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-hairline px-4 py-2.5 sm:px-6">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="icon-tap grid place-items-center rounded-full text-dim transition-colors duration-[var(--t-fast)] hover:bg-surface-2 hover:text-text"
            aria-label={view === "month" ? "Previous month" : view === "week" ? "Previous week" : "Previous day"}
            onClick={() => setAnchor((current) => shiftAnchor(view, current, -1))}
          >
            <Chevron direction="left" />
          </button>
          <button
            type="button"
            className="icon-tap grid place-items-center rounded-full text-dim transition-colors duration-[var(--t-fast)] hover:bg-surface-2 hover:text-text"
            aria-label={view === "month" ? "Next month" : view === "week" ? "Next week" : "Next day"}
            onClick={() => setAnchor((current) => shiftAnchor(view, current, 1))}
          >
            <Chevron direction="right" />
          </button>
          <button
            type="button"
            className="chip"
            aria-pressed={anchor === today}
            onClick={() => setAnchor(today)}
          >
            today
          </button>
          <h3 className="ml-1.5 text-[15px] font-normal tracking-[0.01em] text-text" data-period>
            {period}
          </h3>
        </div>

        <div className="flex items-center gap-1" role="group" aria-label="Calendar view">
          {CALENDAR_VIEWS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="chip"
              aria-pressed={view === entry.id}
              onClick={() => setView(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </header>

      {/* ---------------- the quick-add line ---------------- */}
      <form
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-hairline px-4 py-2 sm:px-6"
        onSubmit={(event) => {
          event.preventDefault();
          void quickAdd();
        }}
      >
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What's going on? Press Enter to put it in"
          aria-label="Add to the calendar"
          className="field tap max-w-[520px] flex-1"
          data-quick-add
        />
        <span className="timestamp" data-quick-slot>
          {slotLabel(slot.dayKey, today)} · {formatClock(slot.startMin)}
        </span>
        <button type="submit" disabled={!title.trim()} className="btn btn-primary">
          Add
        </button>
      </form>

      {/* ---------------- the grid ---------------- */}
      {/* The swipe surface is the whole room, so a finger that lands on the
          header or the quick-add line can turn the page too — that is what a
          person expects of a sheet they are pushing sideways, and the alternative
          (only the grid responds) makes the gesture work in some places and not
          others for no reason anyone can see. A control that wants the press for
          itself stops it before it gets here, which the chevrons, the chips and
          the quick-add field all already do. */}
      <div
        ref={viewRef}
        className="min-h-0 flex-1 px-2 py-3 sm:px-6"
        onPointerDown={swipe.onPointerDown}
      >
        <div ref={stageRef} className="cal-stage flex h-full flex-col">
          {view === "month" ? (
            <MonthGrid
              days={days}
              anchor={anchor}
              today={today}
              events={events}
              actions={actions}
              drag={monthDrag}
              canEdit={canEdit}
              onOpenDay={openDay}
              landed={landed}
            />
          ) : (
            <TimeGrid
              days={days}
              today={today}
              events={events}
              hourHeight={hourHeight}
              scrollRef={scrollRef}
              drag={gridDrag}
              allDayDrag={monthDrag}
              actions={actions}
              canEdit={canEdit}
              landed={landed}
              coarse={coarse}
            />
          )}
        </div>
      </div>

      {/* ---------------- what the room says about itself ---------------- */}
      <p className="shrink-0 px-4 pb-3 text-[12px] leading-relaxed font-normal text-faint sm:px-6">
        {nothing || busy
          ? emptyNote(busy, "Nothing in these days. Press any slot to add one.")
          : "Drag a block to move it, its edge to change how long it lasts, or empty space to draw a new one. Everything here is stored locally in data/xana.db."}
      </p>

      {/* The board, and on a phone the wash behind it. Below the compact
          breakpoint the form docks to the bottom edge as a sheet, and a sheet
          without a scrim is a panel that has landed on top of the page rather
          than one that was opened over it. The scrim is a button with a name,
          which is how the settings sheet spells the same thing — a press
          anywhere outside then has somewhere honest to land. */}
      {open && compact ? (
        <button
          type="button"
          aria-label="Close the event form"
          onClick={() => setOpen(null)}
          className="scrim-in fixed inset-0 z-[59] cursor-default bg-scrim"
          data-editor-scrim
        />
      ) : null}

      {open ? (
        <EventEditor
          draft={open.draft}
          anchor={open.at}
          docked={compact}
          busy={saving}
          error={editorError}
          onSave={(fields) => void save(fields)}
          onRemove={() => void remove()}
          onClose={() => setOpen(null)}
        />
      ) : null}

      <Ghost
        preview={gridDrag.preview?.ghost ? gridDrag.preview : null}
        ghostRef={gridDrag.ghostRef}
        labelRef={gridDrag.labelRef}
      />
      <Ghost preview={monthDrag.preview} ghostRef={monthDrag.ghostRef} labelRef={monthDrag.labelRef} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Small pieces                                                       */
/* ------------------------------------------------------------------ */

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path
        d={direction === "left" ? "M7.5 1.5L3 6l4.5 4.5" : "M4.5 1.5L9 6l-4.5 4.5"}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The floating copy of whatever is being dragged. */
function Ghost({
  preview,
  ghostRef,
  labelRef,
}: {
  preview: { title: string; left: number; top: number; width: number; height: number; label: string } | null;
  ghostRef: React.RefObject<HTMLDivElement | null>;
  labelRef: React.RefObject<HTMLSpanElement | null>;
}) {
  if (!preview) return null;
  return (
    <div
      ref={ghostRef}
      className="cal-ghost"
      style={{ left: preview.left, top: preview.top, width: preview.width, height: preview.height }}
      aria-hidden="true"
      data-drag-ghost
    >
      <div className="cal-ghost-inner">
        <span className="block truncate">{preview.title}</span>
      </div>
      <span ref={labelRef} className="cal-ghost-label">
        {preview.label}
      </span>
    </div>
  );
}

/**
 * The minutes into the dragged day that an all-day entry starts at: none.
 */
function startOfDayMinutes(event: CalendarEvent): number {
  if (event.allDay === true) return 0;
  const start = new Date(event.start);
  return hourInZone(start) * 60 + minuteInZone(start);
}

/**
 * Where the quick-add line will write, said the way a person says it.
 *
 * "today", "tomorrow", or the date — never the raw `2026-09-28` key it was given
 * when the slot followed a drag into another week. The label is the only thing
 * telling the user which day the line is about to write into, so it has to be
 * readable rather than precise.
 */
function slotLabel(dayKey: string, today: string): string {
  if (dayKey === today) return "today";
  if (dayKey === addDays(today, 1)) return "tomorrow";
  return monthDayInZone(fromDateKeyInZone(dayKey)) || dayKey;
}

/** The record an all-day toggle produces, for the optimistic write. */
function optimisticAllDay(event: CalendarEvent, dayKey: string): CalendarEvent {
  return optimisticMove({ ...event, allDay: true }, dayKey, 0);
}

/**
 * The box a just-drawn slot occupies, so the editor can open beside it.
 *
 * Read from the column rather than from the drag, because the drag is over by
 * the time this is called and the pointer has already been lifted.
 */
function slotBox(grid: HTMLElement | null, dayKey: string, startMin: number, minutes: number): AnchorBox {
  const column = grid?.querySelector<HTMLElement>(`[data-column="${dayKey}"]`);
  if (!column) return { left: window.innerWidth / 2 - 120, top: 120, width: 240, height: 0 };
  const box = column.getBoundingClientRect();
  const hour = Number.parseFloat(
    getComputedStyle(grid as HTMLElement).getPropertyValue("--cal-hour") || "56",
  );
  const px = Number.isFinite(hour) && hour > 0 ? hour : 56;
  const top = box.top + (startMin / 60) * px;
  return { left: box.left, top, width: box.width, height: (minutes / 60) * px };
}
