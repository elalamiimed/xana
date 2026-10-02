"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { CalendarEvent } from "@/lib/cave/types";
import {
  addDaysInZone,
  clockInZone,
  dateKeyInZone,
  fromDateKeyInZone,
  hourMinuteInZone,
  weekdayMonthDayInZone,
} from "@/lib/core/zone";

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
 *
 * WHY A HAND-WRITTEN ENTRY CAN NOW BE EDITED
 *
 * Add and remove were the only two things here, so a lecture that moved to
 * Thursday had to be deleted and retyped: a new id, and a gap in the day it
 * moved out of. The row edits in place for the same reason the tasks room does,
 * and only rows marked `source: "user"` get the control. A synced entry is
 * somebody else's record: editing it here would look permanent and then be
 * overwritten by the next sync, which is a worse lie than having no control.
 *
 * The day and the clock in the editor are the app's readings of the instants
 * (see `@/lib/core/zone`), so the field shows the hour the room printed beside
 * it rather than the hour in whatever zone the browser is set to.
 */

/** The app's `YYYY-MM-DD` for an instant, which is what a date input wants. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return dateKeyInZone(d);
}

/** "09:30" for an instant, the 24 hour form a time input wants. */
function timeKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return hourMinuteInZone(d);
}

function humanTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return clockInZone(d);
}

function durationMinutes(event: CalendarEvent): number {
  return Math.max(
    0,
    Math.round((new Date(event.end).getTime() - new Date(event.start).getTime()) / 60_000),
  );
}

/**
 * "Today" / "Tomorrow" / a weekday, for grouping.
 *
 * Today and tomorrow are the app's days, not the browser's: a machine set to
 * another zone must not put tonight's lecture under the wrong heading.
 */
