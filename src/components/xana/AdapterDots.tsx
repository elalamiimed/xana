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

/**
 * `--good` connected, `--text-faint` local, `--warn` error or offline,
 * a hollow ring for blocked.
 *
 * Blocked gets a ring rather than a colour because it is not a severity. A
 * plugin waiting for consent is neither healthy nor broken, and painting it
 * amber would put it in the same class as a 401 — which is how a user learns
 * to ignore the dot that matters. A ring reads as "not filled in yet".
 */
const STATE_DOT: Record<AdapterStatus["state"], string> = {
  connected: "bg-good",
  local: "bg-faint",
  offline: "bg-warn",
  error: "bg-warn",
  blocked: "bg-transparent ring-1 ring-faint",
};

/** Worst news first, then the ones waiting on the user, then the quiet ones. */
const STATE_ORDER: Record<AdapterStatus["state"], number> = {
  error: 0,
  offline: 1,
  blocked: 2,
  local: 3,
  connected: 4,
};

const STATE_WORDS: Record<AdapterStatus["state"], string> = {
  connected: "connected",
  local: "local only",
  offline: "offline",
  error: "error",
  blocked: "waiting for permission",
};

function summarise(sources: readonly AdapterStatus[]): string {
  if (sources.length === 0) return "No adapters reported";
  let connected = 0;
  let local = 0;
  let blocked = 0;
  let bad = 0;
  for (const source of sources) {
    if (source.state === "connected") connected += 1;
    else if (source.state === "local") local += 1;
    else if (source.state === "blocked") blocked += 1;
    else bad += 1;
  }
  const parts: string[] = [];
  if (connected > 0) parts.push(`${connected} connected`);
  if (local > 0) parts.push(`${local} local`);
  if (blocked > 0) parts.push(`${blocked} waiting for permission`);
  if (bad > 0) parts.push(`${bad} needing attention`);
  return `Adapters: ${parts.join(", ")}`;
}

