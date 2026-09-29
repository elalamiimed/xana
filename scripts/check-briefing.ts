/**
 * Is the briefing actually assembled from the life state?
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-briefing.ts
 *
 * The failure this guards against is a reply that is a constant dressed up as
 * a sentence: "Here's the shape of it." read perfectly well and was identical
 * every single day. So the assertion is not that the reply is well-formed —
 * it is that it CHANGES when the state changes, and that the change is the
 * one the state implies.
 *
 * Nothing here is a snapshot of today's prose. Pinning the exact wording would
 * recreate the bug in a different file: the reply is allowed to be reworded,
 * it is not allowed to stop listening.
 */

import { localMind } from "@/lib/mind/local";
import { localBriefingReply } from "@/lib/mind/local";
import type { LifeState } from "@/lib/core/types";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A state with everything empty, then overridden per case. */
function state(overrides: Partial<LifeState> = {}): LifeState {
  const base = {
    generatedAt: new Date().toISOString(),
    partOfDay: "morning",
    headline: "Nothing scheduled. A clear day.",
    calendar: { today: [], next: undefined, freeMinutes: 0 },
    tasks: { focus: [], overdue: [], openCount: 0, completedThisWeek: 0 },
    habits: [],
    goals: [],
    health: { latest: undefined, sleepAvgHours: undefined, moodTrend: [], sleepDebtHours: 0 },
    weather: undefined,
    media: undefined,
    finance: undefined,
    mail: undefined,
    patterns: [],
    energy: {
      score: 68,
      band: "steady",
      note: "A maintenance day. Move things forward, don't start wars.",
      windows: [],
    },
    nudges: [],
    sources: [],
    memory: [],
    focus: { sessionsThisWeek: 0, totalMinutes: 0, lastSession: undefined },
  } as unknown as LifeState;
  return { ...base, ...overrides } as LifeState;
}

const event = (title: string, start: string) =>
  ({ id: "e1", title, start, end: start, allDay: false }) as never;

console.log("\nBriefing reply — assembled, not selected\n");

const clear = state();
const busy = state({
  headline: "Standup at 09:30.",
  calendar: { today: [event("Standup", "09:30")], next: undefined, freeMinutes: 0 } as never,
});
const overdue = state({ headline: "One thing due today: send the invoice." });
const lowEnergy = state({
  headline: "Two things due today.",
  energy: {
    score: 31,
    band: "low",
    note: "Running short. Protect the morning and move the rest.",
    windows: [],
  } as never,
});

const replies = {
  clear: localBriefingReply(clear),
  busy: localBriefingReply(busy),
  overdue: localBriefingReply(overdue),
  lowEnergy: localBriefingReply(lowEnergy),
};

for (const [label, text] of Object.entries(replies)) {
  console.log(`  ${label.padEnd(10)} "${text}"`);
}
console.log("");

// 1. The load-bearing one: it cannot be a constant.
const distinct = new Set(Object.values(replies));
check(
  "a different day produces a different briefing",
  distinct.size === Object.keys(replies).length,
  `${distinct.size} distinct replies for ${Object.keys(replies).length} states`,
);

// 2. It carries the state's own facts, not a paraphrase of them.
check("the imminent event is named", replies.busy.includes("Standup"), replies.busy);
check("the overdue task is named", replies.overdue.includes("send the invoice"), replies.overdue);

// 3. Low energy is mentioned, and only when it is low.
check("low energy is surfaced", replies.lowEnergy.includes("Running short"), replies.lowEnergy);
check(
  "a steady day does not lecture about energy",
  !replies.clear.includes("maintenance"),
  replies.clear,
);

// 4. It does not restate the card. The card already lists focus, habits and
//    weather; the reply should stay a sentence or two.
for (const [label, text] of Object.entries(replies)) {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean).length;
  check(`${label}: at most two sentences`, sentences <= 2, `${sentences} sentences`);
}

// 5. Every briefing path goes through it. Both "brief me" and "what's my day"
//    used to return an empty string and inherit a fixed lead-in.
for (const utterance of ["brief me", "catch me up", "what's my day look like"]) {
  const out = localMind({ text: utterance, lifeState: busy, sessionId: "check" });
  const hasBriefing = (out.cards ?? []).some((c) => c.kind === "briefing");
  check(
    `"${utterance}" answers from the state`,
    hasBriefing && out.text.includes("Standup"),
    `text="${out.text}" cards=${(out.cards ?? []).length}`,
  );
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