function dayHeading(key: string): string {
  const today = dateKeyInZone(new Date());
  if (key === today) return "Today";
  if (key === dateKeyInZone(addDaysInZone(new Date(), 1))) return "Tomorrow";
  const instant = fromDateKeyInZone(key);
  // A key that is not a date is shown as it came rather than as "Invalid Date".
  if (Number.isNaN(instant.getTime())) return key;
  return weekdayMonthDayInZone(instant);
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
  /** The event currently being edited in place, by id. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    title: "",
    date: "",
    time: "09:00",
    minutes: "60",
    location: "",
  });
  const [editError, setEditError] = useState("");
  /** The first field of the open editor, so opening it lands the caret there. */
  const editTitleRef = useRef<HTMLInputElement | null>(null);
  /** Every row's edit chip, so cancelling can hand focus back to the one that opened it. */
  const editChips = useRef(new Map<string, HTMLButtonElement | null>());
  /** The row whose chip should take focus once its editor closes. */
  const refocus = useRef<string | null>(null);

  useEffect(() => {
    if (editing) editTitleRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (editing !== null) return;
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    editChips.current.get(id)?.focus();
  }, [editing]);

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

  const openEditor = (event: CalendarEvent) => {
    setConfirming(null);
    setEditError("");
    setEditing(event.id);
    setDraft({
      title: event.title,
      date: dayKey(event.start),
      time: timeKey(event.start),
      minutes: String(durationMinutes(event) || 60),
      location: event.location ?? "",
    });
  };

  /** Close the editor and give the caret back to the chip that opened it. */
  const closeEditor = (id: string) => {
    refocus.current = id;
    setEditing(null);
    setEditError("");
  };

  /**
   * What actually changed, as a patch.
   *
   * The day, the clock and the length travel together and only when one of them
   * moved, because to the person editing they are one field: "move it to four"
   * changes when it starts and when it ends, and the operation takes the three
   * readings as a set. The title and the place are separate, so renaming an
   * event cannot shift its hour.
   *
   * Every typed value is checked here rather than left to the server, so a
   * half-typed field comes back as a sentence beside the editor instead of as a
   * silent reinterpretation of what was meant.
   */
  const changedFields = (event: CalendarEvent): Record<string, unknown> | string => {
    const patch: Record<string, unknown> = {};

    const nextTitle = draft.title.trim();
    if (nextTitle !== event.title) patch.title = nextTitle;

    const day = draft.date;
    const clock = draft.time;
    const length = Number(draft.minutes);
    // `|| 60` matches what the editor opened with, so an entry whose stored end
    // is not after its start (a corrupt row, not one this room can create) does
    // not read as "the length changed" and quietly rewrite its own times on a
    // rename. The editor shows 60 for that row, and 60 is what it compares to.
    const held = durationMinutes(event) || 60;
    if (day !== dayKey(event.start) || clock !== timeKey(event.start) || length !== held) {
      if (!day) return "An event needs a date.";
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "That is not a date I can read.";
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(clock)) return "That is not a time I can read.";
      if (!Number.isInteger(length) || length < 1 || length > 720) {
        return "A length is a whole number of minutes, 1 to 720.";
      }
      patch.date = day;
      patch.time = clock;
      patch.minutes = length;
    }

    const nextLocation = draft.location.trim();
    if (nextLocation !== (event.location ?? "")) patch.location = nextLocation;

    return patch;
  };

  const saveEdit = async (event: CalendarEvent) => {
    if (!draft.title.trim()) {
      setEditError("An event needs a title.");
      return;
    }

    const changed = changedFields(event);
    if (typeof changed === "string") {
      setEditError(changed);
      return;
    }
    setEditError("");

    // Nothing moved, so there is nothing to save and nothing to claim.
    if (Object.keys(changed).length === 0) {
      closeEditor(event.id);
      return;
    }

    const ok = await controller.run("event.update", { id: event.id, ...changed }, event.id);
    if (ok) closeEditor(event.id);
    else setEditError(controller.error ?? "That change did not save.");
  };

  return (
    <div className="mx-auto w-full max-w-[var(--content-max)]">
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
              {events.map((event) => {
                if (editing === event.id) {
                  return (
                    <li key={event.id} className="bg-surface-2/40 px-6 py-4">
                      {/* Escape cancels and Enter saves from any text field, the
                          same contract as the task editor one room over. */}
                      <form
                        onSubmit={(submitEvent) => {
                          submitEvent.preventDefault();
                          void saveEdit(event);
                        }}
                        onKeyDown={(keyEvent) => {
                          if (keyEvent.key !== "Escape") return;
                          keyEvent.preventDefault();
                          closeEditor(event.id);
                        }}
                        aria-label={`Edit ${event.title}`}
                        className="flex flex-wrap items-end gap-3"
                      >
                        <label className="min-w-[200px] flex-1">
                          <span className="label">what</span>
                          <input
                            ref={editTitleRef}
                            value={draft.title}
                            onChange={(changeEvent) =>
                              setDraft((d) => ({ ...d, title: changeEvent.target.value }))
                            }
                            aria-label="Event title"
                            className="field mt-1.5"
                          />
                        </label>

                        <label>
                          <span className="label">date</span>
                          <input
                            type="date"
                            value={draft.date}
                            onChange={(changeEvent) =>
                              setDraft((d) => ({ ...d, date: changeEvent.target.value }))
                            }
                            aria-label="Date"
                            className="field mt-1.5 w-[160px]"
                          />
                        </label>

                        <label>
                          <span className="label">time</span>
                          <input
                            type="time"
                            value={draft.time}
                            onChange={(changeEvent) =>
                              setDraft((d) => ({ ...d, time: changeEvent.target.value }))
                            }
                            aria-label="Start time"
                            className="field mt-1.5 w-[130px]"
                          />
                        </label>

                        <label>
                          <span className="label">minutes</span>
                          {/* Step 1 here while the add form uses 5. A number
                              input validates its own `step` against the value it
                              holds, and a mismatch blocks the entire form before
                              React sees the submit, so an event of 47 minutes
                              could not even be renamed until its length was
                              rounded in a field the user never opened. */}
                          <input
                            type="number"
                            min={1}
                            max={720}
                            step={1}
                            value={draft.minutes}
                            onChange={(changeEvent) =>
                              setDraft((d) => ({ ...d, minutes: changeEvent.target.value }))
                            }
                            aria-label="Duration in minutes"
                            className="field mt-1.5 w-[110px]"
                          />
                        </label>

                        <label>
                          <span className="label">where</span>
                          <input
                            value={draft.location}
                            onChange={(changeEvent) =>
                              setDraft((d) => ({ ...d, location: changeEvent.target.value }))
                            }
                            placeholder="optional"
                            aria-label="Location"
                            className="field mt-1.5 w-[150px]"
                          />
                        </label>

                        <div className="flex items-center gap-2">
                          <button
                            type="submit"
                            disabled={controller.pending.has(event.id)}
                            className="btn btn-primary"
                          >
                            Save
                          </button>
                          <button type="button" onClick={() => closeEditor(event.id)} className="btn">
                            Cancel
                          </button>
                        </div>

                        {editError ? (
                          <p aria-live="polite" className="w-full text-[12px] leading-relaxed text-danger">
                            {editError}
                          </p>
                        ) : null}
                      </form>
                    </li>
                  );
                }

                  return (
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
                              className="chip chip-danger"
                            >
                              remove
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirming(null)}
                              className="chip"
                            >
                              keep
                            </button>
                          </div>
                        ) : (
                          <div className="flex shrink-0 items-center gap-1">
                            {/* Edit sits before remove and is the quieter of the
                                two, because the destructive one should never be the
                                easier target to hit by accident. Its node is kept so
                                cancelling the editor can put the caret back on it. */}
                            <button
                              ref={(node) => {
                                editChips.current.set(event.id, node);
                              }}
                              type="button"
                              onClick={() => openEditor(event)}
                              aria-label={`Edit ${event.title}`}
                              className="chip"
                            >
                              edit
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirming(event.id)}
                              aria-label={`Remove ${event.title}`}
                              className="chip chip-danger"
                            >
                              remove
                            </button>
                          </div>
                        )
                      ) : (
                        // No remove control for a synced entry: deleting it here
                        // would look permanent and then reappear on the next sync.
                        <span className="shrink-0 timestamp">synced</span>
                      )}
                    </li>
                  );
              })}
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
