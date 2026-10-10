/**
 * The LLM client.
 *
 * Xana works with no API key at all — that is a hard requirement, and the
 * local mind covers it. When a model *is* configured, this client upgrades
 * her voice from deterministic to generative, keeping the same personality
 * contract either way.
 *
 * Two provider shapes are supported:
 *
 *  - **OpenAI-compatible** (`/chat/completions`): OpenAI, DeepSeek, Groq,
 *    Together, OpenRouter, and a local Ollama or llama.cpp server. This
 *    covers essentially everything self-hostable, which is what a personal
 *    assistant should prefer.
 *  - **Anthropic** (`/v1/messages`): a different envelope, so it gets its
 *    own path.
 *
 * WHERE THE CONFIGURATION COMES FROM
 *
 * Not from `process.env` directly. `resolveModel()` in the settings layer
 * owns the precedence — the settings file, then the environment, then
 * defaults — so pasting a key into the UI and setting one in `.env` are
 * the same code path, and the UI can show which one is winning.
 */

import { DEFAULT_PERSONA } from "../settings/types";
import { loadSettings, resolveModel } from "../settings/store";

export interface LlmConfig {
  provider: "openai" | "anthropic";
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
}

/**
 * One tool call the model asked for. `arguments` is a JSON **string**, exactly
 * as the wire delivered it, and the provider warns it "does not always generate
 * valid JSON, and may hallucinate parameters". It is therefore never parsed
 * here: `mind/tools.ts` parses it defensively and a parse failure is a refusal,
 * not an exception.
 */
export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * A message in the wire conversation.
 *
 * `tool` and `assistant.tool_calls` exist for the tool loop. `reasoning_content`
 * is captured because the provider returns it whenever thinking mode is on, but
 * it is deliberately **not** replayed: the documentation says a request carrying
 * `tools` must echo it or receive a 400, and a live probe on 2026-10-08 shows
 * that is false — omitting it returns 200. Replaying a few hundred tokens of
 * chain-of-thought on every turn of every loop would buy nothing and cost input
 * tokens, so the field is kept for logging and left out of the request body.
 */
export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

/**
 * Resolve configuration, or `undefined` when no model should answer.
 *
 * Two things have to be true: a key exists somewhere, and the user has left
 * the model switched on. The second condition matters — someone with an
 * `OPENAI_API_KEY` exported for a different tool has not thereby opted
 * Xana into spending it.
 */
export function llmConfig(): LlmConfig | undefined {
  const resolved = resolveModel();
  if (!resolved.enabled || resolved.apiKey.length === 0) return undefined;

  return {
    provider: resolved.provider,
    baseUrl: resolved.baseUrl,
    model: resolved.model,
    apiKey: resolved.apiKey,
    temperature: resolved.temperature,
  };
}

export function llmAvailable(): boolean {
  return llmConfig() !== undefined;
}

/** The system prompt: the user's persona when they have written one, the
 *  built-in one otherwise. Read per call, so editing it in Settings takes
 *  effect on the next message rather than the next restart. */
export function systemPrompt(): string {
  const persona = loadSettings().voice.persona.trim();
  return persona.length > 0 ? persona : DEFAULT_PERSONA;
}

export interface LlmResult {
  text: string;
  model: string;
  /** Wall-clock milliseconds for the round trip. */
  latencyMs: number;
}

/** What one round trip actually cost. `cachedTokens` is the part DeepSeek billed
 *  at the cache-hit rate, which is why the prompt layout is kept stable. */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

/** The full result of one call. Superset of the old `LlmResult`, so every
 *  existing caller keeps working unchanged. */
export interface LlmCompletion extends LlmResult {
  /** Empty unless the model asked for tools. */
  toolCalls: LlmToolCall[];
  finishReason?: string;
  usage?: LlmUsage;
}

/** An OpenAI-compatible tool definition, as it goes on the wire. Kept
 *  structurally identical to `toolsJsonSchema()` in ./tools so the two cannot
 *  drift; this file must not import that one, because tools imports the
 *  executor and the executor imports the store. */
