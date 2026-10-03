"use client";

/**
 * The one form in the calendar: what the thing is, when it is, and how to get
 * rid of it.
 *
 * WHY IT IS A POPOVER AND NOT A PANEL
 *
 * The room used to put its editor inline in the row it was editing, which was
 * right for a list: the fields appeared exactly where the thing was, and the
 * rest of the day stayed put. A grid has no rows — a block is somewhere in a
 * column, and its height is its duration — so the editor has to sit beside the
 * thing rather than inside it. It is anchored to the block it was opened from
 * and clamped into the window, and it carries everything the server will accept
 * for that record, so nothing needs a second screen.
 *
 * HOW IT IS PLACED, AND WHY IT MEASURES ITSELF
 *
 * The first version took the anchor and a *guess* at its own height — 360px,
 * written in the room — and clamped against the guess. At 390px wide the form is
 * 574px tall, so the bottom 206px of it, which is where `Add`, `remove` and
 * `Close` live, sat below the bottom of the screen. Measured in a browser: all
 * three controls reported `inView: false, hittable: false`, `Close` 145px past
 * the fold, and there was no other way out — tapping outside did nothing and a
 * phone has no Escape key. That is the reported "new event board that cannot be
 * removed", and the cause was a constant standing in for a measurement.
 *
 * So it measures. `max-height` keeps the card inside the viewport by
 * construction, a `ResizeObserver` notices when a field appears or disappears,
 * and the position is computed from the box that actually exists. There is no
 * height the room could be wrong about, because the room no longer has an
 * opinion: it hands over an anchor.
 *
 * ON A PHONE IT IS A SHEET, NOT A POPOVER
 *
 * A popover anchored to a 22px block is the wrong shape for a thumb even when it
 * fits — it lands wherever the slot happened to be, with its buttons near the
 * top of the screen. Below the room's own compact breakpoint the card docks to
 * the bottom edge, full width, with a scrim behind it: every control inside
 * thumb reach, and one obvious press to dismiss. The scrim is a real button with
 * a name rather than an invisible div, which is the pattern the settings sheet
 * already uses.
 *
 * WHY CREATE AND EDIT ARE THE SAME FORM
 *
 * Because they are the same question. "Study block, Thursday at four, an hour"
 * is what you are saying whether or not it already exists, and a calendar whose
 * new-entry form had different fields from its edit form would be a calendar
 * where the two disagreed about something within a week.
 *
 * A SYNCED ENTRY IS SHOWN, NEVER CHANGED
 *
 * `source` other than `user` means somebody else's record: editing it here would
 * look permanent and then be overwritten by the next sync. So the same form
 * opens with its fields disabled and one honest line where the buttons would be.
 *
 * EVERY ENDING IS A WAY OUT
 *
 * Escape, a press outside the card, the scrim, and `Close` all do the same
 * thing. The previous version had exactly one of them, and it was the one that
 * was off screen.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  clockLabel,
  dayTitle,
  formatClock,
  isDateKey,
  parseClock,
  SLOT_MINUTES,
} from "@/lib/calendar/geometry";

import type { AnchorBox, EventDraft, EventDraftFields } from "./contract";

export interface EventEditorProps {
  draft: EventDraft;
  /** The thing it was opened from, in viewport pixels. Ignored when docked. */
  anchor: AnchorBox;
  /** True below the room's compact breakpoint: dock to the bottom edge. */
  docked: boolean;
  /** True while the server is being asked. */
  busy: boolean;
  /** One line about the last refusal, in the app's voice. */
  error: string;
  onSave: (fields: EventDraftFields) => void;
  onRemove: () => void;
  onClose: () => void;
}

/** The gap between the card and the thing it describes, and the window edge. */
const GAP = 10;
const MARGIN = 8;

