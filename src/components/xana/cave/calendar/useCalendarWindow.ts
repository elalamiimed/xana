"use client";

/**
 * The calendar's data: one window of the schedule, kept honest.
 *
 * WHY THE CALENDAR DOES NOT READ `controller.events`
 *
 * The cave's snapshot carries today and tomorrow, deliberately: it is what the
 * briefing reads, and it is fetched every time the cave opens whether or not
 * anyone looks at the schedule. A month grid over that array would show two days
 * of six weeks. So the calendar asks for its own window, by day, from the one
 * operation that answers in days (`event.range`), and the rest of the cave is
 * untouched.
 *
 * WHY THERE IS A CACHE
 *
 * Paging is the thing a calendar is used for. Without a cache, every press of
 * "next month" is a round trip in which the grid is empty, and the month that
 * comes back paints all at once — which is exactly the flicker that makes a
 * calendar feel like a form rather than a calendar. Windows are therefore kept,
 * served immediately when they are asked for again, and revalidated in the
 * background; the two neighbouring windows are fetched while the current one is
 * being read, so the common direction of travel is already paid for.
 *
 * WHY EVERY READ IS STAMPED
 *
 * An optimistic drop writes the record it expects, then the server's answer
 * replaces it. A window read started before the drop can land after it, and
 * would then paint the old time back for a frame — the block visibly jumping
 * home and out again. Every local write bumps a version, every read remembers
 * the version it started at, and a read whose version is stale is dropped.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CalendarEvent } from "@/lib/core/types";
import type { CalendarRange } from "@/lib/cave/types";
import { shiftAnchor, windowFor, type CalendarView } from "@/lib/calendar/geometry";

import type { CaveController } from "../useCave";

/** How long the room must sit still before the neighbouring windows are read. */
const PREFETCH_DELAY = 320;

export interface CalendarData {
  /** The records of the window asked for, plus anything optimistically written. */
  events: CalendarEvent[];
  /** True only when there is nothing to draw yet for this window. */
  loading: boolean;
  /** The window's own days, from the server's answer. */
  range: CalendarRange | null;
  setEvents: React.Dispatch<React.SetStateAction<CalendarEvent[]>>;
  /**
   * Throw the window away and read it again.
   *
   * The rollback path. A refused drop has left a guess on screen, and the
   * honest way to remove it is to ask what is actually stored rather than to
   * invert the guess — an inverse computed from a record the server never
   * accepted is a second chance to be wrong.
   */
  refresh: () => void;
}

/** One silent read of a window, used for prefetching and for revalidation. */
async function readRange(from: string, to: string): Promise<CalendarRange | null> {
  try {
    const response = await fetch("/api/cave", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "event.range", from, to }),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { range?: CalendarRange };
    return payload.range ?? null;
  } catch {
    return null;
  }
}

export function useCalendarWindow(
  controller: CaveController,
  view: CalendarView,
  anchor: string,
): CalendarData {
  const window = useMemo(() => windowFor(view, anchor), [view, anchor]);
  const key = `${window.from}|${window.to}`;

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [range, setRange] = useState<CalendarRange | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const cache = useRef(new Map<string, CalendarEvent[]>());
  /** Bumped by every local write, so a stale read can tell that it is stale. */
  const writes = useRef(0);
  const { runDetailed } = controller;

  const write = useCallback<React.Dispatch<React.SetStateAction<CalendarEvent[]>>>((next) => {
    writes.current += 1;
    setEvents(next);
  }, []);

  const refresh = useCallback(() => {
    cache.current.delete(key);
    setNonce((value) => value + 1);
  }, [key]);

  useEffect(() => {
    let live = true;
    const cached = cache.current.get(key);
    const stamp = writes.current;

    if (cached) {
      setEvents(cached);
      setLoading(false);
    } else {
      setLoading(true);
    }

    void (async () => {
      const answer = await readRange(window.from, window.to);
      if (!live || !answer) {
        if (live && !cached) setLoading(false);
        return;
      }
      cache.current.set(key, answer.events);
      setRange(answer);
      setLoading(false);
      // A read that started before a drop is not allowed to undo it.
      if (writes.current === stamp) setEvents(answer.events);
    })();

    return () => {
      live = false;
    };
  }, [key, nonce, window.from, window.to, runDetailed]);

  /**
   * Read the windows either side while the room is quiet.
   *
   * The delay is the point: paging quickly should not queue four reads behind
   * the one being looked at, and a prefetch that fails is not worth a word on
   * screen, which is why it goes through `readRange` rather than the
   * controller's own `run` — that one reports failures, and a failure to warm a
   * cache is not a failure the user can act on.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      for (const step of [-1, 1]) {
        const neighbour = windowFor(view, shiftAnchor(view, anchor, step));
        const neighbourKey = `${neighbour.from}|${neighbour.to}`;
        if (cache.current.has(neighbourKey)) continue;
        void readRange(neighbour.from, neighbour.to).then((answer) => {
          // Only kept when it is still a neighbour: a page turn while this was
          // in flight must not put a stale window into the cache on top of the
          // one that is now being shown.
          if (answer && !cache.current.has(neighbourKey)) cache.current.set(neighbourKey, answer.events);
        });
      }
    }, PREFETCH_DELAY);
    return () => clearTimeout(timer);
  }, [anchor, key, view]);

  return { events, loading, range, setEvents: write, refresh };
}

/**
 * Write one record into the list, replacing it where it already sits.
 *
 * Position in the array is not order — the grid sorts by time on every render —
 * but keeping the record in place stops React remounting the block, which would
 * restart its arrival transition for a change the user made to an element that
 * was already on screen.
 */
export function withRecord(events: readonly CalendarEvent[], record: CalendarEvent): CalendarEvent[] {
  const index = events.findIndex((candidate) => candidate.id === record.id);
  if (index === -1) return [...events, record];
  const next = events.slice();
  next[index] = record;
  return next;
}

/** The list without one record. */
export function withoutRecord(events: readonly CalendarEvent[], id: string): CalendarEvent[] {
  return events.filter((candidate) => candidate.id !== id);
}
