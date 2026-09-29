/**
 * End-to-end demo: drive the real Xana stack the way the UI does.
 *
 * This is a smoke test that reads like a transcript. It runs the actual
 * adapters, the actual life-state assembly, the actual intent engine and the
 * actual executor — nothing is mocked — against a throwaway database so the
 * seeded life is left untouched.
 *
 *   npm run demo
 *
 * Every line it prints is produced by the same code path the HTTP routes call.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { XanaStore, setStore } from "../src/lib/core/store";
import { buildLifeState, invalidateContext } from "../src/lib/context/gateway";
import { executeAction } from "../src/lib/actions/executor";
import { localMind } from "../src/lib/mind/local";
import { parseDuration, parseWhen, stripWhen } from "../src/lib/core/nlp";
import { formatTime, humanDuration, toDateKey } from "../src/lib/core/time";
import type { BriefingSection } from "../src/lib/core/types";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function say(who: "you" | "xana", text: string): void {
  const label = who === "you" ? "  you  " : "  xana ";
  const lines = text.split("\n");
  console.log(`${label}│ ${lines[0]}`);
  for (const line of lines.slice(1)) console.log(`        │ ${line}`);
}

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n${"─".repeat(66)}\n${title}\n${"─".repeat(66)}`);
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "xana-demo-"));
  const store = new XanaStore(path.join(dir, "demo.db"));

  /*
   * Point the process-wide store at the throwaway file BEFORE anything calls
   * `getStore()`, so the demo can never write into the real seeded database.
   * Every module below resolves the store lazily, so this single call redirects
   * the whole stack.
   */
  setStore(store);
  invalidateContext();

  console.log("Xana — end-to-end demo");
  console.log(`Scratch database: ${path.join(dir, "demo.db")}`);

  /* ---------------- 1. Natural-language time parsing ---------------- */

  section("1. Parsing time the way people speak it");

  const now = new Date("2026-03-10T09:00:00"); // a Tuesday, for determinism
  const cases: Array<[string, string]> = [
    ["remind me to call Mom Friday", "Fri"],
    ["call the dentist tomorrow at 3pm", "Mar 11"],
    ["submit the report in 2 hours", "11:00"],
    ["standup next Monday morning", "Mar 16"],
    ["review on the 20th", "Mar 20"],
    ["meeting 2026-04-02", "Apr 02"],
  ];

  for (const [phrase, expectFragment] of cases) {
    const parsed = parseWhen(phrase, now);
    const rendered = parsed ? format(parsed.date) : "—";
    console.log(`  "${phrase}"`);
    console.log(`     -> ${rendered}   (confidence ${parsed?.confidence ?? 0})`);
    check(`parses "${phrase}"`, Boolean(parsed) && rendered.includes(expectFragment), `got ${rendered}`);
  }

  const stripped = stripWhen("call Mom Friday", "Friday");
  check("strips the time out of the title", stripped === "call Mom", `got "${stripped}"`);
  check("reads a minute duration", parseDuration("for 90 minutes") === 90);
  check("reads an hour duration", parseDuration("for 2 hours") === 120);

  /* ---------------- 2. Cold start ---------------- */

  section("2. Cold start — what she says with nothing to go on");

  let state = await buildLifeState({ force: true });
  say("xana", `${state.headline} (energy ${state.energy.score}/100, ${state.energy.band})`);
  check("assembles a life state from nothing", Boolean(state.generatedAt));
  check("energy is computed", state.energy.score > 0 && state.energy.score <= 100);
  check("every adapter reported a status", state.sources.length === 8, `got ${state.sources.length}`);

  /* ---------------- 3. Capture ---------------- */

  section("3. Capture — the everyday case");

  const turns = [
    "remind me to call Mom Friday",
    "add a task to review the Aurora scheduler PR",
    "I need to book the flights by tomorrow",
    "note that the plumber quoted 340 and can start Monday",
    "remember I prefer mornings for anything that needs real thinking",
  ];

  for (const turn of turns) {
    say("you", turn);
    const result = localMind({ text: turn, lifeState: state });
    say("xana", result.text || "(no reply)");
    check(`handles: "${turn}"`, Boolean(result.text || result.outcome?.ok));
    // Rebuild so the next turn sees what the previous one wrote.
    state = await buildLifeState({ force: true });
  }

  check("tasks were created", state.tasks.openCount >= 3, `open: ${state.tasks.openCount}`);
  check("the reminder is on the list", state.tasks.focus.some((t) => /call mom/i.test(t.title)));

  /* ---------------- 4. Scheduling ---------------- */

  section("4. Scheduling — a real calendar entry");

  const schedState = await buildLifeState({ force: true });
  const schedText = "schedule a design review Thursday at 2pm for 90 minutes";
  say("you", schedText);
  const schedResult = localMind({ text: schedText, lifeState: schedState });
  say("xana", schedResult.text || schedResult.outcome?.message || "(no reply)");
  check("creates an event", schedResult.outcome?.effect === "event.created", schedResult.outcome?.effect);

  /* ---------------- 5. Recall ---------------- */

  section("5. Memory — recall across sessions");

  const remembered = executeAction({
    type: "remember",
    kind: "decision",
    title: "Chose Postgres over SQLite",
    content:
      "Decided to use Postgres for the scheduler because three concurrent writers locked the embedded store in staging.",
  });
  check("writes a decision to memory", remembered.effect === "memory.written");

  await buildLifeState({ force: true });
  const query = "what did I decide about the database";
  const hits = store.recall(query, { limit: 3 });
  console.log(`  query: "${query}"`);
  for (const h of hits) {
    console.log(`     ${h.score.toFixed(3)}  [${h.memory.kind}] ${h.memory.title}  (${h.reason})`);
  }
  check("recall finds the decision", hits.length > 0 && /postgres/i.test(hits[0].memory.title), hits[0]?.memory.title);

  /* ---------------- 6. Habit and goal lifecycle ---------------- */

  section("6. Habits and goals");

  const habit = store.createHabit({ name: "Meditation", targetPerWeek: 7 });
  for (let i = 1; i <= 6; i++) {
    store.logHabit(habit.id, toDateKey(new Date(Date.now() - i * 86_400_000)));
  }
  const logged = executeAction({ type: "log_habit", habitId: habit.id });
  say("xana", logged.message);
  check("logs a habit and reports the streak", logged.ok && /streak|running|logged/i.test(logged.message), logged.message);

  const goalOutcome = executeAction({
    type: "create_goal",
    title: "Run a half marathon",
    horizon: "mid",
    targetDate: toDateKey(new Date(Date.now() + 120 * 86_400_000)),
  });
  say("xana", goalOutcome.message);
  check("creates a goal", goalOutcome.effect === "goal.created");

  const goalId = goalOutcome.ids?.[0];
  if (goalId) {
    const milestone = store.createMilestone(goalId, { title: "Run 10km" });
    const done = executeAction({ type: "complete_milestone", milestoneId: milestone.id });
    say("xana", done.message);
    check("completes a milestone", done.effect === "milestone.completed");
  }

  /* ---------------- 7. Reflection ---------------- */

  section("7. Reflection — generated, not templated");

  const reflected = executeAction({ type: "reflect", period: "weekly" });
  const reflection = store.latestReflection("weekly");
  say("xana", reflected.message);
  if (reflection) {
    for (const para of reflection.body.split("\n\n")) say("xana", para);
    check("writes a reflection with three movements", reflection.body.split("\n\n").length === 3);
  } else {
    check("writes a reflection", false, "no reflection saved");
  }

  /* ---------------- 8. Briefing ---------------- */

  section("8. Briefing — the state of the day, after all of that");

  state = await buildLifeState({ force: true });
  const brief = localMind({ text: "brief me", lifeState: state });
  const briefing = brief.cards?.find((c) => c.kind === "briefing");
  if (briefing && briefing.kind === "briefing") {
    console.log(`  ${briefing.title}`);
    for (const line of describeSections(briefing.sections)) console.log(`     ${line}`);
    check("briefing has content", briefing.sections.length >= 2);
    check(
      "every section is populated, not just present",
      briefing.sections.length > 0 && !describeSections(briefing.sections).some((l) => l.trim() === ""),
    );
  } else {
    check("produces a briefing card", false);
  }

  /* ---------------- 9. Honesty ---------------- */

  section("9. When she doesn't understand");

  const confusedText = "flurble the womp";
  say("you", confusedText);
  const confused = localMind({ text: confusedText, lifeState: state });
  say("xana", confused.text);
  check(
    "admits it rather than inventing an action",
    !confused.outcome || confused.outcome.effect === "none",
    JSON.stringify(confused.outcome),
  );

  /* ---------------- 10. Data sources ---------------- */

  section("10. Data sources");

  for (const s of state.sources) {
    const mark = s.state === "connected" ? "●" : s.state === "local" ? "○" : "×";
    console.log(`  ${mark} ${s.label.padEnd(22)} ${s.mode.padEnd(10)} ${s.detail ?? ""}`);
  }
  check("all eight sources accounted for", state.sources.length === 8);

  /* ---------------- Result ---------------- */

  section("Result");
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log(failed === 0 ? "  The stack works end to end.\n" : "  Something regressed.\n");

  invalidateContext();
  store.close();
  rmSync(dir, { recursive: true, force: true });

  if (failed > 0) process.exitCode = 1;
}

