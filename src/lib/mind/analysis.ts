/**
 * What the model makes of the user's patterns and memories.
 *
 * The detector in `derived/patterns.ts` measures things and states them: "your
 * meditation streak is 26 days and needs 5 more this week to hold". That is a
 * fact, and it is the right thing for a template to produce — it is arithmetic
 * with words around it.
 *
 * What a template cannot do is the part that needs thinking: noticing that the
 * two facts it just produced are about the same week, or that a memory from
 * last month explains why the streak broke. That is what this asks the model
 * for, and it is the reason the briefing is worth opening twice a day.
 *
 * THE RULES THIS OBEYS
 *
 *  - **Facts in, reading out.** The model is given the detector's own
 *    observations and the user's actual memories. It is asked to select and
 *    connect them, never to invent one. Anything it returns that does not
 *    correspond to a fact it was given is a fabrication, and the prompt says
 *    so in those words.
 *  - **No model, no invention.** With no key configured this returns
 *    `undefined`, and the briefing shows the detector's raw evidence under a
 *    label saying where it came from. A quieter Xana is correct; a Xana
 *    making up an insight is not.
 *  - **Failure is silent to the user and loud in the log.** A model that
 *    times out must not cost the briefing its other four sections.
 */

import type { Analysis, LifeState } from "../core/types";
import { llmAvailable, llmComplete, type LlmMessage } from "./llm";
import { nowIso } from "../core/time";

export type { Analysis };

/** How long we will wait before giving up and showing the detector alone. */
const TIMEOUT_MS = 12_000;

const SYSTEM = `You are the analytical part of a personal assistant. You are given MEASURED FACTS about one person's habits, work and calendar, and a list of things you remember about them. You return a JSON object and nothing else.

Rules, in order of importance:

1. Never invent a fact. Every claim you make must be traceable to one of the measured facts or memories you were given. If they do not support a claim, make no claim.
2. Prefer a connection between two given facts over a restatement of one. The person can already read the list; what they cannot do is notice that two entries are about the same thing.
3. If nothing given supports an insight, return an empty object. An empty answer is a correct answer.
4. Plain, declarative sentences in the second person. No preamble, no hedging, no exclamation marks, no emoji, no markdown, no advice about productivity in general — only what these facts imply about this person.

Return exactly this shape:
{
  "pattern": {
    "analysis": "one or two sentences connecting the facts",
    "evidence": ["the specific facts you used, quoted from the input"],
    "suggestion": "one short sentence, or omit"
  },
  "recall": [
    {
      "title": "the memory's title, exactly as given",
      "because": "why this is worth surfacing right now, in one clause"
    }
  ]
}

Include "pattern" only if something in the facts genuinely supports it. Include at most two items in "recall", and only memories that are worth being reminded of today — something forgotten, due, or newly relevant. Omit "recall" entirely if nothing qualifies.`;

export interface AnalysisInput {
  lifeState: LifeState;
  /** Skip the model even when one is configured. */
  forceLocal?: boolean;
}

/**
 * Ask the model for a reading of the measured facts.
 *
 * Returns `undefined` when there is no model, when the model fails, or when it
 * says nothing worth saying. All three are the same to the caller: the
 * briefing keeps its measured sections and shows the detector's own evidence.
 */
