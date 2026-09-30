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
import { localBriefingReply, localBriefingSections } from "@/lib/mind/local";
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
    focus: { sessionsThisWeek: [], totalMinutes: 0, lastSession: undefined },
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

/* ------------------------------------------------------------------ */
/* The sections read the right source                                  */
/* ------------------------------------------------------------------ */

console.log("\nWhat each section is reading\n");

/**
 * Focus is the focus log, not the task list.
 *
 * The section used to print the top task and label it "working", which is a
 * claim about what someone is doing drawn from what they wrote down. The focus
 * log is the real answer — label, duration, media — and it was already in the
 * life state, unread.
 */
const withLog = state({
  focus: {
    sessionsThisWeek: [
      {
        id: "f1",
        label: "Review Sam's parser PR",
        startedAt: new Date().toISOString(),
        minutes: 45,
        media: "Aurora",
        completed: false,
      },
    ],
    totalMinutes: 105,
  } as never,
  tasks: {
    focus: [{ id: "t1", title: "Send Mom the photos", priority: 3, source: "local" }] as never,
    overdue: [],
    openCount: 1,
    completedThisWeek: 0,
  } as never,
});

const focusSection = localBriefingSections(withLog).find((s) => s.kind === "focus");
check(
  "the focus section reports the logged session",
  Boolean(focusSection && focusSection.kind === "focus" && focusSection.session?.label === "Review Sam's parser PR"),
  JSON.stringify(focusSection),
);
check(
  "and its duration and media, which the task list cannot know",
  Boolean(focusSection && focusSection.kind === "focus" && focusSection.session?.minutes === 45 && focusSection.session?.media === "Aurora"),
);
check(
  "and the week's focused time",
  Boolean(focusSection && focusSection.kind === "focus" && focusSection.weekMinutes === 105),
);
check(
  "a queued task does not compete with a session in progress",
  Boolean(focusSection && focusSection.kind === "focus" && focusSection.queued === undefined),
  JSON.stringify(focusSection?.kind === "focus" ? focusSection.queued : null),
);

// With no log and nothing live, the queued task is the honest thing to show —
// and it is labelled as what it is rather than as current work.
const noLog = state({
  focus: { sessionsThisWeek: [], totalMinutes: 0 } as never,
  tasks: {
    focus: [{ id: "t1", title: "Send Mom the photos", priority: 3, source: "local" }] as never,
    overdue: [],
    openCount: 1,
    completedThisWeek: 0,
  } as never,
});
const queuedOnly = localBriefingSections(noLog).find((s) => s.kind === "focus");
check(
  "with nothing logged, the next task is shown",
  Boolean(queuedOnly && queuedOnly.kind === "focus" && queuedOnly.queued?.title === "Send Mom the photos"),
);
check(
  "and it is not passed off as the session",
  Boolean(queuedOnly && queuedOnly.kind === "focus" && queuedOnly.session === undefined),
);

/**
 * A session still open is a different claim from one already closed.
 *
 * The live payload showed the flaw: it read "writing the launch post" for a
 * session that had been completed, which reads as "this is what you are on".
 * An unfinished session is preferred, and the renderer says which it is.
 */
const withOpenAndClosed = state({
  focus: {
    sessionsThisWeek: [
      { id: "f2", label: "Review Sam's parser PR", startedAt: new Date().toISOString(), minutes: 45, completed: true },
      { id: "f1", label: "Draft the launch post outline", startedAt: new Date().toISOString(), minutes: 60, completed: false },
    ],
    totalMinutes: 105,
  } as never,
});
const openSession = localBriefingSections(withOpenAndClosed).find((s) => s.kind === "focus");
check(
  "an unfinished session is preferred over a closed one",
  Boolean(openSession && openSession.kind === "focus" && openSession.session?.label === "Draft the launch post outline"),
  JSON.stringify(openSession?.kind === "focus" ? openSession.session : null),
);
check(
  "and it is reported as in progress, not as done",
  Boolean(openSession && openSession.kind === "focus" && openSession.session?.completed === false),
);

const closedOnly = state({
  focus: {
    sessionsThisWeek: [
      { id: "f1", label: "Review Sam's parser PR", startedAt: new Date().toISOString(), minutes: 45, completed: true },
    ],
    totalMinutes: 45,
  } as never,
});
const closed = localBriefingSections(closedOnly).find((s) => s.kind === "focus");
check(
  "with only closed sessions, the last one is shown and marked completed",
  Boolean(closed && closed.kind === "focus" && closed.session?.completed === true),
  JSON.stringify(closed?.kind === "focus" ? closed.session : null),
);

/**
 * A detector finding is never shown as bare numbers.
 *
 * The demo caught this: without a model the section rendered the evidence list
 * alone — "current 7; longest 7; 3/7 this week" — with nothing saying what the
 * numbers were about, because the detector's own sentence was not passed
 * through.
 */
const withPattern = state({
  patterns: [
    {
      id: "p1",
      key: "habit-at-risk-h",
      observation: "7 days on meditation. That's the longest run you have.",
      confidence: 0.42,
      basis: "how firmly a 7-day run predicts the next week",
      evidence: ["3 of 7 this week"],
      detectedAt: new Date().toISOString(),
    },
  ] as never,
});

const patternSection = localBriefingSections(withPattern).find((s) => s.kind === "pattern");
check(
  "a detector finding carries its sentence, not only its numbers",
  Boolean(patternSection && patternSection.kind === "pattern" && /\w/.test(patternSection.analysis ?? "")),
  JSON.stringify(patternSection),
);
check(
  "and is labelled as the detector's",
  Boolean(patternSection && patternSection.kind === "pattern" && patternSection.detectedBy === "detector"),
);
check(
  "and states what its figure measures",
  Boolean(patternSection && patternSection.kind === "pattern" && /\w/.test(patternSection.basis ?? "")),
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