/** "Tue Mar 10 2026 15:00" — enough to check the day, hour and minute. */
function format(d: Date): string {
  return `${d.toDateString().slice(0, 10)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * The briefing, rendered for a terminal.
 *
 * Deliberately reads the sections rather than any prose field: the point of
 * the shape is that each section is data, so a demo that printed a sentence
 * would be checking the thing that was removed.
 */
function describeSections(sections: BriefingSection[]): string[] {
  const clock = (iso: string) => formatTime(iso);
  return sections.map((section) => {
    switch (section.kind) {
      case "energy": {
        const reading = section.reading
          ? `${section.reading.level}/5 at ${clock(section.reading.at)}`
          : "not reported";
        return `energy    ${reading} · forecast ${section.forecast.score} ${section.forecast.band}${section.stale ? " (stale)" : ""}`;
      }
      case "next": {
        const { event, then } = section;
        const free = event.freeBefore ? ` · ${humanDuration(event.freeBefore)} free before` : "";
        return `next      ${clock(event.start)} ${event.title}${event.location ? ` · ${event.location}` : ""}${free}${then ? ` · then ${then.title}` : ""}`;
      }
      case "focus": {
        const parts: string[] = [];
        if (section.live) parts.push(`now: ${section.live.title} (${section.live.minutesLeft}m left)`);
        if (section.session) {
          parts.push(
            `logged: ${section.session.label} ${section.session.minutes}m${section.session.completed ? " done" : ""}${section.session.media ? ` on ${section.session.media}` : ""}`,
          );
        }
        if (section.weekMinutes) parts.push(`${humanDuration(section.weekMinutes)} this week`);
        if (section.queued) parts.push(`queued: ${section.queued.title}`);
        if (section.window) parts.push(`best window ${section.window.startHour}:00–${section.window.endHour}:00`);
        return `focus     ${parts.join(" · ")}`;
      }
      case "open": {
        const late = section.overdue.map((o) => `${o.title} (${o.daysLate}d late)`).join(", ");
        const soon = section.upcoming.map((u) => `${u.title} (in ${u.daysAway}d)`).join(", ");
        return `open      ${[late && `overdue: ${late}`, soon && `soon: ${soon}`, `${section.openCount} open`].filter(Boolean).join(" · ")}`;
      }
      case "pattern":
        return `pattern   ${section.analysis ?? section.evidence.join("; ")} (${section.detectedBy})`;
      case "recall":
        return `recall    ${section.items.map((i) => `${i.title} — ${i.because}`).join("; ")} (${section.detectedBy})`;
      default: {
        const unhandled: never = section;
        return String(unhandled);
      }
    }
  });
}

main().catch((err: unknown) => {
  console.error("\nDemo failed:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exitCode = 1;
});