export default function EventEditor({
  draft,
  anchor,
  docked,
  busy,
  error,
  onSave,
  onRemove,
  onClose,
}: EventEditorProps) {
  const [fields, setFields] = useState<EventDraftFields>({
    title: draft.title,
    dayKey: draft.dayKey,
    startMin: draft.startMin,
    minutes: draft.minutes,
    location: draft.location,
    allDay: draft.allDay,
  });
  const [problem, setProblem] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  const readOnly = draft.source !== undefined && draft.source !== "user";
  const creating = draft.id === undefined;

  useEffect(() => {
    if (!readOnly) titleRef.current?.focus();
  }, [readOnly]);

  /**
   * Beside the thing, never off the screen.
   *
   * In a layout effect, so the corrected position is committed before the
   * browser paints: the card is never seen at a position it is about to leave.
   * The observer is what makes it self-correcting — toggling "all day" removes
   * two fields and the card gets shorter, and a position computed once would
   * leave it floating in the wrong place.
   */
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || docked) return;

    const fit = () => {
      const box = card.getBoundingClientRect();
      let left = anchor.left + anchor.width + GAP;
      if (left + box.width > window.innerWidth - MARGIN) left = anchor.left - box.width - GAP;
      left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, window.innerWidth - box.width - MARGIN));
      const top = Math.min(
        Math.max(anchor.top, MARGIN),
        Math.max(MARGIN, window.innerHeight - box.height - MARGIN),
      );
      setPlace((current) =>
        current && current.left === left && current.top === top ? current : { left, top },
      );
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(card);
    return () => observer.disconnect();
  }, [anchor, docked]);

  /**
   * A press anywhere else puts it away.
   *
   * The listener is in the capture phase so it runs before the calendar's own
   * press handlers: without that, pressing another slot would start a gesture on
   * a surface whose form is about to vanish. Deliberately not registered for a
   * press inside the card, where every gesture is the form's own.
   */
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const card = cardRef.current;
      if (!card || card.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [onClose]);

  /**
   * Escape belongs to this form while it is open.
   *
   * Registered on the document in the capture phase, which is deliberately the
   * same place and the same phase the cave uses for its own Escape. The first
   * version of this was a React `onKeyDown` on the card with a
   * `stopPropagation()` in it, and it did not work: the browser trace reads
   * `document capture -> card -> body -> document`, so the event reached a
   * document-level listener anyway and the room closed behind the form. A
   * React handler cannot stop a native listener on the node React dispatches
   * from; a capture listener on the document runs before every bubble listener
   * on it, so this one wins and the room never hears the Escape that closed
   * the form.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const set = <K extends keyof EventDraftFields>(key: K, value: EventDraftFields[K]) =>
    setFields((previous) => ({ ...previous, [key]: value }));

  const submit = () => {
    if (readOnly) return;
    const title = fields.title.trim();
    if (!title) {
      setProblem("An event needs a title.");
      return;
    }
    if (!isDateKey(fields.dayKey)) {
      setProblem("That is not a date I can read.");
      return;
    }
    if (!fields.allDay) {
      const minutes = Number(fields.minutes);
      if (!Number.isInteger(minutes) || minutes < SLOT_MINUTES || minutes > 720) {
        setProblem(`A length is a whole number of minutes, ${SLOT_MINUTES} to 720.`);
        return;
      }
    }
    setProblem("");
    onSave({ ...fields, title, location: fields.location.trim() });
  };

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={creating ? "New event" : `Edit ${draft.title}`}
      className="floating cal-editor fixed z-[60]"
      data-event-editor
      data-docked={docked ? "true" : undefined}
      style={docked || !place ? undefined : { left: place.left, top: place.top }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="label">{creating ? "new event" : "edit event"}</h3>
        <span className="timestamp">
          {readOnly ? `from ${draft.source}` : dayTitle(fields.dayKey)}
        </span>
      </div>

      <form
        className="mt-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="block">
          <span className="label">what</span>
          <input
            ref={titleRef}
            value={fields.title}
            readOnly={readOnly}
            onChange={(event) => set("title", event.target.value)}
            placeholder="Study block"
            aria-label="Event title"
            className="field mt-1.5"
          />
        </label>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label>
            <span className="label">day</span>
            <input
              type="date"
              value={fields.dayKey}
              readOnly={readOnly}
              onChange={(event) => set("dayKey", event.target.value)}
              aria-label="Day"
              className="field mt-1.5 w-[150px]"
            />
          </label>

          {!fields.allDay ? (
            <>
              <label>
                <span className="label">starts</span>
                <input
                  type="time"
                  /* Step a quarter hour, because that is what a drag snaps to and
                     what the grid can draw: a control offering 14:07 would let
                     the form write a time the calendar refuses to place. */
                  step={SLOT_MINUTES * 60}
                  value={formatClock(fields.startMin)}
                  readOnly={readOnly}
                  onChange={(event) => {
                    const minutes = parseClock(event.target.value);
                    if (minutes !== null) set("startMin", minutes);
                  }}
                  aria-label="Start time"
                  className="field mt-1.5 w-[124px]"
                />
              </label>

              <label>
                <span className="label">minutes</span>
                <input
                  type="number"
                  min={SLOT_MINUTES}
                  max={720}
                  step={SLOT_MINUTES}
                  value={fields.minutes}
                  readOnly={readOnly}
                  onChange={(event) => set("minutes", Number(event.target.value))}
                  aria-label="Length in minutes"
                  className="field mt-1.5 w-[104px]"
                />
              </label>
            </>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="min-w-[140px] flex-1">
            <span className="label">where</span>
            <input
              value={fields.location}
              readOnly={readOnly}
              onChange={(event) => set("location", event.target.value)}
              placeholder="optional"
              aria-label="Location"
              className="field mt-1.5"
            />
          </label>
          <button
            type="button"
            aria-pressed={fields.allDay}
            disabled={readOnly}
            onClick={() => set("allDay", !fields.allDay)}
            className="chip chip-round"
          >
            all day
          </button>
        </div>

        <p className="mt-3 text-[12px] leading-relaxed font-normal text-faint" data-editor-summary>
          {fields.allDay
            ? `${dayTitle(fields.dayKey)} · all day`
            : `${clockLabel(fields.dayKey, fields.startMin)} – ${clockLabel(
                fields.dayKey,
                fields.startMin + Math.max(Number(fields.minutes) || 0, SLOT_MINUTES),
              )}`}
        </p>

        {problem || error ? (
          <p role="alert" className="mt-2 text-[12px] leading-relaxed font-normal text-danger">
            {problem || error}
          </p>
        ) : null}

        {readOnly ? (
          <p className="mt-3 text-[12px] leading-relaxed font-normal text-faint">
            A synced entry. It is shown here as it comes from the feed, and the next
            sync would overwrite anything typed into it.
          </p>
        ) : (
          <div className="cal-actions mt-4 flex flex-wrap items-center gap-2">
            <button type="submit" disabled={busy} className="btn btn-primary">
              {creating ? "Add" : "Save"}
            </button>

            {!creating ? (
              confirming ? (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setConfirming(false);
                      onRemove();
                    }}
                    className="chip chip-danger"
                  >
                    remove
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} className="chip">
                    keep
                  </button>
                </>
              ) : (
                // Asked twice on purpose: this popover is anchored to a small
                // block, and the control that deletes it must not be the one the
                // pointer lands on while aiming for Save.
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  aria-label={`Remove ${draft.title}`}
                  className="chip chip-danger"
                >
                  remove
                </button>
              )
            ) : null}

            <button type="button" onClick={onClose} className="btn btn-ghost ml-auto">
              Close
            </button>
          </div>
        )}

        {readOnly ? (
          <div className="mt-3">
            <button type="button" onClick={onClose} className="btn btn-ghost">
              Close
            </button>
          </div>
        ) : null}
      </form>
    </div>
  );
}
