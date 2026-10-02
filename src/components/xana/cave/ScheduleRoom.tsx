"use client";

import { useMemo, useState } from "react";

import type { CalendarEvent } from "@/lib/cave/types";

import { emptyNote } from "./empty-note";
import type { CaveController } from "./useCave";

/**
 * The schedule, and the form that fills it.
 *
 * WHY THIS SCREEN EXISTS
 *
 * "Next", "Focus" and "Open" in the briefing are all questions about the
 * schedule, and until now the only ways in were a published ICS feed or
 * telling her in the chat. Neither covers the ordinary case: a class that
 * repeats every week, a lecture moved to Thursday, a study block someone
 * wants to hold themselves to. Without a way to write the schedule, the
 * briefing can only ever report what an adapter happened to publish.
 *
 * This room shows today and tomorrow rather than a month, because those are
 * the only two days the briefing asks about — a month view would be a
 * calendar, and this is not trying to be one.
 */

/** The local `YYYY-MM-DD` for an instant, which is what a date input wants. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** "09:30" for an instant. */
function timeKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function humanTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function durationMinutes(event: CalendarEvent): number {
  return Math.max(
    0,
    Math.round((new Date(event.end).getTime() - new Date(event.start).getTime()) / 60_000),
  );
}

/** "Today" / "Tomorrow" / a weekday, for grouping. */
function dayHeading(key: string): string {
  const today = dayKey(new Date().toISOString());
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (key === today) return "Today";
  if (key === dayKey(tomorrow.toISOString())) return "Tomorrow";
  return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

export interface ScheduleRoomProps {
  controller: CaveController;
}

export default function ScheduleRoom({ controller }: ScheduleRoomProps) {
  const today = dayKey(new Date().toISOString());
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(today);
  const [time, setTime] = useState("09:00");
  const [minutes, setMinutes] = useState("60");
  const [location, setLocation] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);

  /** Grouped by day, in order, so the list reads like a schedule. */
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of controller.events) {
      const key = dayKey(event.start);
      const list = map.get(key) ?? [];
      list.push(event);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.start.localeCompare(b.start));
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [controller.events]);

  const add = () => {
    const text = title.trim();
    if (!text || !date) return;
    void controller.run("event.create", {
      title: text,
      date,
      time,
      minutes: Number(minutes) || 60,
      location: location.trim() || null,
    });
    // The title and place clear; the date and time stay, because adding one
    // thing to a morning usually means adding the next one to the same morning.
    setTitle("");
    setLocation("");
  };

  return (
    <div>
      {/* ---------------- add one ---------------- */}
      <div className="border-b border-hairline px-6 py-5">
        <h3 className="text-[15px] font-normal text-text">Add to the schedule</h3>
        <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed font-light text-dim">
          This is what “Next”, “Focus” and “Open” read from. A class, a lecture, a
          block you want to hold yourself to — anything with a time on it.
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
          className="mt-4 flex flex-wrap items-end gap-3"
        >
          <label className="min-w-[200px] flex-1">
            <span className="label">what</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Algorithms lecture"
              aria-label="Event title"
              className="field mt-1.5"
            />
          </label>

          <label>
            <span className="label">date</span>
            <input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              aria-label="Date"
              className="field mt-1.5 w-[160px]"
            />
          </label>

          <label>
            <span className="label">time</span>
            <input
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              aria-label="Start time"
              className="field mt-1.5 w-[130px]"
            />
          </label>

          <label>
            <span className="label">minutes</span>
            <input
              type="number"
              min={5}
              max={720}
              step={5}
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
              aria-label="Duration in minutes"
              className="field mt-1.5 w-[110px]"
            />
          </label>

          <label>
            <span className="label">where</span>
            <input
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="optional"
              aria-label="Location"
              className="field mt-1.5 w-[150px]"
            />
          </label>

          <button type="submit" disabled={!title.trim() || !date} className="btn btn-primary">
            Add
          </button>
        </form>
      </div>

      {/* ---------------- the schedule ---------------- */}
      <div>
        {byDay.map(([key, events]) => (
          <section key={key}>
            <div className="flex items-baseline justify-between border-b border-hairline bg-surface/40 px-6 py-2">
              <h4 className="label">{dayHeading(key)}</h4>
              <span className="timestamp">
                {events.length} {events.length === 1 ? "thing" : "things"}
              </span>
            </div>
            <ul className="divide-y divide-hairline">
              {events.map((event) => (
                <li key={event.id} className="flex items-start gap-3 px-6 py-3">
                  <span className="mt-[3px] w-[72px] shrink-0 text-[13px] font-light tabular-nums text-dim">
                    {event.allDay ? "all day" : humanTime(event.start)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] leading-snug font-light text-text">{event.title}</p>
                    <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      {!event.allDay ? (
                        <span className="timestamp">{durationMinutes(event)}m</span>
                      ) : null}
                      {event.location ? (
                        <span className="text-[13px] font-light text-dim">{event.location}</span>
                      ) : null}
                      {/* Where it came from matters: a hand-written entry can be
                          deleted here, a synced one will come back. */}
                      {event.source !== "user" ? (
                        <span className="timestamp">from {event.source}</span>
                      ) : null}
                    </div>
                  </div>

                  {event.source === "user" ? (
                    confirming === event.id ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            void controller.run("event.delete", { id: event.id }, event.id);
                            setConfirming(null);
                          }}
                          className="rounded-[var(--r-sm)] px-2 py-1 text-[12px] font-normal text-danger hover:bg-surface-2"
                        >
                          remove
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirming(null)}
                          className="rounded-[var(--r-sm)] px-2 py-1 text-[12px] font-normal text-dim hover:bg-surface-2"
                        >
                          keep
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirming(event.id)}
                        aria-label={`Remove ${event.title}`}
                        className="shrink-0 rounded-[var(--r-sm)] px-2 py-1 text-[12px] font-normal text-faint hover:bg-surface-2 hover:text-danger"
                      >
                        remove
                      </button>
                    )
                  ) : (
                    // No remove control for a synced entry: deleting it here
                    // would look permanent and then reappear on the next sync.
                    <span className="shrink-0 timestamp">synced</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}

        {byDay.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-[13px] font-light text-dim">
              {emptyNote(
                controller.loading,
                "Nothing scheduled today or tomorrow. Add something above, or tell her — “book a study block at 7”.",
              )}
            </p>
          </div>
        ) : null}
      </div>

      <div className="px-6 py-3">
        <p className="timestamp">
          Today and tomorrow · connect a calendar in Settings for the rest
        </p>
      </div>
    </div>
  );
}
