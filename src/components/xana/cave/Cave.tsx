"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Tabs } from "@/components/xana/settings/controls";
import { compareGoals, toneFor } from "@/lib/cave/types";

import CaveBoard from "./CaveBoard";
import MemoryRoom from "./MemoryRoom";
import ScheduleRoom from "./ScheduleRoom";
import TasksRoom from "./TasksRoom";
import { useCave } from "./useCave";

/**
 * My cave.
 *
 * A full-screen room rather than another settings section, because it is a
 * place you go to work on things rather than a form you fill in once. It
 * holds two rooms: the goal board, and the memory room where you can see and
 * correct what she believes.
 *
 * The quick-add field is the important part of the goal room. Goals are
 * written down in the moment a person thinks of them, and a board that needs
 * a dialog, a horizon and a target date before it will accept a title is a
 * board that stays empty. Everything except the title is optional here, and
 * two forms of shorthand are understood because they are what people
 * actually type: a trailing date, and a leading horizon word.
 */

export type CaveRoom = "goals" | "tasks" | "schedule" | "memory";

export interface CaveProps {
  open: boolean;
  onClose: () => void;
  /** Opens on this room. Set from wherever the user came in. */
  initialRoom?: CaveRoom;
}

const ROOMS: readonly { id: CaveRoom; label: string }[] = [
  { id: "goals", label: "Goals" },
  { id: "tasks", label: "Tasks" },
  { id: "schedule", label: "Schedule" },
  { id: "memory", label: "Memory" },
] as const;

/** Words that set a horizon when typed at the start of a goal. */
const HORIZON_WORDS: Array<[RegExp, "short" | "mid" | "long"]> = [
  [/^(?:now|today|this week|short)\b[:,]?\s*/i, "short"],
  [/^(?:this year|this quarter|mid|soon)\b[:,]?\s*/i, "mid"],
  [/^(?:long term|long-term|someday|eventually|one day)\b[:,]?\s*/i, "long"],
];

/**
 * Split a quick-added line into a title, a horizon and a date.
 *
 * Deliberately tiny and local. She already has a proper time parser for
 * conversation; duplicating that here would be the second implementation.
 * What this handles is the two shorthands a person types into a one-line
 * field on a board: "run a marathon by 2026-04-01" and "this year: learn
 * Japanese".
 */
export function parseQuickAdd(raw: string): {
  title: string;
  horizon?: "short" | "mid" | "long";
  targetDate?: string;
} {
  let text = raw.trim();
  let horizon: "short" | "mid" | "long" | undefined;

  for (const [pattern, value] of HORIZON_WORDS) {
    if (pattern.test(text)) {
      horizon = value;
      text = text.replace(pattern, "").trim();
      break;
    }
  }

  let targetDate: string | undefined;
  // A trailing ISO date, optionally introduced by "by" or "before".
  const dateMatch = /\s+(?:by|before|due)\s+(\d{4}-\d{2}-\d{2})\s*$/i.exec(text);
  if (dateMatch) {
    targetDate = dateMatch[1];
    text = text.slice(0, dateMatch.index).trim();
  } else {
    const bare = /\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(text);
    if (bare) {
      targetDate = bare[1];
      text = text.slice(0, bare.index).trim();
    }
  }

  return { title: text, horizon, targetDate };
}

