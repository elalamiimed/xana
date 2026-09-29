/**
 * The mind — Xana's decision layer.
 *
 * One entry point, `think()`, which picks between two engines:
 *
 *   1. **llm** — when a key is configured. She gets the life state as a compact
 *      briefing plus the memories recall surfaced, and answers in her voice.
 *      Actions still run through the local intent engine first, so a model can
 *      never invent a calendar entry that does not get written the same way
 *      every time.
 *   2. **local** — the deterministic engine in ./local. No key, no network.
 *
 * The important structural choice: **intent resolution happens locally, always.**
 * The LLM shapes *what she says*, never *what she does*. That keeps every
 * write-back auditable and identical regardless of which engine is warm.
 */

import type { ChatRequest, ChatResponse, LifeState, Message } from "../core/types";
import { getStore } from "../core/store";
import { nowIso, uid } from "../core/time";
import { localMind, localBriefingSections, briefingCard, greetingFor, toMessage, type LocalMindOutput } from "./local";
import { analyseLifeState } from "./analysis";
import {
  llmAvailable,
  llmComplete,
  systemPrompt,
  type LlmMessage,
} from "./llm";
import { loadSettings } from "../settings/store";
import { rememberUtterance } from "../derived/memory";

export interface ThinkResult {
  message: Message;
  lifeState: LifeState;
}

export function currentEngine(): "llm" | "local" {
  return llmAvailable() ? "llm" : "local";
}

/**
 * Produce Xana's reply to a user turn.
 *
 * `lifeState` is passed in rather than built here so the route can share one
 * assembly across the request and return it alongside the message.
 */
export async function think(
  request: ChatRequest,
  lifeState: LifeState,
  opts: { forceLocal?: boolean } = {},
): Promise<ThinkResult> {
  const started = Date.now();
  const sessionId = request.sessionId ?? "default";
  const store = getStore();
  const text = request.message.trim();

  store.logMessage("user", text, sessionId);

  /* --- 1. Local intent resolution. This decides what happens. --- */
  const local = localMind({
    text,
    lifeState,
    sessionId,
    modality: request.modality,
  });

  const acted = Boolean(local.outcome?.ok);
  const refreshed = acted ? await refreshAfterAction(lifeState) : lifeState;

  /**
   * A briefing gets the model's reading of the measured facts.
   *
   * Only a briefing: this is the one reply whose whole job is to tell the user
   * something about their own life that they did not already know, so it is
   * the one place the extra call earns its latency.
   */
  if (local.cards?.some((c) => c.kind === "briefing")) {
    local.cards = await briefingWithAnalysis(refreshed);
  }

  /* --- 2. Remember anything durable the user just told us. --- */
  try {
    rememberUtterance(text, store, sessionId);
  } catch {
    // Memory writes are best-effort; never fail a turn over one.
  }

  /* --- 3. Choose the voice. --- */
  const useLlm = !opts.forceLocal && llmAvailable();

  if (!useLlm) {
    const message = toMessage(
      { ...local, text: local.text },
      "local",
      started,
    );
    store.logMessage("xana", message.text, sessionId, { engine: "local", effect: local.outcome?.effect });
    return { message, lifeState: refreshed };
  }

  try {
    const spoken = await speakWithModel({
      text,
      lifeState: refreshed,
      local,
      modality: request.modality,
    });

    const message: Message = {
      ...toMessage(local, "llm", started),
      text: spoken.trim() || local.text,
    };
    store.logMessage("xana", message.text, sessionId, {
      engine: "llm",
      effect: local.outcome?.effect,
    });
    return { message, lifeState: refreshed };
  } catch (err) {
    /**
     * Fall back rather than fail: an unreachable model should feel like a
     * quieter Xana, not a broken one.
     *
     * But it must not fall back *silently*. This catch previously discarded
     * the error entirely, which made three very different situations look
     * identical from the chat window: no model configured, the model
     * switched off, and the model configured but rejecting every request.
     * A user who has just pasted a key and sees `local` concludes the key
     * was ignored, when what actually happened is that the provider
     * answered 401.
     *
     * So the reason travels with the message, and it is logged.
     */
    const reason = describeModelFailure(err);
    console.warn(`[xana] model call failed, answering locally: ${reason}`);

    const message = toMessage(local, "local", started);
    message.text =
      local.text ||
      `I lost the connection to my own head for a moment. ${fallbackNotice(err)}`;
    message.modelError = reason;
    store.logMessage("xana", message.text, sessionId, { engine: "local-fallback" });
    return { message, lifeState: refreshed };
  }
}

/**
 * A one-line reason a model call failed, in the same vocabulary the
 * settings screen uses, so the two agree when the user goes to fix it.
 */
