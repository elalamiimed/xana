"use client";

/**
 * The cave's client: read the board, run an operation, adopt the result.
 *
 * Every mutation returns the whole board, so this hook replaces its state
 * with the server's answer rather than patching it locally. That is a
 * deliberate trade: a local patch would be faster by a frame, and would also
 * be the second implementation of ordering, progress and pace — the first
 * being the server's. Two implementations of "what order is this column in"
 * is how a drag-and-drop board ends up quietly disagreeing with its own
 * database.
 *
 * The one piece of local state is the in-flight set, so a card being saved
 * can show that it is saving without blocking the rest of the board.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { CaveGoal, CaveHealth, CaveSnapshot, MemoryPage, TrashItem } from "@/lib/cave/types";
import type { CalendarEvent, Task } from "@/lib/core/types";

export class CaveRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "CaveRequestError";
  }
}

async function request<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, { cache: "no-store", ...init });
  } catch {
    throw new CaveRequestError("The local mind is not answering.", 0);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new CaveRequestError(`That route answered ${response.status}.`, response.status);
  }

  if (!response.ok) {
    const message = (payload as { error?: string } | null)?.error;
    throw new CaveRequestError(message ?? `That route answered ${response.status}.`, response.status);
  }
  return payload as T;
}

export interface CaveController {
  goals: CaveGoal[];
  /** The open task list, newest state as the server last reported it. */
  tasks: Task[];
  /** Today and tomorrow, for the schedule room. */
  events: CalendarEvent[];
  memories: MemoryPage | null;
  /** What is in the bin, as the server last reported it. */
  trash: TrashItem[];
  /**
   * The log, or null before the first read lands.
   *
   * Null is not "nothing recorded" — the room has to draw a week of empty slots
   * for a person who has never logged anything, and it must not do that while
   * the first read is still in flight, or an empty log and an unread one look
   * identical.
   */
  health: CaveHealth | null;
  /** False until the first read settles. */
  loading: boolean;
  /** Ids with an operation in flight, so a card can show its own spinner. */
  pending: ReadonlySet<string>;
  /** One line in the app's voice about the last failure. */
  error: string | null;
  reload: () => Promise<void>;
  /**
   * Run an operation. Resolves to true when the server accepted it.
   *
   * Never throws: a failed drag has to leave the board usable, and the
   * caller needs a boolean to decide whether to roll its optimistic change
   * back.
   */
  run: (op: string, input?: Record<string, unknown>, pendingKey?: string) => Promise<boolean>;
  /**
   * The same call, with the server's answer kept.
   *
   * A drag on the calendar is optimistic: the block moves the moment the
   * pointer is released, and what the server says afterwards is the
   * authority on where it actually landed. That reconciliation needs the
   * record, not a boolean — and it needs it *without* a second read of the
   * window, because a second read is a second round trip the user can see
   * as the block jumping back. `run` stays as it is so the rooms that only
   * need "did that save" are untouched.
   */
  runDetailed: (
    op: string,
    input?: Record<string, unknown>,
    pendingKey?: string,
  ) => Promise<{ ok: boolean; payload: Record<string, unknown>; error: string }>;
  clearError: () => void;
}

export function useCave(open: boolean): CaveController {
  const [goals, setGoals] = useState<CaveGoal[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [memories, setMemories] = useState<MemoryPage | null>(null);
  const [trash, setTrash] = useState<TrashItem[]>([]);
  const [health, setHealth] = useState<CaveHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const loaded = useRef(false);

  const adopt = useCallback((payload: Partial<CaveSnapshot> & { memories?: unknown }) => {
    if (Array.isArray(payload.goals)) setGoals(payload.goals);
    if (Array.isArray(payload.tasks)) setTasks(payload.tasks);
    if (Array.isArray(payload.events)) setEvents(payload.events);
    if (Array.isArray(payload.trash)) setTrash(payload.trash);
    if (payload.health) setHealth(payload.health);
    const page = payload.memories as MemoryPage | undefined;
    if (page && Array.isArray(page.items)) {
      // An operation returns only the records it touched, so the fuller
      // existing page is kept for anything it did not mention.
      setMemories((previous) =>
        previous ? { ...previous, items: mergeById(previous.items, page.items), stats: page.stats ?? previous.stats } : page,
      );
    } else if (page?.stats) {
      setMemories((previous) => (previous ? { ...previous, stats: page.stats as MemoryPage["stats"] } : previous));
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const snapshot = await request<CaveSnapshot>("/api/cave");
      adopt(snapshot);
      loaded.current = true;
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the cave.");
    } finally {
      setLoading(false);
    }
  }, [adopt]);

  const runDetailed = useCallback(
    async (
      op: string,
      input: Record<string, unknown> = {},
      pendingKey?: string,
    ): Promise<{ ok: boolean; payload: Record<string, unknown>; error: string }> => {
      const key = pendingKey ?? op;
      setPending((previous) => new Set(previous).add(key));
      try {
        const payload = await request<Record<string, unknown>>("/api/cave", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ op, ...input }),
        });
        adopt(payload as Partial<CaveSnapshot>);
        setError(null);
        return { ok: true, payload, error: "" };
      } catch (err) {
        const message = err instanceof Error ? err.message : "That change could not be saved.";
        setError(message);
        return { ok: false, payload: {}, error: message };
      } finally {
        setPending((previous) => {
          const next = new Set(previous);
          next.delete(key);
          return next;
        });
      }
    },
    [adopt],
  );

  const run = useCallback(
    async (op: string, input: Record<string, unknown> = {}, pendingKey?: string) =>
      (await runDetailed(op, input, pendingKey)).ok,
    [runDetailed],
  );

  /**
   * Read the cave when it opens, and again every time it is re-opened.
   *
   * This is the whole reason the hook takes `open`, and it was missing: the
   * rooms rendered from state that nothing had ever filled, so a live board
   * with three goals and an open task showed "Nothing on the board yet" —
   * an empty state that was not a report but a default.
   *
   * Re-reading on each open rather than once per mount is deliberate. The
   * cave is not the only writer: she adds, completes and removes things from
   * the chat, and a board that loaded once at page load would be wrong by the
   * time it is opened. Loading while closed would be the opposite mistake —
   * a fetch on every page load for a screen nobody asked for.
   */
  useEffect(() => {
    if (!open) return;
    void reload();
  }, [open, reload]);

  return {
    goals,
    tasks,
    events,
    memories,
    trash,
    health,
    loading: loading && !loaded.current,
    pending,
    error,
    reload,
    run,
    runDetailed,
    clearError: () => setError(null),
  };
}

/**
 * Merge server-returned records into the list, preserving order.
 *
 * An operation answers with the records it changed, not the whole list, so
 * the existing order is the authority and only the matching ids are
 * replaced. New records are appended; removed ones are dropped by the
 * caller, which knows what it asked for.
 */
function mergeById<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return existing;
  const byId = new Map(incoming.map((item) => [item.id, item]));
  const merged = existing.map((item) => byId.get(item.id) ?? item);
  const known = new Set(existing.map((item) => item.id));
  for (const item of incoming) {
    if (!known.has(item.id)) merged.unshift(item);
  }
  return merged;
}
