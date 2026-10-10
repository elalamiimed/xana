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
import { rememberConversation } from "../derived/learning";
import { finishAction } from "../actions/remote";
import { runAgentTurn } from "./agent";
import { composePersona } from "./persona";
import { stripMarkdown } from "./voice";

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

  /**
   * 1a. Mirror the write remotely, if the user allowed that and the plugin
   *     supports it. Today this is a calendar event going into Google.
   *
   * It runs *before* `refreshAfterAction` on purpose. The mirror can create a
   * record in a calendar the read adapters also read, so refreshing first would
   * assemble a life state that does not yet contain what she just booked, and
   * the reply would be assembled from a stale schedule.
   *
   * `finishAction` is a no-op for every outcome without a remote counterpart,
   * which is all of them except a calendar event, and it never throws or fails
   * an action that already succeeded locally.
   */
  if (local.outcome) {
    await finishAction(local.outcome);
  }

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
    await learn(sessionId, text, message.text);
    return { message, lifeState: refreshed };
  }

  /**
   * THE UNMATCHED TURN, which is what the "smarter" pass added.
   *
   * Until now, what happened next depended entirely on whether the local engine
   * had resolved something. If it had, the model phrased the result. If it had
   * not, the model was asked to phrase *nothing* - handed the local engine's
   * sentence "I didn't follow that" and forbidden from doing anything about it.
   *
   * That is the mechanical cause of the complaint this pass exists for. She
   * could not hold a conversation, because a conversation is by definition a
   * turn the intent engine does not resolve; and she could not do anything the
   * intent engine's patterns did not already cover, which is most of what a
   * person actually asks an assistant for.
   *
   * So an unmatched turn now goes to the agent loop, which may call tools. The
   * loop runs the same `executeAction` as everything else, behind the same
   * guard, and with an audit row and an idempotency key. What the model gains is
   * not the ability to act - it is the ability to ask for one of a closed set of
   * typed things, each of which was already reachable by typing a sentence.
   *
   * A turn that DID resolve something still takes the old path below: the local
   * engine decided, and the model only gets to say so.
   */
  const unmatched = !local.outcome && !local.cards?.length;
  if (unmatched) {
    const agent = await runAgentTurn({
      text,
      lifeState: refreshed,
      sessionId,
      modality: request.modality,
    });

    /**
     * `engine` stays `"llm"` when a model answered, and that is deliberate
     * rather than an oversight: it is the field the UI and the settings screen
     * use to mean "a model produced these words", and the agent loop is a model
     * producing words. The distinction that matters for debugging is on the
     * action log, where the source is recorded per write.
     */
    const guarded = guardUnmadeClaim(agent.text, { text, acted: Boolean(agent.outcome?.ok) });
    const message: Message = {
      ...toMessage(local, "llm", started),
      text: guarded.text.trim() || local.text,
      ...(agent.cards?.length ? { cards: agent.cards } : {}),
      ...(agent.outcome ? { outcome: agent.outcome } : {}),
    };

    if (guarded.replaced) {
      console.warn(`[xana] model claimed a change that did not happen; replaced with the honest line: ${agent.text.slice(0, 120)}`);
    }
    store.logMessage("xana", message.text, sessionId, {
      engine: "llm",
      route: "agent",
      effect: agent.outcome?.effect,
      tools: agent.toolCalls.length ? agent.toolCalls.map((c) => c.name).join(",") : undefined,
      ...(guarded.replaced ? { guarded: "unmade-claim" } : {}),
    });
    await learn(sessionId, text, message.text);
    return { message, lifeState: refreshed };
  }

  try {
    const spoken = await speakWithModel({
      text,
      lifeState: refreshed,
      local,
      modality: request.modality,
    });

    const guarded = guardUnmadeClaim(spoken, { text, acted });

    const message: Message = {
      ...toMessage(local, "llm", started),
      text: guarded.text.trim() || local.text,
    };
    if (guarded.replaced) {
      console.warn(`[xana] model claimed a change that did not happen; replaced with the honest line: ${spoken.slice(0, 120)}`);
    }
    store.logMessage("xana", message.text, sessionId, {
      engine: "llm",
      effect: local.outcome?.effect,
      ...(guarded.replaced ? { guarded: "unmade-claim" } : {}),
    });
    await learn(sessionId, text, message.text);
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
    await learn(sessionId, text, message.text);
    return { message, lifeState: refreshed };
  }
}

/**
 * Learn what the turn was worth keeping.
 *
 * Called at the end of each path, once both sides of the exchange exist, because
 * extraction reads the *pair*: "the landlord wants an answer by the 20th" is only
 * a fact in the context of what she said back, and a fact that contradicts her
 * own reply is one the extractor should be able to see.
 *
 * `rememberUtterance` has already run earlier in the turn and covers the offline
 * patterns. This is the model half, and it is strictly additive: it returns
 * without a model, swallows its own failures, and never changes the reply. A
 * turn that cannot learn anything is a turn that works exactly as before.
 */
async function learn(sessionId: string, userText: string, xanaText: string): Promise<void> {
  try {
    await rememberConversation({ userText, xanaText }, { store: getStore(), sessionId });
  } catch {
    // Best-effort. A memory write must never cost the user their answer.
  }
}

/**
 * The claim guard lives in ./claims so it can be driven without a model: a
 * network call is not something a test can assert an honesty rule against.
 */
import { actionRule, guardUnmadeClaim } from "./claims";

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
  /**
   * The two-tier persona, not the raw stored string.
   *
   * `composePersona` keeps the fixed honesty floor and lets a user-written
   * persona replace only the guidelines tier. Before it existed, the box in
   * Settings held the whole document, so rewriting the voice and deleting the
   * rule that stops her claiming work she did not do were the same edit.
   */
  const parts = [composePersona(settings.voice.persona)];

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

/**
 * Render the life state compactly. Token budget matters more than completeness.
 *
 * Moved to `./render` so the agent loop can share it without importing this
 * module, which imports the agent. Re-exported here because it has always been
 * part of this module's surface and a caller reaching for it should not have to
 * learn that it moved.
 */
import { renderLifeState } from "./render";
export { renderLifeState };

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

  /**
   * The rule that would have prevented the lie this pass exists to fix.
   *
   * In one session the user asked for a garbled task to be retitled. No action
   * could run, so no ACTION RESULT was sent — and the model, asked to answer in
   * her voice with a helpful persona, answered "Done. The task is now titled
   * …". It had no way to know that was false, because nothing told it that
   * performing actions is not its job. The wording lives in `./claims` beside
   * the check that enforces it, so the two cannot drift.
   */
  parts.push(actionRule(Boolean(input.local.outcome)));

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
