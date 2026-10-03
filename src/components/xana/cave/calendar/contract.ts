"use client";

/**
 * What the room and its grids agree on.
 *
 * Three small shapes, in a file of their own so a grid can be read without
 * reading the room and so no component has to import another component to get a
 * type. Types only: this compiles to nothing.
 */

import type { CalendarEvent } from "@/lib/core/types";

/** A rectangle in viewport pixels: where a block or a chip is on screen. */
export interface AnchorBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The state of the editor, whoever opened it.
 *
 * One shape for both cases on purpose. A new entry and an existing one differ
 * by one field — the id — and giving them two types would mean two forms, two
 * validations and two chances for "create" and "edit" to disagree about what a
 * readable date is.
 */
export interface EventDraft {
  /** Absent when this is a new entry rather than an existing one. */
  id?: string;
  title: string;
  dayKey: string;
  startMin: number;
  minutes: number;
  location: string;
  allDay: boolean;
  /** Where it came from, when it is not the user's own record. */
  source?: string;
}

/** The editor's fields, as they were left. */
export interface EventDraftFields {
  title: string;
  dayKey: string;
  startMin: number;
  minutes: number;
  location: string;
  allDay: boolean;
}

/**
 * Everything a grid may ask the room to do.
 *
 * Deliberately not the server calls: `beginCreate` opens the editor rather than
 * writing, because a calendar that put "New event" in the database on every
 * stray press would fill up with them. Nothing here returns a promise, because
 * the grids are optimistic — the room owns the round trip and the rollback.
 */
export interface CalendarActions {
  /** A block was dropped on a day at a minute. */
  move: (event: CalendarEvent, dayKey: string, startMin: number) => void;
  /** A block's edge was dragged to a new start and length. */
  resize: (event: CalendarEvent, dayKey: string, startMin: number, minutes: number) => void;
  /**
   * A block was moved with the keyboard.
   *
   * The same write as a drop, and deliberately the same call rather than a
   * second one: a calendar whose arrow keys went through a different path from
   * its pointer would be a calendar with two opinions about where an event is.
   */
  nudge: (event: CalendarEvent, dayKey: string, startMin: number, minutes: number) => void;
  /** A slot was drawn or pressed: open the editor there. */
  beginCreate: (dayKey: string, startMin: number, minutes: number, anchor: AnchorBox) => void;
  /** A block or chip was clicked: open it. */
  open: (event: CalendarEvent, anchor: AnchorBox) => void;
  /** A day was asked for on its own: the day view, anchored there. */
  openDay: (dayKey: string) => void;
}
