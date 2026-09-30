"use client";

import type { Presence } from "@/lib/api/contract";
import type { AdapterStatus, LifeState } from "@/lib/core/types";

/**
 * The header: the name, a whisper of presence, and the adapter dots.
 *
 * Colour alone is never the signal (DESIGN.md §6). The dot row carries an
 * `aria-label` that states the counts, each dot is a focusable element with
 * its own label, and the tooltip appears on hover *or* keyboard focus — a
 * colour-only status row would be invisible to a screen reader and to anyone
 * who cannot separate the amber from the green.
 */

const DOT_BASE = "h-1.5 w-1.5 shrink-0 rounded-full";

/** `--good` connected, `--text-faint` local, `--warn` error or offline. */
const STATE_DOT: Record<AdapterStatus["state"], string> = {
  connected: "bg-good",
  local: "bg-faint",
  offline: "bg-warn",
  error: "bg-warn",
};

/** Worst news first: a broken adapter should not hide behind two healthy ones. */
const STATE_ORDER: Record<AdapterStatus["state"], number> = {
  error: 0,
  offline: 1,
  local: 2,
  connected: 3,
};

const STATE_WORDS: Record<AdapterStatus["state"], string> = {
  connected: "connected",
  local: "local only",
  offline: "offline",
  error: "error",
};

function summarise(sources: readonly AdapterStatus[]): string {
  if (sources.length === 0) return "No adapters reported";
  let connected = 0;
  let local = 0;
  let bad = 0;
  for (const source of sources) {
    if (source.state === "connected") connected += 1;
    else if (source.state === "local") local += 1;
    else bad += 1;
  }
  const parts: string[] = [];
  if (connected > 0) parts.push(`${connected} connected`);
  if (local > 0) parts.push(`${local} local`);
  if (bad > 0) parts.push(`${bad} needing attention`);
  return `Adapters: ${parts.join(", ")}`;
}

function AdapterDot({ source }: { source: AdapterStatus }) {
  const detail = source.detail?.trim();

  return (
    <span className="group relative inline-flex">
      <span
        tabIndex={0}
        role="img"
        aria-label={`${source.label}, ${STATE_WORDS[source.state]}`}
        className={`${DOT_BASE} ${STATE_DOT[source.state]}`}
      />
      {/* Hover only, per the design. Focus reveals the same thing. */}
      <span
        role="tooltip"
        className="pointer-events-none absolute top-[14px] right-0 z-20 w-max max-w-[260px] rounded-[var(--r-md)] border border-hairline bg-surface px-3 py-2 opacity-0 transition-opacity duration-[var(--t-fast)] group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <span className="block text-[12px] font-normal text-text">
          {source.label}
        </span>
        <span className="mt-0.5 block text-[11px] font-normal text-dim">
          {`${source.state} · ${source.mode}`}
        </span>
        {detail ? (
          <span className="mt-0.5 block text-[11px] leading-relaxed font-normal text-faint">
            {detail}
          </span>
        ) : null}
      </span>
    </span>
  );
}

export interface AdapterDotsProps {
  sources: readonly AdapterStatus[];
}

export default function AdapterDots({ sources }: AdapterDotsProps) {
  if (sources.length === 0) return null;

  const ordered = [...sources].sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state],
  );

  return (
    <div
      role="group"
      aria-label={summarise(sources)}
      className="flex items-center gap-2"
    >
      {ordered.map((source) => (
        <AdapterDot key={source.id} source={source} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** A single cyan mark for `thinking` / `speaking`. The dot is never alone:
    the orb's status region and the caption carry the same state in words. */
const PRESENCE_WORD: Record<Presence, string> = {
  dormant: "at rest",
  idle: "listening",
  thinking: "thinking",
  speaking: "speaking",
  acting: "acting",
};

export interface HeaderProps {
  /** Null until the first context arrives; the dots simply are not there. */
  lifeState: LifeState | null;
  presence: Presence;
  /** Opens the settings panel. The orb also opens it. */
  onOpenSettings: () => void;
  /** Opens My cave, the goal board and memory room. */
  onOpenCave: () => void;
}

export function Header({ lifeState, presence, onOpenSettings, onOpenCave }: HeaderProps) {
  const live = presence === "thinking" || presence === "speaking";
  const sources = lifeState?.sources ?? [];
  const broken = sources.filter(
    (source) => source.state === "error" || source.state === "offline",
  ).length;

  return (
    <header className="flex h-[var(--header-h)] shrink-0 items-center justify-between gap-4 px-6">
      <div className="flex min-w-0 items-baseline gap-3">
        <span className="text-[13px] font-normal tracking-[0.32em] text-text uppercase">
          Xana
        </span>
        <span className="timestamp truncate">{PRESENCE_WORD[presence]}</span>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {live ? (
          // The one moving thing outside the orb, and only while she is
          // actually working. `breath` already runs at 2.4s per the state
          // table; reduced motion stops it via motion-reduce.
          <span
            aria-hidden="true"
            className="h-1 w-1 rounded-full bg-accent/40 [animation:breath_2.4s_var(--ease-soft)_infinite_alternate] motion-reduce:animate-none"
          />
        ) : null}

        <AdapterDots sources={sources} />

        {/* My cave. A word rather than an icon, for the same reason Settings
            is one: the two things a user needs to find on their own are the
            composer and the place their goals live. */}
        <button
          type="button"
          onClick={onOpenCave}
          className="flex items-center gap-2 rounded-full border border-hairline px-3 py-1.5 text-[12px] font-normal text-dim transition-colors duration-[var(--t-fast)] hover:border-hairline-2 hover:bg-surface-2 hover:text-text"
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M1.5 6.2 7 1.6l5.5 4.6M3 5.6V12h8V5.6"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          My cave
        </button>

        {/* Settings. */}
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={
            broken > 0
              ? `Settings. ${broken} ${broken === 1 ? "connection needs" : "connections need"} attention.`
              : "Settings"
          }
          className="group relative flex items-center gap-2 rounded-full border border-hairline px-3 py-1.5 text-[12px] font-normal text-dim transition-colors duration-[var(--t-fast)] hover:border-hairline-2 hover:bg-surface-2 hover:text-text"
        >
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="2.4" stroke="currentColor" strokeWidth="1.1" />
            <path
              d="M7 1v1.6M7 11.4V13M13 7h-1.6M2.6 7H1M11.24 2.76l-1.13 1.13M3.89 10.11l-1.13 1.13M11.24 11.24l-1.13-1.13M3.89 3.89L2.76 2.76"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
            />
          </svg>
          Settings
          {broken > 0 ? (
            <span
              aria-hidden="true"
              className="h-1 w-1 rounded-full bg-warn"
            />
          ) : null}
        </button>
      </div>
    </header>
  );
}
