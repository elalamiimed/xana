/**
 * The life state, as the model reads it.
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * It used to be a function inside `mind/index.ts`. The agent loop needs it - it
 * renders the same state for the same reason - and importing `./index` from
 * `./agent` would have closed a cycle, because `index.ts` is what calls the
 * agent. Extracting one pure function is cheaper than a dynamic import, and it
 * makes the prompt layout something a test can assert on directly rather than
 * through the whole turn.
 *
 * WHAT THIS IS FOR
 *
 * Token budget matters more than completeness, so every line earns its place:
 * a model given a wall of text attends to the wrong part of it, and one given
 * too little invents the rest. The order is stable and deliberate - what is
 * happening now, then the day, then work, then the body, then what was
 * remembered - because a stable prefix is also what makes the provider's prompt
 * cache hit, and a hit costs a fiftieth of a miss.
 *
 * The one rule it obeys that is not about tokens: **recalled memories are split
 * by why they are here.** A memory is surfaced either because the user pinned it
 * as always-true or because it matched what was just said. Presenting them in
 * one list invites a model to answer a question about budgets with a sentence
 * about the spare key, so the two blocks are labelled and the pinned one says
 * outright that it is background and not an answer.
 */

import type { LifeState } from "../core/types";

export function renderLifeState(state: LifeState): string {
  const lines: string[] = [];

  lines.push(`NOW: ${state.generatedAt} (${state.partOfDay}). ${state.headline}`);

  if (state.calendar.today.length > 0) {
    lines.push("CALENDAR TODAY:");
    for (const e of state.calendar.today.slice(0, 8)) {
      const time = e.allDay ? "all day" : clock(e.start);
      lines.push(`  ${time} ${e.title}${e.location ? ` @ ${e.location}` : ""}${e.attendees?.length ? ` with ${e.attendees.join(", ")}` : ""}`);
    }
    lines.push(`  free: ${Math.round(state.calendar.freeMinutes)}m`);
  } else {
    lines.push("CALENDAR TODAY: clear");
  }

  if (state.calendar.next) {
    lines.push(`NEXT: ${state.calendar.next.title} at ${clock(state.calendar.next.start)}`);
  }

  lines.push(`TASKS: ${state.tasks.openCount} open, ${state.tasks.completedThisWeek} done this week`);
  if (state.tasks.overdue.length) {
    lines.push(`  overdue: ${state.tasks.overdue.slice(0, 4).map((t) => t.title).join("; ")}`);
  }
  if (state.tasks.focus.length) {
    lines.push("  focus order:");
    for (const t of state.tasks.focus.slice(0, 5)) {
      lines.push(`    - ${t.title}${t.due ? ` (due ${day(t.due)})` : ""}${t.project ? ` [${t.project}]` : ""}`);
    }
  }

  lines.push(`ENERGY: ${state.energy.score}/100 (${state.energy.band}). ${state.energy.note}`);

  if (state.habits.length) {
    lines.push(
      `HABITS: ${state.habits.map((h) => `${h.name} ${h.thisWeek}/${h.targetPerWeek}${h.atRisk ? " AT RISK" : ""}${h.streak > 1 ? ` (${h.streak}d streak)` : ""}`).join("; ")}`,
    );
  }

  if (state.goals.length) {
    lines.push("GOALS:");
    for (const { goal, progress } of state.goals.slice(0, 6)) {
      lines.push(
        `  - ${goal.title} (${goal.horizon}) ${Math.round(progress.progress * 100)}% ${progress.pace}${progress.daysRemaining !== undefined ? `, ${progress.daysRemaining}d left` : ""}`,
      );
    }
  }

  const h = state.health;
  const healthBits: string[] = [];
  if (h.latest?.sleepHours !== undefined) healthBits.push(`last night ${h.latest.sleepHours.toFixed(1)}h sleep`);
  if (h.sleepAvgHours !== undefined) healthBits.push(`7d avg ${h.sleepAvgHours.toFixed(1)}h`);
  if (h.sleepDebtHours > 1) healthBits.push(`${h.sleepDebtHours.toFixed(1)}h debt`);
  if (h.latest?.steps !== undefined) healthBits.push(`${h.latest.steps} steps`);
  if (h.latest?.mood) healthBits.push(`mood ${h.latest.mood}`);
  if (healthBits.length) lines.push(`HEALTH: ${healthBits.join(", ")}`);

  if (state.weather && !state.weather.synthetic) {
    lines.push(
      `WEATHER: ${state.weather.temperatureC}°C ${state.weather.condition} in ${state.weather.location}, high ${state.weather.highC}° low ${state.weather.lowC}°`,
    );
  }

  if (state.media?.nowPlaying) {
    lines.push(`PLAYING: ${state.media.nowPlaying}${state.media.artist ? ` — ${state.media.artist}` : ""}`);
  }

  if (state.finance.length) {
    lines.push(`MARKETS: ${state.finance.map((f) => `${f.label} ${f.value}`).join("; ")}`);
  }

  if (state.mail.length) {
    lines.push(`MAIL: ${state.mail.map((m) => `"${m.subject}" from ${m.from}${m.needsReply ? " (needs reply)" : ""}`).join("; ")}`);
  }

  if (state.patterns.length) {
    lines.push("PATTERNS (things you noticed, with evidence):");
    for (const p of state.patterns.slice(0, 3)) {
      lines.push(
        `  - ${p.observation} [${Math.round(p.confidence * 100)}% — ${p.basis}; evidence: ${p.evidence.join("; ")}]`,
      );
    }
  }

  if (state.nudges.length) {
    lines.push(`PENDING NUDGES: ${state.nudges.map((n) => `(${n.tone}) ${n.text}`).join(" | ")}`);
  }

  /**
   * Recalled memories, split by *why* each one is here.
   *
   * The distinction is not cosmetic. A pinned memory was surfaced because the
   * user marked it as important, and it may be entirely unrelated to the
   * question asked — the spare key is under the blue pot, whatever you asked.
   * A matched memory is here because it is relevant. Presenting them in one
   * undifferentiated list invites a model to treat the pinned block as
   * context for the current question, and to answer a question about budgets
   * with a sentence about a key.
   */
  if (state.memory.length) {
    const pinned = state.memory.filter((m) => m.memory.pinned);
    const matched = state.memory.filter((m) => !m.memory.pinned);

    if (matched.length) {
      lines.push("RECALLED MEMORIES (matched to this conversation):");
      for (const m of matched.slice(0, 5)) {
        lines.push(`  - [${m.memory.kind}] ${m.memory.title}: ${m.memory.content.slice(0, 200)}`);
      }
    }
    if (pinned.length) {
      lines.push(
        "STANDING FACTS (the user pinned these as always-true; they are background, not an answer to the current question. Never recite them unprompted, and never treat them as relevant just because they are here):",
      );
      for (const m of pinned.slice(0, 5)) {
        lines.push(`  - [${m.memory.kind}] ${m.memory.title}: ${m.memory.content.slice(0, 200)}`);
      }
    }
  }

  return lines.join("\n");
}

function clock(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