export default function Cave({ open, onClose, initialRoom = "goals" }: CaveProps) {
  const controller = useCave(open);
  const [room, setRoom] = useState<CaveRoom>(initialRoom);
  const [quickAdd, setQuickAdd] = useState("");
  const [query, setQuery] = useState("");
  const [onlyAtRisk, setOnlyAtRisk] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) setRoom(initialRoom);
  }, [open, initialRoom]);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previous;
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  /** A one-line summary of the room, so it says something on arrival. */
  const summary = useMemo(() => {
    if (room === "schedule") {
      const today = controller.events.filter(
        (e) => new Date(e.start).toDateString() === new Date().toDateString(),
      ).length;
      return today === 0
        ? "Nothing scheduled today."
        : `${today} thing${today === 1 ? "" : "s"} today.`;
    }

    const active = controller.goals.filter((g) => g.goal.status === "active");
    const openTasks = controller.tasks.length;

    if (room === "tasks") {
      return openTasks === 0
        ? "Nothing open."
        : `${openTasks} task${openTasks === 1 ? "" : "s"} open.`;
    }

    if (active.length === 0) {
      return openTasks > 0
        ? `Nothing on the board yet · ${openTasks} task${openTasks === 1 ? "" : "s"} open.`
        : "Nothing on the board yet.";
    }

    const risky = active.filter((g) => ["warn", "danger"].includes(toneFor(g))).length;
    const soonest = active
      .filter((g) => g.progress.daysRemaining !== undefined && g.progress.daysRemaining >= 0)
      .sort((a, b) => (a.progress.daysRemaining ?? 0) - (b.progress.daysRemaining ?? 0))[0];
    const parts = [`${active.length} in play`];
    if (risky > 0) parts.push(`${risky} needing attention`);
    if (soonest) {
      parts.push(`nearest deadline ${soonest.progress.daysRemaining} days out`);
    }
    return `${parts.join(", ")}.`;
  }, [controller.goals, controller.tasks, controller.events, room]);

  const addGoal = useCallback(async () => {
    const raw = quickAdd.trim();
    if (!raw) return;
    const parsed = parseQuickAdd(raw);
    if (!parsed.title) return;
    setQuickAdd("");
    await controller.run("goal.create", {
      title: parsed.title,
      horizon: parsed.horizon ?? "short",
      targetDate: parsed.targetDate ?? null,
    });
  }, [controller, quickAdd]);

  if (!open) return null;

  const ordered = [...controller.goals].sort(compareGoals);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-void">
      {/* ---------------- header ---------------- */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b border-hairline px-6 py-4">
        <div className="min-w-0">
          <h2 id="cave-title" className="text-[15px] font-normal tracking-[0.01em] text-text">
            My cave
          </h2>
          <p className="mt-0.5 text-[12px] font-normal text-faint">{summary}</p>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden sm:block">
            <Tabs
              tabs={ROOMS}
              active={room}
              onChange={setRoom}
              ariaLabel="Cave rooms"
              orientation="horizontal"
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close My cave"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-dim transition-colors duration-[var(--t-fast)] hover:bg-surface-2 hover:text-text"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>

      <div className="sm:hidden">
        <div className="border-b border-hairline px-3 py-2">
          <Tabs
            tabs={ROOMS}
            active={room}
            onChange={setRoom}
            ariaLabel="Cave rooms"
            orientation="horizontal"
          />
        </div>
      </div>

      {/* ---------------- notices ---------------- */}
      {controller.error ? (
        <p
          role="alert"
          className="shrink-0 border-b border-hairline bg-danger/10 px-6 py-2 text-[12px] font-normal text-danger"
        >
          {controller.error}
        </p>
      ) : null}

      {/* ---------------- body ---------------- */}
      <div ref={panelRef} className="min-h-0 flex-1 overflow-y-auto">
        {room === "goals" ? (
          <div className="px-6 py-5">
            {/* quick add */}
            <div className="flex flex-wrap items-center gap-3">
              <input
                value={quickAdd}
                placeholder="What are you working towards? Try “this year: run a marathon by 2026-04-01”"
                onChange={(event) => setQuickAdd(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void addGoal();
                  if (event.key === "Escape" && quickAdd) {
                    event.stopPropagation();
                    setQuickAdd("");
                  }
                }}
                className="field max-w-[620px] flex-1"
                aria-label="Add a goal"
              />
              <button
                type="button"
                onClick={() => void addGoal()}
                disabled={!quickAdd.trim()}
                className="btn btn-primary"
              >
                Add
              </button>
              <input
                value={query}
                placeholder="Filter"
                onChange={(event) => setQuery(event.target.value)}
                className="field max-w-[180px]"
                aria-label="Filter goals"
              />
              <button
                type="button"
                onClick={() => setOnlyAtRisk((value) => !value)}
                aria-pressed={onlyAtRisk}
                className={`btn ${onlyAtRisk ? "btn-primary" : "btn-ghost"}`}
              >
                {onlyAtRisk ? "Showing what needs attention" : "Only what needs attention"}
              </button>
            </div>

            <p className="mt-3 max-w-[80ch] text-[12px] leading-relaxed font-normal text-faint">
              Drag a card between columns to change where it stands. Times and
              horizons can be set on the card itself, and “moved today” records
              progress on a goal that has no steps to tick.
            </p>

            <div className="mt-5">
              <CaveBoard controller={controller} query={query} onlyAtRisk={onlyAtRisk} />
            </div>
          </div>
        ) : room === "tasks" ? (
          <TasksRoom controller={controller} />
        ) : room === "schedule" ? (
          <ScheduleRoom controller={controller} />
        ) : (
          <MemoryRoom controller={controller} />
        )}
      </div>

      {/* ---------------- footer ---------------- */}
      <footer className="shrink-0 border-t border-hairline px-6 py-3">
        <p className="text-[11px] font-normal text-faint">
          {room === "goals"
            ? `${ordered.length} goal${ordered.length === 1 ? "" : "s"} in the cave. Everything here is stored locally in data/xana.db.`
            : room === "tasks"
              ? "Open tasks only — completing one removes it from this list. Everything here is stored locally in data/xana.db."
              : room === "schedule"
                ? "Today and tomorrow. What Next, Focus and Open read from."
                : "Forgetting is permanent, and she will not recall it again."}
        </p>
      </footer>
    </div>
  );
}
