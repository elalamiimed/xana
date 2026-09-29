"use client";

import type { Card } from "@/lib/api/contract";

import { Bar, Ring } from "./Rings";

/**
 * Renders one `Card` from `Message.cards`.
 *
 * The switch on `card.kind` is exhaustive and the default branch narrows the
 * card to `never`, so adding a variant to `Card` in types.ts breaks the
 * typecheck here instead of silently rendering nothing.
 *
 * No variant in the `Card` union carries an `ActionIntent`, so this component
 * is deliberately read-only: the one-tap buttons live on the nudges and
 * patterns in the ambient region, which do. If a future variant gains an
 * `action`, that is the point to wire a callback back in.
 *
 * Colour discipline (DESIGN.md §1): cyan is the only accent on a card. The
 * violet secondary is held for the orb's `acting` flash.
 */

export interface CardViewProps {
  card: Card;
}

/* ------------------------------------------------------------------ */
/* Shared furniture                                                    */
/* ------------------------------------------------------------------ */

function CardShell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-5">
      <h3 className="label">{label}</h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Label and value, separated by a quiet middot. */
function Meta({ label, value }: { label: string; value: string }) {
  return (
    <span className="timestamp">
      {label}
      <span aria-hidden="true"> · </span>
      <span className="text-dim">{value}</span>
    </span>
  );
}

/** "on track" reads better than "on-track" in a sentence-case interface. */
function paceLabel(pace: string): string {
  return pace.replace(/-/g, " ");
}

/** A due date said the way a person would say it, in local time. */
function dueLabel(due: string): string | null {
  const when = new Date(due);
  if (Number.isNaN(when.getTime())) return null;
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const days = Math.round((when.getTime() - startOfToday) / 86_400_000);

  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) return `in ${days}d`;
  return when.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* ------------------------------------------------------------------ */
/* Variant renderers                                                   */
/* ------------------------------------------------------------------ */

function BriefingCard({ card }: { card: Extract<Card, { kind: "briefing" }> }) {
  return (
    <CardShell label={card.title}>
      <ul className="space-y-2">
        {card.lines.map((line, index) => (
          <li
            key={`${index}-${line}`}
            className="text-[15px] leading-relaxed font-light tracking-[0.01em] text-text"
          >
            {line}
          </li>
        ))}
      </ul>
    </CardShell>
  );
}

function RecallCard({ card }: { card: Extract<Card, { kind: "recall" }> }) {
  return (
    <CardShell label={card.title}>
      <ul className="space-y-4">
        {card.hits.map((hit) => (
          <li key={hit.id}>
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-[14px] font-light text-text">
                {hit.title}
              </span>
              <span className="timestamp">{hit.kind}</span>
            </div>
            <p className="mt-1 text-[14px] leading-relaxed font-light text-dim">
              {hit.content}
            </p>
          </li>
        ))}
      </ul>
    </CardShell>
  );
}

