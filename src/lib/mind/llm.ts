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

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
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

/**
 * Ask the model for a reply. Rejects on any failure — the caller falls back
 * to the local mind rather than surfacing an error to the user.
 */
export async function llmComplete(
  messages: LlmMessage[],
  opts: { maxTokens?: number; temperature?: number; timeoutMs?: number } = {},
): Promise<LlmResult> {
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
    if (!text) throw new Error("LLM returned no text");

    return { text: text.trim(), model: config.model, latencyMs: Date.now() - started };
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
  opts: { maxTokens?: number; temperature?: number },
): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  if (config.provider === "anthropic") {
    // Anthropic takes the system prompt as a top-level field, not a message.
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const turns = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      }));

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
      messages,
    },
  };
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
