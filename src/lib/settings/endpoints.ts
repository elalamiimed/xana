/**
 * Endpoint normalisation.
 *
 * The single most common way to get a model configured wrong is to paste a
 * URL that is *almost* right. Providers document their base URL in three
 * different shapes, and every dashboard, README and blog post picks a
 * different one:
 *
 *   https://api.deepseek.com
 *   https://api.deepseek.com/v1
 *   https://api.deepseek.com/v1/chat/completions
 *
 * All three mean the same thing, and before this file only the middle one
 * worked. Pasting the first sent the request to
 * `https://api.deepseek.com/chat/completions` and got a 404 the user could
 * not explain, and pasting the third produced
 * `.../v1/chat/completions/chat/completions`. That is a bad first
 * experience for something the user is doing specifically to get started.
 *
 * So the input is normalised to a canonical base: scheme and host, an
 * optional path prefix, and a version segment where the provider uses one.
 * The request builder then appends the one endpoint path it needs.
 *
 * This is pure string work with no network access, which is deliberate: it
 * must be testable without a provider and it must never be the reason a
 * save fails.
 */

/** The paths a user might paste that are *endpoints*, not bases. */
const ENDPOINT_SUFFIXES = [
  "/chat/completions",
  "/completions",
  "/messages",
  "/responses",
  "/embeddings",
];

export interface NormalisedEndpoint {
  /** Canonical base URL, no trailing slash. */
  baseUrl: string;
  /** True when the input was changed, so the UI can say so. */
  changed: boolean;
  /**
   * The endpoint the input appeared to name, when it named one.
   * Used to infer the provider: `/messages` is Anthropic's shape.
   */
  namedEndpoint?: string;
}

/**
 * Reduce any of the three shapes to a canonical base URL.
 *
 * Never throws. A value this cannot parse is returned trimmed rather than
 * rejected, because a user with an unusual internal hostname should still
 * be able to save and find out from the Test button what happened.
 */
export function normaliseEndpoint(raw: string): NormalisedEndpoint {
  const input = raw.trim().replace(/\s+/g, "");
  if (input.length === 0) return { baseUrl: "", changed: false };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    // Not parseable (a bare hostname, or a local name without a scheme).
    // Strip a pasted endpoint path by hand so the common paste still works,
    // and let validation complain about the missing scheme.
    let path = input.replace(/\/+$/, "");
    let named: string | undefined;
    for (const suffix of ENDPOINT_SUFFIXES) {
      if (path.toLowerCase().endsWith(suffix)) {
        path = path.slice(0, -suffix.length);
        named = suffix;
        break;
      }
    }
    return { baseUrl: path, changed: path !== input.replace(/\/+$/, ""), namedEndpoint: named };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { baseUrl: input.replace(/\/+$/, ""), changed: false };
  }

  // A query or hash has no meaning on a base URL and would corrupt the
  // appended path.
  url.search = "";
  url.hash = "";

  let path = url.pathname.replace(/\/+$/, "");
  let named: string | undefined;

  for (const suffix of ENDPOINT_SUFFIXES) {
    if (path.toLowerCase().endsWith(suffix)) {
      path = path.slice(0, -suffix.length);
      named = suffix;
      break;
    }
  }

  /**
   * Anthropic puts the version in the *endpoint*, not the base.
   *
   * Its base URL is `https://api.anthropic.com` and the request goes to
   * `https://api.anthropic.com/v1/messages`, so the builder appends `/v1`
   * itself. If a user pastes the full endpoint and only the `/messages` is
   * stripped, the `/v1` is left behind and the request becomes
   * `/v1/v1/messages`. Scoping the strip to the shape that needs it keeps
   * every OpenAI-compatible provider's `/v1` intact, because that one
   * genuinely belongs to the base.
   */
  const anthropicShaped =
    named !== undefined && named.toLowerCase().endsWith("/messages");
  if (anthropicShaped && /\/v\d+(?:\.\d+)?$/i.test(path)) {
    path = path.replace(/\/v\d+(?:\.\d+)?$/i, "");
  }

  // A version segment is part of the base. Anything else in the path is a
  // deployment prefix and is preserved: internal gateways use them.
  url.pathname = path;

  const baseUrl = url.toString().replace(/\/+$/, "");
  return { baseUrl, changed: baseUrl !== input.replace(/\/+$/, ""), namedEndpoint: named };
}

/**
 * Add the `/v1` that OpenAI-compatible providers expect, when the base has
 * no version segment at all.
 *
 * Scoped on two axes, and both matter:
 *
 *  - **Known hosted providers only.** For `api.deepseek.com` a missing `/v1`
 *    is almost certainly an omission, because their documentation uses both
 *    forms and only one works. For an unknown internal host it would be a
 *    guess, and a guessed path segment produces a 404 that reads exactly
 *    like the server being unreachable.
 *  - **Never a local address.** A runtime on this machine is at whatever
 *    path its operator chose. Ollama is usually `/v1`; llama.cpp, LM Studio
 *    and a hand-written proxy are not. A user who typed
 *    `http://127.0.0.1:11434` has told us the address they mean.
 */
export function withDefaultVersion(
  baseUrl: string,
  knownHostedHosts: readonly string[],
  localHosts: readonly string[] = [],
): string {
  if (!baseUrl) return baseUrl;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  const alreadyVersioned = /(?:^|\/)v\d+(?:\.\d+)?$/i.test(url.pathname);
  if (alreadyVersioned) return baseUrl;

  const hostname = url.hostname.toLowerCase();
  if (localHosts.some((local) => hostname === local)) return baseUrl;
  // A bare IPv4 or IPv6 literal is a machine, not a hosted API.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":")) {
    return baseUrl;
  }

  const isKnown = knownHostedHosts.some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  );
  if (!isKnown) return baseUrl;

  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1`;
  return url.toString().replace(/\/+$/, "");
}

/**
 * The endpoint a request will actually hit, for display in the settings
 * screen.
 *
 * Worth showing literally. "Test connection" failing is much easier to act
 * on when the panel also says where the request went.
 */
export function resolveEndpointPath(
  baseUrl: string,
  provider: "openai" | "anthropic",
): string {
  const base = baseUrl.replace(/\/+$/, "");
  return provider === "anthropic" ? `${base}/v1/messages` : `${base}/chat/completions`;
}

/**
 * Whether a base URL looks usable. Used to give an inline error before a
 * save, rather than letting the request fail later.
 */
export function endpointProblem(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) return null; // empty means "use the provider default"
  if (!/^https?:\/\//i.test(trimmed)) {
    return "Needs a scheme — start with http:// or https://";
  }
  try {
    const url = new URL(trimmed);
    if (!url.hostname) return "No host in that URL";
  } catch {
    return "That is not a URL I can parse";
  }
  return null;
}