function AdapterDot({ source }: { source: AdapterStatus }) {
  const detail = source.detail?.trim();
  /**
   * Everything the dot knows, on the dot.
   *
   * The tooltip is a sighted affordance and it is always in the DOM at
   * `opacity-0`, which made it a second, unreadable copy of the same sentence
   * in the accessibility tree — and, to a design detector reading the page, a
   * large block of text that never becomes visible. It is `aria-hidden` for
   * that reason, and the facts it draws (the mode, the reason) are folded into
   * the label instead, so hiding the duplicate takes nothing away from a
   * screen reader.
   */
  const label = [source.label, STATE_WORDS[source.state], source.mode, detail]
    .filter(Boolean)
    .join(", ");

  return (
    <span className="group relative inline-flex">
      <span
        tabIndex={0}
        role="img"
        aria-label={label}
        className={`${DOT_BASE} ${STATE_DOT[source.state]}`}
      />
      {/* Hover only, per the design. Focus reveals the same thing. */}
      <span
        role="tooltip"
        aria-hidden="true"
        className="pointer-events-none absolute top-[14px] right-0 z-20 w-max max-w-[260px] rounded-[var(--r-md)] border border-hairline bg-surface px-3 py-2 opacity-0 transition-opacity duration-[var(--t-fast)] group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <span className="block text-[12px] font-normal text-text">
          {source.label}
        </span>
        <span className="mt-0.5 block text-[12px] font-normal text-dim">
          {`${source.state} · ${source.mode}`}
        </span>
        {detail ? (
          <span className="mt-0.5 block text-[12px] leading-relaxed font-normal text-faint">
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

/**
 * Silence her, from anywhere.
 *
 * WHY THIS IS A BUTTON AND NOT A SETTING
 *
 * Reading replies aloud is a switch in Settings → Voice, and while she is
 * talking that switch is three actions away: open the panel, find the section,
 * flip it, save — all of it while a sentence plays over the top of you. The
 * report that produced this control was *"whenever I text xana she just keeps
 * on talking"*, and the shape of that complaint is the point: the thing the
 * user wants is one press, at the moment it is happening, without leaving what
 * they were doing. So the control lives in the header, where it is reachable
 * from every state of the page, and it takes effect on the click rather than on
 * the round trip — see `page.tsx`, where the mute is read from a ref so a reply
 * already in flight is caught by it.
 *
 * WHY IT IS NOT THE SAME SWITCH
 *
 * It writes `voice.muted`, not `voice.speakReplies`. Muting from here must not
 * throw away the preference the user chose deliberately — unmuting has to give
 * back exactly what was there, and a control that quietly rewrites a setting
 * you set on purpose is one people stop trusting. The store enforces the one
 * interaction between them: switching spoken replies ON lifts the mute, because
 * there is no reading of "read replies aloud" that means silence.
 */
function MuteButton({
  speakReplies,
  muted,
  ready,
  onToggle,
}: {
  speakReplies: boolean;
  muted: boolean;
  ready: boolean;
  onToggle: () => void;
}) {
  /**
   * Draw it only where there is speech to silence.
   *
   * `ready` is false until the shell has asked the browser, and until then the
   * honest thing is to draw nothing: a control that appears a beat after the
   * page settles is a flicker, and one drawn optimistically would be a button
   * with nothing behind it on a browser that cannot speak.
   */
  if (!ready) return null;

  /**
   * And only when she is set to read replies aloud.
   *
   * This guard used to be `!speakReplies && !muted`, which a review caught
   * drawing the control in exactly the state its own comment claimed to hide:
   * with the preference switched OFF and a stale mute left set — reachable by
   * muting from here and then turning *Read replies aloud* off in the panel —
   * the header carried a pressed, accented speaker whose label promised "she
   * will read replies aloud again", which was false twice over.
   *
   * With the preference off there is nothing for a mute to silence, so the
   * whole control belongs to the panel's switch and not to the header.
   */
  if (!speakReplies) return null;

  /**
   * The switch is mid-PUT.
   *
   * The AUDIO does not wait for it — the ref in `page.tsx` is written on the
   * press, so the sentence stops at once — but the button's own face comes from
   * the stored value, which arrives with the response. So this is honest about
   * what it is: the mute is already in force, and the control catches up a
   * moment later. A failure to save is reported where every other settings
   * failure is, in the panel.
   *
   * ICON ONLY, AND WHY THAT IS NOT A LOSS HERE
   *
   * Its two neighbours carry their words, and this one cannot: at 390px the
   * three word-buttons plus the adapter dots come to 435px of a 326px header,
   * so a third label is what pushes Settings off the right edge. The columns
   * that had to give were either the words or the dots, and the dots are a
   * status row that DESIGN.md §6 says must not shrink — a squashed dot reads as
   * a different state. The speaker is also the one icon in the header that
   * needs no word: it is on every phone and every player ever made, and the mic
   * in the composer already sets the precedent for an icon-only control here.
   *
   * ONE NAME, AND THE STATE SAID ONCE
   *
   * `aria-label` is constant — "Mute her voice" — and `aria-pressed` carries the
   * state. That is the W3C APG's own instruction for a toggle: the label must
   * not change with the state, and a control that renames itself "Unmute" does
   * not need `aria-pressed` at all. The first version here did both, so a screen
   * reader announced "Unmute her voice. She will read replies aloud again.,
   * toggle button, pressed" — the state twice, in two tenses. `title` says the
   * same constant thing for a hovering pointer, and the crossed-out speaker is
   * what a sighted user reads.
   */
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={muted}
      aria-label="Mute her voice. Replies are still written."
      title="Mute her voice"
      className="icon-tap flex items-center justify-center rounded-full border border-hairline text-[12px] font-normal transition-colors duration-[var(--t-state)] hover:border-hairline-2 hover:bg-surface-2"
      // The tone is the *state*, and it is carried by `aria-pressed` as well:
      // DESIGN.md §6 allows the colour to reinforce what the control already
      // says, never to be the only thing saying it.
      data-mark="mute toggle"
      style={{
        borderColor: muted ? "var(--a-40)" : undefined,
        backgroundColor: muted ? "var(--a-08)" : undefined,
        color: muted ? "var(--text)" : "var(--text-dim)",
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        aria-hidden="true"
        className="shrink-0"
      >
        <path
          d="M2 5.4h2.2L7.4 3.1v7.8L4.2 8.6H2z"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {muted ? (
          // The cross is what makes the two states tellable apart at a glance,
          // and it is the whole reason the icon can stand in for a word.
          <path
            d="M9.8 5.6 12.6 8.4M12.6 5.6 9.8 8.4"
            stroke="currentColor"
            strokeWidth="1.1"
            strokeLinecap="round"
          />
        ) : (
          <path
            d="M9.6 5.5a3.1 3.1 0 0 1 0 3M11.5 4a5.4 5.4 0 0 1 0 6"
            stroke="currentColor"
            strokeWidth="1.1"
            strokeLinecap="round"
          />
        )}
      </svg>
    </button>
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
  /** Whether she is set to read replies aloud. The mute control follows it. */
  speakReplies: boolean;
  /** Whether she is silenced right now. */
  muted: boolean;
  /** Whether this browser can speak at all. */
  speechReady: boolean;
  /** Silences her, or lets her speak again. Applies before the request. */
  onToggleMuted: () => void;
}

export function Header({
  lifeState,
  presence,
  onOpenSettings,
  onOpenCave,
  speakReplies,
  muted,
  speechReady,
  onToggleMuted,
}: HeaderProps) {
  const live = presence === "thinking" || presence === "speaking";
  const sources = lifeState?.sources ?? [];
  const broken = sources.filter(
    (source) => source.state === "error" || source.state === "offline",
  ).length;
  // Kept apart from `broken` on purpose: a connection waiting for consent is
  // not a fault and must not raise the same amber flag a failed request does.
  const waiting = sources.filter((source) => source.state === "blocked").length;

  return (
    /* The header wraps rather than overlapping.
     *
     * At 390px with a handful of connections the row does not fit: the
     * wordmark is the only item that cannot shrink, and the dot row is
     * `shrink-0` on purpose — a squashed dot reads as a different state — so
     * the dots were painted straight over it. A design detector measured it:
     * "Xana" was 50% covered by an opaque amber dot. `min-h` instead of `h`
     * lets the two groups take a line each when they must, which is the honest
     * answer on a phone. Nothing is hidden and the header is 60px again the
     * moment there is room for it.
     *
     * AND THE SECOND WRAP, WHICH THE MUTE BUTTON FORCED
     *
     * The paragraph above describes two flex children, and a group that is
     * alone on its own line cannot be told it is too wide: flexbox only wraps
     * *between* items. So when the mute control made the right-hand group
     * 435px inside a 326px header, nothing wrapped and nothing scrolled — the
     * group simply ran to x=467 in a 390px window, which the browser reports as
     * `scrollWidth === 390` because the page never asked to scroll. The last
     * button, Settings, was half off the screen and every automated check in
     * this repo passed, because "does the page overflow" is answered no.
     *
     * Measured, not guessed: at 390px the brand is 111px, the dots 132px and
     * the three controls 178px, against 326px of usable width. So the spacer
     * below eats the slack when everything fits — one row, exactly as before —
     * and collapses to nothing when it does not, which lets the dot row and the
     * buttons take a line each. `min-w-0` is what permits that second wrap: a
     * flex item defaults to `min-width: auto` and refuses to go below its
     * content, which is the whole reason the group overflowed rather than
     * folding. */
    <header className="flex min-h-[var(--header-h)] shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-6 py-2">
      <div className="flex min-w-0 items-baseline gap-3">
        <span className="text-[13px] font-normal tracking-[0.32em] text-text uppercase">
          Xana
        </span>
        <span className="timestamp truncate">{PRESENCE_WORD[presence]}</span>
      </div>

      {/* The slack. `flex-1` and nothing else: it has no minimum, so it is the
          first thing to disappear when the row runs out of room. */}
      <div className="flex-1" aria-hidden="true" />

      <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">
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

        {/* Mute. To the left of the two that open something: it is the only one
            that is about the moment, and the one a hand goes looking for while
            a sentence is playing. Icon only, for the reason its own comment
            gives — three labels do not fit at 390px and the dots are the wrong
            thing to shrink. */}
        <MuteButton
          speakReplies={speakReplies}
          muted={muted}
          ready={speechReady}
          onToggle={onToggleMuted}
        />

        {/* My cave. A word rather than an icon, for the same reason Settings
            is one: the two things a user needs to find on their own are the
            composer and the place their goals live. The padding tightens below
            420px so these two fit beside the dots more often than not — the
            `tap` floor is a minimum, not a size, so this buys 16px of header
            without taking anything away from a thumb. */}
        <button
          type="button"
          onClick={onOpenCave}
          className="tap flex items-center gap-2 rounded-full border border-hairline px-3 py-1.5 text-[12px] font-normal text-dim transition-colors duration-[var(--t-fast)] hover:border-hairline-2 hover:bg-surface-2 hover:text-text max-[420px]:px-2"
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
              : waiting > 0
                ? `Settings. ${waiting} ${waiting === 1 ? "connection is" : "connections are"} waiting for permission.`
                : "Settings"
          }
          className="tap group relative flex items-center gap-2 rounded-full border border-hairline px-3 py-1.5 text-[12px] font-normal text-dim transition-colors duration-[var(--t-fast)] hover:border-hairline-2 hover:bg-surface-2 hover:text-text max-[420px]:px-2"
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
          ) : waiting > 0 ? (
            // A hairline mark, not a warning: something can be switched on.
            <span
              aria-hidden="true"
              className="h-1 w-1 rounded-full bg-accent/64"
            />
          ) : null}
        </button>
      </div>
    </header>
  );
}
