"use client";

import { useCallback, useMemo, useState } from "react";

import {
  BOARD_COLUMNS,
  compareGoals,
  neighboursForMove,
  toneFor,
  type BoardColumn,
  type CaveGoal,
} from "@/lib/cave/types";

import GoalCard from "./GoalCard";
import type { CaveController } from "./useCave";

/**
 * The goal board: three columns, drag to move.
 *
 * DRAG AND DROP
 *
 * Native HTML5 drag events rather than a library. The requirement is one
 * gesture between three boxes on the same page; a dependency would add a
 * touch polyfill, a keyboard story and a maintainer for something the
 * platform already does. What it costs is the handful of details below,
 * each of which is a real bug if skipped:
 *
 *  - **`dragover` must call `preventDefault`** or the browser refuses the
 *    drop and the card snaps back.
 *  - **The drop index is computed from the pointer**, not from which card
 *    the pointer is over, so dropping in the gap below the last card works.
 *  - **The neighbours are read excluding the dragged card.** A card cannot
 *    be its own neighbour; including it makes a one-position move compute a
 *    midpoint against itself and collapse to no movement.
 *  - **A keyboard path exists**, because dragging is not available to
 *    everyone. Each card has a column picker in its controls.
 *
 * The move is applied locally first and confirmed by the server, which
 * returns the authoritative board. A rejected move therefore reverts on the
 * next response rather than leaving the card in a column it never reached.
 */

export interface CaveBoardProps {
  controller: CaveController;
  /** Filter applied to every column. */
  query: string;
  /** Hides goals whose pace is healthy, to surface only the ones at risk. */
  onlyAtRisk: boolean;
}

export default function CaveBoard({ controller, query, onlyAtRisk }: CaveBoardProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** `${status}:${index}`, so the drop target can draw a line. */
  const [dropAt, setDropAt] = useState<string | null>(null);

  /** The board as displayed: server order, filtered, one column at a time. */
  const columns = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const visible = controller.goals.filter((entry) => {
      if (onlyAtRisk) {
        const tone = toneFor(entry);
        if (tone !== "warn" && tone !== "danger") return false;
      }
      if (!needle) return true;
      const haystack = [
        entry.goal.title,
        entry.goal.why ?? "",
        entry.goal.area ?? "",
        ...entry.goal.milestones.map((m) => m.title),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });

    const map = new Map<BoardColumn, CaveGoal[]>();
    for (const column of BOARD_COLUMNS) {
      map.set(
        column.id,
        visible
          .filter((entry) => entry.goal.status === column.id)
          .slice()
          .sort(compareGoals),
      );
    }
    return map;
  }, [controller.goals, query, onlyAtRisk]);

  /**
   * Where a drop at this pointer position would land.
   *
   * Read from the card midpoints rather than from `event.target`, so the
   * gaps between cards behave sensibly and the last position in a column is
   * reachable.
   */
  const indexAt = useCallback(
    (event: React.DragEvent<HTMLElement>, entries: readonly CaveGoal[]) => {
      const cards = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>("[data-goal-card]"),
      );
      for (let i = 0; i < cards.length; i += 1) {
        const box = cards[i].getBoundingClientRect();
        if (event.clientY < box.top + box.height / 2) return i;
      }
      return entries.length;
    },
    [],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLElement>, status: BoardColumn) => {
      event.preventDefault();
      const id = draggingId ?? event.dataTransfer.getData("text/plain");
      setDraggingId(null);
      setDropAt(null);
      if (!id) return;

      const entries = columns.get(status) ?? [];
      const index = indexAt(event, entries);
      const { before, after } = neighboursForMove(controller.goals, id, status, index);
      void controller.run("goal.move", { id, status, before, after }, id);
    },
    [columns, controller, draggingId, indexAt],
  );

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {BOARD_COLUMNS.map((column) => {
        const entries = columns.get(column.id) ?? [];
        const total = entries.reduce((sum, e) => sum + e.progress.progress, 0);
        const average = entries.length > 0 ? total / entries.length : 0;

        return (
          <section
            key={column.id}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              if (draggingId) setDropAt(`${column.id}:${indexAt(event, entries)}`);
            }}
            onDragLeave={(event) => {
              // Only clear when the pointer has actually left the column,
              // not when it crosses onto a child card.
              if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropAt(null);
            }}
            onDrop={(event) => handleDrop(event, column.id)}
            className={`flex min-h-[180px] flex-col rounded-[var(--r-lg)] border p-3 transition-colors duration-150 ${
              dropAt?.startsWith(`${column.id}:`)
                ? "border-accent/40 bg-accent/5"
                : "border-hairline bg-surface/40"
            }`}
            aria-label={`${column.label}, ${entries.length} goal${entries.length === 1 ? "" : "s"}`}
          >
            <header className="mb-3 flex items-baseline justify-between gap-2 px-1">
              <div>
                <h4 className="label">{column.label}</h4>
                <p className="mt-0.5 text-[11px] font-light text-faint">
                  {entries.length} · dropping here {column.onto}
                </p>
              </div>
              {entries.length > 0 ? (
                <span className="timestamp tabular-nums">{Math.round(average * 100)}%</span>
              ) : null}
            </header>

            <div className="flex flex-1 flex-col gap-3">
              {entries.map((entry, index) => (
                <div key={entry.goal.id} data-goal-card>
                  {dropAt === `${column.id}:${index}` ? (
                    <div className="mb-2 h-0.5 rounded-full bg-accent" aria-hidden="true" />
                  ) : null}
                  <GoalCard
                    entry={entry}
                    controller={controller}
                    busy={controller.pending.has(entry.goal.id)}
                    dragging={draggingId === entry.goal.id}
                    onDragStart={setDraggingId}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setDropAt(null);
                    }}
                  />
                </div>
              ))}

              {dropAt === `${column.id}:${entries.length}` && entries.length > 0 ? (
                <div className="h-0.5 rounded-full bg-accent" aria-hidden="true" />
              ) : null}

              {entries.length === 0 ? (
                <p className="px-1 py-6 text-center text-[12px] font-light text-faint">
                  {controller.loading ? "Reading…" : "Nothing here yet."}
                </p>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}