function describeModelFailure(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/abort|timed out/i.test(msg)) return "The model timed out. Your local mind still works.";
  if (/401|403|refused|unauthor/i.test(msg)) return "The provider rejected the API key.";
  if (/404|No such endpoint/i.test(msg)) return "The endpoint was not found. Check the base URL.";
  if (/429|rate limit/i.test(msg)) return "The provider is rate limiting. Try again shortly.";
  if (/ENOTFOUND|getaddrinfo|fetch failed|ECONNREFUSED/i.test(msg)) {
    return "The provider could not be reached.";
  }
  // Anything else: keep the provider's own words, trimmed, because they are
  // usually more specific than a category name.
  return msg.replace(/\s+/g, " ").slice(0, 160);
}

function fallbackNotice(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/abort|timed out/i.test(msg)) return "The model timed out. Your local mind still works.";
  return "Ask me again in a moment.";
}

async function refreshAfterAction(lifeState: LifeState): Promise<LifeState> {
  try {
    // The executor invalidated the gateway cache; rebuild so the UI reflects
    // the write immediately rather than on the next poll.
    const { buildLifeState } = await import("../context/gateway");
    return await buildLifeState({ force: true, skipIngest: true });
  } catch {
    return lifeState;
  }
}

/**
 * The briefing, with the model's reading of the measured facts when there is
 * one.
 *
 * This lives here rather than in the local mind because the local handlers are
 * synchronous by design — they are the deterministic path, and making them
 * await a network call would put the model in front of what she *does* rather
 * than only what she *says*.
 *
 * The analysis is additive. If there is no model, or it fails, or it has
 * nothing to say, the briefing still has its measured sections: energy, next,
 * focus, open, and the detector's own finding with its evidence attached.
 */
async function briefingWithAnalysis(state: LifeState): Promise<Message["cards"]> {
  const analysis = await analyseLifeState({ lifeState: state });
  return [
    {
      kind: "briefing",
      title: greetingFor(state.partOfDay),
      sections: localBriefingSections(state, new Date(), analysis),
      generatedAt: nowIso(),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Prompt construction                                                 */
/* ------------------------------------------------------------------ */

/** The persona, plus the two facts a model cannot infer: today's date and
 *  what she should call the user. Resolved per call so a Settings change
 *  lands on the next message rather than the next restart. */
function buildSystemPrompt(): string {
  const settings = loadSettings();
  const parts = [systemPrompt()];

  const name = settings.identity.name.trim();
  if (name) {
    parts.push(`You are speaking with ${name}. Use their name sparingly — once is usually enough.`);
  }

  const location = settings.identity.location.trim();
  if (location) parts.push(`They are in ${location}.`);

  // Without this a model happily reasons about "next Tuesday" relative to
  // its training cut-off. The life state carries `generatedAt`, but it sits
  // far down a long prompt and is easy to weight too lightly.
  const today = new Date();
  parts.push(
    `Today is ${today.toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    })}.`,
  );

  return parts.join("\n\n");
}

/** Render the life state compactly. Token budget matters more than completeness. */
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

/** Recent turns, so she has continuity without the whole transcript. */
function recentTurns(limit = 8): LlmMessage[] {
  const store = getStore();
  return store
    .recentConversation(limit)
    .filter((m) => m.role === "user" || m.role === "xana")
    .map((m) => ({ role: m.role === "xana" ? ("assistant" as const) : ("user" as const), content: m.text }));
}

interface SpeakInput {
  text: string;
  lifeState: LifeState;
  local: LocalMindOutput;
  modality?: "text" | "voice";
}

async function speakWithModel(input: SpeakInput): Promise<string> {
  const parts: string[] = [];

  parts.push(`LIFE STATE\n${renderLifeState(input.lifeState)}`);

  if (input.local.outcome) {
    const o = input.local.outcome;
    parts.push(
      `ACTION RESULT\nok: ${o.ok}\neffect: ${o.effect}${o.message ? `\nresult: ${o.message}` : ""}`,
    );
  }

  if (input.local.cards?.length) {
    parts.push(
      `CARDS ATTACHED TO YOUR REPLY (the UI renders these — do not read them out, just introduce them if useful)\n${input.local.cards
        .map((c) => `- ${c.kind}: ${c.title}`)
        .join("\n")}`,
    );
  }

  if (input.modality === "voice") {
    parts.push("MODALITY: voice. Keep the reply under 30 words. No lists, no markdown.");
  }

  const messages: LlmMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    ...recentTurns(6),
    { role: "user", content: `${parts.join("\n\n")}\n\nUSER SAID: ${input.text}` },
  ];

  const result = await llmComplete(messages, { maxTokens: 400, temperature: 0.7 });
  return stripMarkdown(result.text);
}

/** The UI renders plain text; markdown syntax reads as noise. */
function stripMarkdown(text: string): string {
  return text
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|\s)\*([^*]+)\*/g, "$1$2")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/** The greeting on first load — always local, so startup never waits on a model. */
export async function greeting(lifeState: LifeState): Promise<Message> {
  return {
    id: uid("msg"),
    role: "xana",
    text: "",
    createdAt: nowIso(),
    cards: await briefingWithAnalysis(lifeState),
    engine: "local",
  };
}