function PatternCard({ card }: { card: Extract<Card, { kind: "pattern" }> }) {
  return (
    <CardShell label={card.title}>
      <p className="text-[14px] leading-relaxed font-light text-text">
        {card.observation}
      </p>
      {card.evidence.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {card.evidence.map((line, index) => (
            <li key={`${index}-${line}`} className="timestamp">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-4 flex flex-wrap items-baseline gap-3">
        <Meta label="confidence" value={`${Math.round(card.confidence * 100)}%`} />
        {card.suggestion ? (
          <span className="text-[13px] font-light text-dim">
            {card.suggestion}
          </span>
        ) : null}
      </div>
    </CardShell>
  );
}

function GoalsCard({ card }: { card: Extract<Card, { kind: "goals" }> }) {
  return (
    <CardShell label={card.title}>
      <ul className="space-y-5">
        {card.items.map((item) => (
          <li key={item.id} className="flex items-center gap-4">
            <Ring
              value={item.progress}
              label={`${item.title}, ${Math.round(item.progress * 100)} percent complete`}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-4">
                <span className="truncate text-[14px] font-light text-text">
                  {item.title}
                </span>
                <span className="timestamp shrink-0">
                  {Math.round(item.progress * 100)}%
                </span>
              </div>
              <p className="mt-0.5 text-[13px] font-light text-dim">
                {item.note}
              </p>
              <div className="mt-2">
                <Meta label={item.horizon} value={paceLabel(item.pace)} />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </CardShell>
  );
}

function EnergyCard({ card }: { card: Extract<Card, { kind: "energy" }> }) {
  return (
    <CardShell label={card.title}>
      <div className="flex items-baseline gap-3">
        <span className="metric">{card.score}</span>
        <span className="text-[13px] font-light text-dim">{card.band}</span>
      </div>
      {card.note ? (
        <p className="mt-2 text-[14px] leading-relaxed font-light text-dim">
          {card.note}
        </p>
      ) : null}
      {card.windows.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {card.windows.map((window) => (
            <li
              key={`${window.startHour}-${window.endHour}-${window.label}`}
              className="flex items-center gap-3"
            >
              <span className="timestamp w-20 shrink-0">
                {`${window.startHour}`.padStart(2, "0")}:00–
                {`${window.endHour}`.padStart(2, "0")}:00
              </span>
              <Bar
                value={window.confidence}
                label={`${window.label}, ${Math.round(window.confidence * 100)} percent confidence`}
              />
              <span className="w-16 shrink-0 text-right text-[13px] font-light text-dim">
                {window.band}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </CardShell>
  );
}

function TasksCard({ card }: { card: Extract<Card, { kind: "tasks" }> }) {
  return (
    <CardShell label={card.title}>
      <ul className="space-y-3">
        {card.items.map((item) => {
          const due = item.due ? dueLabel(item.due) : null;
          return (
            <li key={item.id} className="flex items-center gap-3">
              {/* Priority 1 gets the accent dot. Everything else is a faint
                  dot, so the row still aligns without a second colour. */}
              <span
                role="img"
                aria-label={`priority ${item.priority}`}
                className={`h-[3px] w-[3px] shrink-0 rounded-full ${
                  item.priority === 1 ? "bg-accent" : "bg-faint"
                }`}
              />
              <span className="min-w-0 flex-1 truncate text-[14px] font-light text-text">
                {item.title}
              </span>
              {item.project ? (
                <span className="timestamp shrink-0">{item.project}</span>
              ) : null}
              {due ? <span className="timestamp shrink-0">{due}</span> : null}
            </li>
          );
        })}
      </ul>
    </CardShell>
  );
}

function ReflectionCard({
  card,
}: {
  card: Extract<Card, { kind: "reflection" }>;
}) {
  return (
    <CardShell label={card.title}>
      <p className="text-[14px] leading-relaxed font-light whitespace-pre-line text-dim">
        {card.body}
      </p>
      {card.highlights.length > 0 ? (
        <ul className="mt-4 space-y-1.5">
          {card.highlights.map((line, index) => (
            <li
              key={`${index}-${line}`}
              className="text-[13px] font-light text-text"
            >
              {line}
            </li>
          ))}
        </ul>
      ) : null}
    </CardShell>
  );
}

function FocusCard({ card }: { card: Extract<Card, { kind: "focus" }> }) {
  return (
    <CardShell label={card.title}>
      <div className="flex items-baseline gap-3">
        <span className="metric">{card.minutes}</span>
        <span className="text-[13px] font-light text-dim">minutes</span>
      </div>
      <p className="mt-2 text-[14px] font-light text-text">{card.label}</p>
      {card.media ? (
        <p className="mt-1 text-[13px] font-light text-dim">{card.media}</p>
      ) : null}
    </CardShell>
  );
}

function CapabilitiesCard({
  card,
}: {
  card: Extract<Card, { kind: "capabilities" }>;
}) {
  return (
    <CardShell label={card.title}>
      <dl className="space-y-4">
        {card.groups.map((group) => (
          <div key={group.label}>
            <dt className="label">{group.label}</dt>
            <dd className="mt-1.5 text-[14px] leading-relaxed font-light text-dim">
              {group.items.join(" · ")}
            </dd>
          </div>
        ))}
      </dl>
    </CardShell>
  );
}

/* ------------------------------------------------------------------ */
/* The switch                                                          */
/* ------------------------------------------------------------------ */

export default function CardView({ card }: CardViewProps) {
  switch (card.kind) {
    case "briefing":
      return <BriefingCard card={card} />;
    case "recall":
      return <RecallCard card={card} />;
    case "pattern":
      return <PatternCard card={card} />;
    case "goals":
      return <GoalsCard card={card} />;
    case "energy":
      return <EnergyCard card={card} />;
    case "tasks":
      return <TasksCard card={card} />;
    case "reflection":
      return <ReflectionCard card={card} />;
    case "focus":
      return <FocusCard card={card} />;
    case "capabilities":
      return <CapabilitiesCard card={card} />;
    default: {
      // Exhaustiveness fence: a new Card variant lands here and fails to
      // compile, rather than rendering a blank card at runtime.
      const unhandled: never = card;
      return unhandled;
    }
  }
}