export async function analyseLifeState(input: AnalysisInput): Promise<Analysis | undefined> {
  const { lifeState } = input;
  if (input.forceLocal || !llmAvailable()) return undefined;

  const patterns = lifeState.patterns.slice(0, 4);
  const memories = lifeState.memory.filter((m) => !m.memory.pinned).slice(0, 8);
  const latestHealth = lifeState.health.latest;
  const healthSignalCount = [
    lifeState.health.sleepAvgHours,
    latestHealth?.energy,
    latestHealth?.mood,
    latestHealth?.meals,
    latestHealth?.activeMinutes,
    latestHealth?.steps,
  ].filter((value) => value !== undefined).length;
  if (patterns.length === 0 && memories.length === 0 && healthSignalCount < 2) return undefined;

  const facts: string[] = [];

  if (patterns.length > 0) {
    facts.push("MEASURED PATTERNS:");
    for (const p of patterns) {
      const evidence = p.evidence.length > 0 ? ` (evidence: ${p.evidence.join("; ")})` : "";
      // The basis travels with the figure, so the model can weigh a 62% that
      // means "a 26-day run" differently from a 90% that means "the day is
      // booked" — and so it cannot mistake either for a probability.
      facts.push(`  - ${p.observation}${evidence} [${Math.round(p.confidence * 100)}% — ${p.basis}]`);
    }
  }

  if (lifeState.habits.length > 0) {
    facts.push("HABITS:");
    for (const h of lifeState.habits.slice(0, 6)) {
      facts.push(
        `  - ${h.name}: ${h.streak}-day streak, ${h.thisWeek} of ${h.targetPerWeek} this week${h.atRisk ? ", at risk" : ""}`,
      );
    }
  }

  if (lifeState.tasks.overdue.length > 0) {
    facts.push(
      `OVERDUE: ${lifeState.tasks.overdue.map((t) => t.title).join("; ")}`,
    );
  }

  if (lifeState.goals.length > 0) {
    facts.push("GOALS:");
    for (const { goal, progress } of lifeState.goals.slice(0, 5)) {
      facts.push(`  - ${goal.title}: ${progress.pace}, ${Math.round(progress.progress * 100)}%`);
    }
  }

  const health = lifeState.health;
  const healthBits = [
    typeof health.sleepAvgHours === "number" ? `sleep averaging ${health.sleepAvgHours.toFixed(1)}h` : null,
    health.sleepDebtHours > 0 ? `${health.sleepDebtHours.toFixed(1)}h sleep debt` : null,
    typeof health.latest?.energy === "number"
      ? `they report their energy as ${health.latest.energy}/5`
      : null,
    health.latest?.mood ? `current mood is ${health.latest.mood}` : null,
    typeof health.latest?.meals === "number" ? `${health.latest.meals} of 3 meals logged today` : null,
    typeof health.latest?.activeMinutes === "number"
      ? `${health.latest.activeMinutes} active minutes today`
      : typeof health.latest?.steps === "number"
        ? `${health.latest.steps} steps today`
        : null,
  ].filter(Boolean);
  if (healthBits.length > 0) facts.push(`HEALTH: ${healthBits.join("; ")}`);

  if (memories.length > 0) {
    facts.push("THINGS YOU REMEMBER ABOUT THEM:");
    for (const m of memories) {
      facts.push(`  - [${m.memory.kind}] ${m.memory.title}: ${m.memory.content.slice(0, 220)}`);
    }
  }

  const messages: LlmMessage[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: facts.join("\n") },
  ];

  let raw: string;
  try {
    const result = await llmComplete(messages, {
      maxTokens: 500,
      temperature: 0.3,
      timeoutMs: TIMEOUT_MS,
    });
    raw = result.text;
  } catch (err) {
    // A model that is slow, down or refusing must not cost the briefing its
    // other sections. The detector's own evidence is shown instead, and the
    // reason is left in the log rather than on the card.
    console.warn(
      `[xana] pattern analysis skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }

  const parsed = parseAnalysis(raw, lifeState);
  if (!parsed) return undefined;
  if (!parsed.pattern && !parsed.recall?.length) return undefined;

  return {
    ...parsed,
    considered: { patterns: patterns.length, memories: memories.length },
    at: nowIso(),
  };
}

/**
 * Read the model's answer, and throw away anything it was not entitled to say.
 *
 * Two things are enforced here rather than trusted:
 *
 *  - **The shape.** A model asked for JSON returns JSON most of the time, and
 *    occasionally wraps it in a sentence or a code fence. Both are recovered;
 *    anything else is treated as no answer.
 *  - **The provenance of a recall.** A returned memory is matched back to one
 *    that was actually supplied, by title. A model that invents a memory — or
 *    paraphrases a title into something the user never wrote — is dropped
 *    rather than shown. This is the one place a fabrication would be
 *    indistinguishable from a real memory, so it is checked, not hoped for.
 */
export function parseAnalysis(
  raw: string,
  lifeState: LifeState,
): Omit<Analysis, "considered" | "at"> | undefined {
  const json = extractJson(raw);
  if (!json) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const shape = parsed as {
    pattern?: { analysis?: unknown; evidence?: unknown; suggestion?: unknown };
    recall?: unknown;
  };

  const out: Omit<Analysis, "considered" | "at"> = {};

  const analysis = typeof shape.pattern?.analysis === "string" ? shape.pattern.analysis.trim() : "";
  if (analysis) {
    const detector = lifeState.patterns[0];
    out.pattern = {
      analysis,
      evidence: Array.isArray(shape.pattern?.evidence)
        ? shape.pattern.evidence.filter((e): e is string => typeof e === "string").slice(0, 4)
        : (detector?.evidence ?? []),
      // From the detector, never from the model. It has no way to know how
      // strong the evidence is, and a number it made up would read as a
      // measurement. The basis comes with it so the figure keeps its subject.
      confidence: detector?.confidence,
      basis: detector?.basis,
      suggestion:
        typeof shape.pattern?.suggestion === "string" ? shape.pattern.suggestion.trim() : undefined,
    };
  }

  if (Array.isArray(shape.recall)) {
    const known = new Map(lifeState.memory.map((m) => [m.memory.title.toLowerCase(), m.memory]));
    const recalled: NonNullable<Analysis["recall"]> = [];
    for (const entry of shape.recall) {
      if (typeof entry !== "object" || entry === null) continue;
      const candidate = entry as { title?: unknown; because?: unknown };
      if (typeof candidate.title !== "string") continue;
      const memory = known.get(candidate.title.trim().toLowerCase());
      if (!memory) continue;
      recalled.push({
        id: memory.id,
        title: memory.title,
        content: memory.content.slice(0, 240),
        because:
          typeof candidate.because === "string" && candidate.because.trim()
            ? candidate.because.trim()
            : "from your memory",
      });
      if (recalled.length === 2) break;
    }
    if (recalled.length > 0) out.recall = recalled;
  }

  return out;
}

/** The first JSON object in a string, tolerating a fence or a lead-in sentence. */
function extractJson(raw: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const text = fenced ? fenced[1] : raw;
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  // Walk to the matching brace so trailing prose does not break the parse.
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}
