/**
 * The provider registry.
 *
 * One table that answers every question the settings screen and the model
 * client have about a provider. Before this file those answers were spread
 * across four places — a preset list, two default maps keyed by provider
 * shape, a model-name default, and a hardcoded fallback inside the request
 * builder — which meant adding a provider was a four-file change and the
 * four could disagree.
 *
 * The rule that keeps it honest: **every field here is consulted by code,
 * or it is not here.** A field that only exists to be displayed belongs in
 * the UI, and a field that only exists to look tidy is a maintenance cost
 * with no reader.
 *
 * Ordering is deliberate. DeepSeek leads the list because it is the
 * cheapest way to get a real assistant running and it is the one this
 * project was asked for by name; OpenAI and Anthropic follow as the
 * best-known hosted options; the local runtime comes before the
 * aggregators, because "runs on this machine, no key, nothing leaves it"
 * is the option a privacy-minded user is looking for and should not have
 * to hunt for.
 */

import type { ModelProvider } from "./types";
import { normaliseEndpoint, withDefaultVersion } from "./endpoints";

export interface ProviderPreset {
  id: string;
  label: string;
  /**
   * The wire format. This is the one thing that genuinely changes the
   * request: OpenAI-compatible providers all share `/chat/completions`,
   * Anthropic uses `/v1/messages` with a different envelope.
   */
  shape: ModelProvider;
  /**
   * Canonical base URL, no trailing slash. `normaliseEndpoint` accepts the
   * three shapes a user might paste and reduces them to this.
   */
  baseUrl: string;
  /** The model a fresh setup gets. */
  defaultModel: string;
  /**
   * Models worth offering by name. Not authoritative and not a menu: the
   * field stays free text, because a provider that launched last week, or
   * a fine-tune, or an internal deployment all need to work.
   */
  models: readonly string[];
  /** One line on when to pick this. Shown as the chip's tooltip. */
  note: string;
  /** True when this needs no key at all. */
  keyless?: boolean;
  /**
   * Hosts this preset owns, for endpoint inference and for deciding
   * whether to append a missing `/v1`.
   */
  hosts: readonly string[];
}

export const PROVIDERS: readonly ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    shape: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    note: "OpenAI-compatible, very cheap, strong at reasoning. `deepseek-reasoner` thinks before answering and is slower on purpose.",
    hosts: ["api.deepseek.com", "deepseek.com"],
  },
  {
    id: "openai",
    label: "OpenAI",
    shape: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "o4-mini"],
    note: "The default everyone tests against.",
    hosts: ["api.openai.com", "openai.com"],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    shape: "anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-3-5-haiku-latest",
    models: [
      "claude-3-5-haiku-latest",
      "claude-3-5-sonnet-latest",
      "claude-sonnet-4-latest",
    ],
    note: "A different request shape from the rest, which Xana handles natively.",
    hosts: ["api.anthropic.com", "anthropic.com"],
  },
  {
    id: "ollama",
    label: "Ollama",
    shape: "openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    defaultModel: "llama3.2",
    models: ["llama3.2", "qwen2.5", "mistral", "phi4"],
    note: "Runs on this machine. No key needed — type anything in the key field. Nothing leaves your computer.",
    keyless: true,
    hosts: ["localhost", "127.0.0.1", "0.0.0.0", "host.docker.internal"],
  },
  {
    id: "groq",
    label: "Groq",
    shape: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
    note: "OpenAI-compatible and extremely fast. Note the `/openai` in the path — that is theirs, not a typo.",
    hosts: ["api.groq.com", "groq.com"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    shape: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-3.5-haiku",
    models: [
      "anthropic/claude-3.5-haiku",
      "deepseek/deepseek-chat",
      "meta-llama/llama-3.3-70b-instruct",
    ],
    note: "One key, most models. Model ids are namespaced with a slash.",
    hosts: ["openrouter.ai"],
  },
  {
    id: "together",
    label: "Together",
    shape: "openai",
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    models: [
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "Qwen/Qwen2.5-72B-Instruct-Turbo",
    ],
    note: "OpenAI-compatible, hosts many open-weight models.",
    hosts: ["api.together.xyz", "together.xyz"],
  },
  {
    id: "custom",
    label: "Custom",
    shape: "openai",
    baseUrl: "",
    defaultModel: "",
    models: [],
    note: "Any endpoint that speaks one of the two shapes: a proxy, a gateway, a self-hosted runtime.",
    hosts: [],
  },
] as const;