export interface LlmToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlmOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  tools?: LlmToolDefinition[];
  /**
   * `"required"` is refused with an HTTP 400 while thinking mode is on
   * ("Thinking mode does not support this tool_choice", measured 2026-10-08),
   * so `buildRequest` downgrades it to `"auto"` rather than spending a round
   * trip to learn that. Nothing here needs a forced call badly enough to pay
   * for it in reliability.
   */
  toolChoice?: "auto" | "none" | "required";
  /**
   * Thinking mode. Default `true` when the caller says nothing, because both
   * current models default to it server-side and being explicit is how the
   * `tool_choice` conflict above is avoided.
   *
   * Turn it off for mechanical calls — extracting memories from a turn,
   * grading a transcript — where the thinking tokens are pure latency and cost.
   */
  thinking?: boolean;
  reasoningEffort?: "low" | "high" | "max";
  /** `json_object` requires the word "json" and an example in the prompt. */
  responseFormat?: "text" | "json_object";
}

/**
 * Ask the model for a reply. Rejects on any failure — the caller falls back
 * to the local mind rather than surfacing an error to the user.
 */
export async function llmComplete(
  messages: LlmMessage[],
  opts: LlmOptions = {},
): Promise<LlmCompletion> {
  const config = llmConfig();
  if (!config) throw new Error("no LLM configured");

  const timeoutMs = opts.timeoutMs ?? 20_000;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const started = Date.now();

  try {
    const { url, headers, body } = buildRequest(config, messages, opts);
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: abort.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `LLM HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }

    const json = (await res.json()) as Record<string, unknown>;
    const text = extractText(config.provider, json);
    const toolCalls = extractToolCalls(json);

    /**
     * A tool-only round trip has no text, and that is a normal intermediate
     * state rather than a failure: the model said what it wanted to do and is
     * waiting for the result. The old `if (!text) throw` would have called that
     * "LLM returned no text" and thrown away a perfectly good tool call.
     */
    if (!text && toolCalls.length === 0) throw new Error("LLM returned no text");

    return {
      text: (text ?? "").trim(),
      model: config.model,
      latencyMs: Date.now() - started,
      toolCalls,
      finishReason: extractFinishReason(json),
      usage: extractUsage(json),
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Probing                                                            */
/* ------------------------------------------------------------------ */

export interface LlmProbe {
  ok: boolean;
  /** One sentence for the settings screen. Never a raw stack trace. */
  message: string;
  latencyMs?: number;
  /** The model that actually answered, when the provider echoes it. */
  model?: string;
}

/**
 * Prove a configuration works, from the settings screen.
 *
 * This deliberately takes an explicit config rather than reading the
 * stored one: the point of the button is to test what the user has typed
 * *before* saving it. It sends the smallest possible request — one token,
 * one word — because the goal is to distinguish "the key is wrong" from
 * "the model is unreachable" from "this endpoint is not OpenAI-shaped",
 * and none of those need a real answer.
 *
 * It never throws. A probe that throws is a probe the caller has to wrap,
 * and the failure reasons are the entire value of the feature.
 */
export async function probeModel(config: LlmConfig): Promise<LlmProbe> {
  if (!config.apiKey.trim()) {
    return { ok: false, message: "No API key. Add one, or leave the model off and use the local mind." };
  }
  if (!/^https?:\/\//i.test(config.baseUrl)) {
    return { ok: false, message: "The base URL must start with http:// or https://" };
  }

  const started = Date.now();
  try {
    const { url, headers, body } = buildRequest(
      config,
      [
        { role: "system", content: "Reply with the single word: ready" },
        { role: "user", content: "Say ready." },
      ],
      { maxTokens: 16, temperature: 0 },
    );

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - started;

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, message: explainStatus(res.status, detail, config) };
    }

    const json = (await res.json()) as Record<string, unknown>;
    const text = extractText(config.provider, json);
    if (!text) {
      return {
        ok: false,
        message: `${config.model} answered, but not in a shape I recognise. Check that the endpoint is OpenAI-compatible.`,
        latencyMs,
      };
    }

    return {
      ok: true,
      message: `Answered in ${latencyMs}ms.`,
      latencyMs,
      model: config.model,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/abort/i.test(message)) {
      return { ok: false, message: "Timed out after 15s. The endpoint may be down, or unreachable from here." };
    }
    if (/ENOTFOUND|getaddrinfo|fetch failed/i.test(message)) {
      return { ok: false, message: `Could not reach ${hostOf(config.baseUrl)}. Check the base URL and your connection.` };
    }
    return { ok: false, message };
  }
}

/** Turn an HTTP status into a sentence that names the likely cause. */
function explainStatus(status: number, detail: string, config: LlmConfig): string {
  const trimmed = redact(detail);
  const suffix = trimmed ? ` — ${trimmed}` : "";

  switch (status) {
    case 401:
    case 403:
      // Deliberately does not repeat the provider's own wording for a bad
      // key. Several providers echo part of the submitted key back in the
      // error body, and putting that in the UI (and in any screenshot of
      // it) leaks a fragment of a real credential for no benefit.
      return `The key was refused (${status}). Check it is complete and belongs to ${
        config.provider === "anthropic" ? "Anthropic" : "this provider"
      }. The provider did not accept it.`;
    case 404:
      return `No such endpoint (404). Check the base URL — for a local server the path is usually /v1.${suffix}`;
    case 429:
      return `Rate limited (429). The key works; try again shortly.${suffix}`;
    default:
      if (status >= 500) {
        return `The provider returned ${status}. That is their side, not yours.${suffix}`;
      }
      return `The provider returned ${status}.${suffix}`;
  }
}

/**
 * Strip anything resembling a credential out of an upstream error body.
 *
 * Providers vary in how much of a rejected key they echo, and an error
 * string is exactly the kind of thing that ends up in a screenshot or a bug
 * report. Anything that looks like a key is replaced rather than truncated,
 * so the reader still sees that *something* was there.
 */
function redact(text: string): string {
  return text
    .replace(/\s+/g, " ")
    // Long opaque tokens: sk-…, or any 20+ character run of key characters.
    .replace(/\b(sk|xai|gsk|or|key|api)[-_][A-Za-z0-9_-]{12,}/gi, "$1-…")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "…")
    .slice(0, 180);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/* ------------------------------------------------------------------ */
/* Request building                                                   */
/* ------------------------------------------------------------------ */

export function buildRequest(
  config: LlmConfig,
  messages: LlmMessage[],
  opts: LlmOptions,
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  if (config.provider === "anthropic") {
    // Anthropic takes the system prompt as a top-level field, not a message.
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const turns = messages
      .filter((m) => m.role !== "system")
      .map((m) => toAnthropicTurn(m));

    return {
      url: `${config.baseUrl}/v1/messages`,
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model: config.model,
        max_tokens: opts.maxTokens ?? 700,
        temperature: opts.temperature ?? config.temperature,
        ...(system ? { system } : {}),
        messages: turns,
        ...(opts.tools?.length
          ? {
              tools: opts.tools.map((t) => ({
                name: t.function.name,
                description: t.function.description,
                input_schema: t.function.parameters,
              })),
            }
          : {}),
      },
    };
  }

  return {
    url: `${config.baseUrl}/chat/completions`,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: {
      model: config.model,
      max_tokens: opts.maxTokens ?? 700,
      temperature: opts.temperature ?? config.temperature,
      messages: messages.map(toOpenAiMessage),
      ...openAiExtras(opts),
    },
  };
}

/**
 * The provider-specific request keys.
 *
 * `thinking` is not an OpenAI parameter, and a strict OpenAI-compatible server
 * (a local Ollama, say) is entitled to reject an unknown key. So it is only sent
 * when the caller asked for a specific mode *and* the endpoint is one we know
 * understands it. Absent, the server keeps its own default, which is what the
 * old code did implicitly and why nothing regresses for a local model.
 */
function openAiExtras(opts: LlmOptions): Record<string, unknown> {
  const extras: Record<string, unknown> = {};

  /**
   * Forced tool choice and thinking mode are mutually exclusive.
   *
   * Measured 2026-10-08 against api.deepseek.com: `tool_choice: "required"`
   * returns HTTP 400 with "Thinking mode does not support this tool_choice".
   * Thinking is on by default server-side, so the honest options are to
   * downgrade to "auto" here or to spend a round trip discovering it. Nothing
   * in Xana needs a forced call, and "auto" with a well-written description is
   * reliable enough, so this downgrades rather than fails.
   */
  const thinkingOn = opts.thinking !== false;
  if (opts.toolChoice) {
    if (opts.toolChoice === "required" && thinkingOn) {
      extras.tool_choice = "auto";
    } else {
      extras.tool_choice = opts.toolChoice;
    }
  }

  if (opts.responseFormat === "json_object") extras.response_format = { type: "json_object" };

  // Asking for thinking explicitly is what makes the tool_choice downgrade
  // above correct. Saying nothing would leave the server's default in charge
  // and this file guessing at it.
  if (opts.thinking !== undefined) {
    extras.thinking = { type: opts.thinking ? "enabled" : "disabled" };
  }
  if (opts.reasoningEffort && thinkingOn) extras.reasoning_effort = opts.reasoningEffort;

  return extras;
}

/** Strip the two fields that are ours rather than the wire's. */
function toOpenAiMessage(m: LlmMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.name) out.name = m.name;
  if (m.tool_calls?.length) {
    out.tool_calls = m.tool_calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments },
    }));
  }
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  return out;
}

function toAnthropicTurn(m: LlmMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: m.tool_call_id ?? "", content: m.content }],
    };
  }
  if (m.role === "assistant" && m.tool_calls?.length) {
    const blocks: Array<Record<string, unknown>> = [];
    if (m.content) blocks.push({ type: "text", text: m.content });
    for (const c of m.tool_calls) {
      let input: unknown = {};
      try {
        input = JSON.parse(c.arguments);
      } catch {
        // An argument string that is not JSON still has to reach the model
        // verbatim, or it cannot see what it got wrong.
        input = { _raw: c.arguments };
      }
      blocks.push({ type: "tool_use", id: c.id, name: c.name, input });
    }
    return { role: "assistant", content: blocks };
  }
  return { role: m.role === "assistant" ? "assistant" : "user", content: m.content };
}

function extractText(
  provider: LlmConfig["provider"],
  json: Record<string, unknown>,
): string | undefined {
  if (provider === "anthropic") {
    const content = json.content;
    if (Array.isArray(content)) {
      return content
        .map((block) =>
          block &&
          typeof block === "object" &&
          typeof (block as Record<string, unknown>).text === "string"
            ? String((block as Record<string, unknown>).text)
            : "",
        )
        .join("")
        .trim();
    }
    return undefined;
  }

  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0] as Record<string, unknown>;
  const message = first.message as Record<string, unknown> | undefined;
  if (message && typeof message.content === "string") return message.content;
  if (typeof first.text === "string") return first.text; // legacy completions shape
  return undefined;
}

/**
 * The tool calls in a reply, normalised.
 *
 * `arguments` is passed through exactly as received — a JSON string, possibly
 * malformed. It is not parsed here on purpose: this layer's job is to report
 * what the provider said, and the layer that acts on it is the one that has to
 * refuse a bad argument and say why.
 */
function extractToolCalls(json: Record<string, unknown>): LlmToolCall[] {
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) return [];
  const message = (choices[0] as Record<string, unknown>).message as
    | Record<string, unknown>
    | undefined;
  const raw = message?.tool_calls;
  if (!Array.isArray(raw)) return [];

  const out: LlmToolCall[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const c = entry as Record<string, unknown>;
    const fn = c.function as Record<string, unknown> | undefined;
    const name = typeof fn?.name === "string" ? fn.name : undefined;
    if (!name) continue;
    out.push({
      // A provider that omits the id would otherwise produce a `tool` message
      // with an empty `tool_call_id`, which some servers reject outright.
      id: typeof c.id === "string" && c.id ? c.id : `call_${out.length}_${name}`,
      name,
      arguments: typeof fn?.arguments === "string" ? fn.arguments : "{}",
    });
  }
  return out;
}

function extractFinishReason(json: Record<string, unknown>): string | undefined {
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const reason = (choices[0] as Record<string, unknown>).finish_reason;
  return typeof reason === "string" ? reason : undefined;
}

/**
 * Token accounting, including the prompt-cache split.
 *
 * `cachedTokens` is the part billed at the cache-hit rate, which on the current
 * price list is fifty times cheaper than a miss. It is captured rather than
 * discarded because it is the only way to tell whether the prompt layout is
 * actually earning the cache: a stable prefix should show a high hit ratio from
 * the third call onward, and if it does not, the prefix has stopped being
 * stable and this number is how anyone would ever notice.
 */
function extractUsage(json: Record<string, unknown>): LlmUsage | undefined {
  const usage = json.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return undefined;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const completionDetails = usage.completion_tokens_details as Record<string, unknown> | undefined;
  return {
    promptTokens: num(usage.prompt_tokens),
    completionTokens: num(usage.completion_tokens),
    cachedTokens: num(usage.prompt_cache_hit_tokens),
    reasoningTokens: num(completionDetails?.reasoning_tokens),
  };
}