export function findProvider(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/**
 * Every host any preset claims.
 *
 * Used to decide whether a base URL should get a `/v1` appended when the
 * user omitted one. That is nearly always right for a hosted API and
 * nearly always wrong for a server on the local network, which is why
 * `LOCAL_HOSTS` is subtracted before the rule is applied. See
 * `withDefaultVersion`.
 */
export const KNOWN_HOSTS: readonly string[] = PROVIDERS.flatMap((p) => p.hosts);

/**
 * Hosts that mean "already on this machine or this network".
 *
 * Excluded from version-filling on purpose. A local runtime is reached at
 * whatever path its operator chose: Ollama is usually `/v1`, but llama.cpp,
 * LM Studio and a hand-rolled proxy are not, and the user typing
 * `http://127.0.0.1:11434` has told us the address they mean. Appending a
 * segment to that is inventing a route, and the resulting 404 is
 * indistinguishable from the server being down.
 */
export const LOCAL_HOSTS: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "host.docker.internal",
];

/** True when a base URL points at a loopback or local-network address. */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return LOCAL_HOSTS.some((local) => hostname === local);
  } catch {
    return false;
  }
}

/**
 * Canonicalise a base URL for storage or display.
 *
 * The single entry point every caller should use, because it binds the two
 * host lists to `withDefaultVersion` and there is no way to call it while
 * forgetting one. Passing them separately at each call site is a bug that
 * already happened once: the local-host guard existed but was not wired up,
 * so `http://127.0.0.1:11434` was silently rewritten to
 * `http://127.0.0.1:11434/v1`.
 */
export function canonicalBaseUrl(raw: string): string {
  if (!raw.trim()) return "";
  const normalised = normaliseEndpoint(raw).baseUrl;
  if (!normalised) return "";
  return withDefaultVersion(normalised, KNOWN_HOSTS, LOCAL_HOSTS);
}

/**
 * Which preset a stored configuration looks like.
 *
 * Matched on the base URL first, because that is what the user actually
 * pasted, then on the model id, which distinguishes two presets sharing a
 * host. Returns `undefined` rather than falling back to "custom": the
 * caller decides what to do with no match, and silently claiming a
 * configuration is custom would lose the user's preset.
 */
export function matchProvider(
  baseUrl: string,
  model: string,
): ProviderPreset | undefined {
  const base = baseUrl.trim().replace(/\/+$/, "").toLowerCase();
  const wanted = model.trim().toLowerCase();

  if (base) {
    for (const provider of PROVIDERS) {
      if (provider.baseUrl && provider.baseUrl.toLowerCase() === base) return provider;
    }
    for (const provider of PROVIDERS) {
      const host = provider.hosts.find((h) => base.includes(h));
      if (host) {
        const sameHost = PROVIDERS.filter((p) => p.hosts.includes(host));
        const byModel = sameHost.find((p) =>
          p.models.some((m) => m.toLowerCase() === wanted),
        );
        return byModel ?? provider;
      }
    }
  }

  if (wanted) {
    for (const provider of PROVIDERS) {
      if (provider.models.some((m) => m.toLowerCase() === wanted)) return provider;
    }
  }

  return undefined;
}

/**
 * The request shape implied by a base URL, when the user has not said.
 *
 * Only Anthropic differs, and its base URL is the tell. Everything else is
 * OpenAI-compatible, which is the correct default because it is what almost
 * every provider and every local runtime speaks.
 */
export function inferShape(baseUrl: string): ModelProvider | undefined {
  if (!baseUrl) return undefined;
  return /anthropic/i.test(baseUrl) ? "anthropic" : undefined;
}

/**
 * The preset implied by an *endpoint path* the user pasted.
 *
 * `.../v1/messages` is Anthropic's shape, so pasting the full endpoint URL
 * is enough to set the provider correctly without the user knowing that
 * "shape" is a setting.
 */
export function shapeFromPath(path: string | undefined): ModelProvider | undefined {
  if (!path) return undefined;
  return path.toLowerCase().endsWith("/messages") ? "anthropic" : undefined;
}
