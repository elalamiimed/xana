/**
 * Verify the provider registry and endpoint normalisation.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/verify-providers.mjs
 *
 * No network and no key needed. Every assertion here is about a decision
 * the app makes *before* it talks to anything: which endpoint a pasted URL
 * resolves to, which provider that implies, and which key wins over which.
 *
 * It exists because the failure it prevents is silent. A base URL with the
 * wrong number of `/v1` segments does not throw on save; it throws a 404 at
 * the user's first message, three screens away from the field they typed it
 * into. The three documented shapes for one DeepSeek endpoint are all in
 * here as test cases for that reason.
 */

import {
  normaliseEndpoint,
  resolveEndpointPath,
  withDefaultVersion,
  endpointProblem,
} from "../src/lib/settings/endpoints.ts";
import {
  PROVIDERS,
  KNOWN_HOSTS,
  findProvider,
  inferShape,
  matchProvider,
  shapeFromPath,
} from "../src/lib/settings/providers.ts";

let pass = 0;
let fail = 0;

function check(label, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${"─".repeat(64)}\n${title}\n${"─".repeat(64)}`);
}

function eq(label, actual, expected) {
  check(label, actual === expected, `expected "${expected}", got "${actual}"`);
}

const DEEPSEEK_HOSTS = PROVIDERS.find((p) => p.id === "deepseek").hosts;

/* ------------------------------------------------------------------ */
section("The three shapes for one endpoint");
/* ------------------------------------------------------------------ */

/**
 * Every one of these is documented somewhere as "the base URL" for
 * DeepSeek, and all three must resolve to the same request target. Before
 * normalisation only the middle one worked.
 */
const shapes = [
  "https://api.deepseek.com",
  "https://api.deepseek.com/",
  "https://api.deepseek.com/v1",
  "https://api.deepseek.com/v1/",
  "https://api.deepseek.com/v1/chat/completions",
  "https://api.deepseek.com/chat/completions",
];

for (const shape of shapes) {
  const base = withDefaultVersion(normaliseEndpoint(shape).baseUrl, KNOWN_HOSTS);
  eq(`"${shape}" resolves to the canonical base`, base, "https://api.deepseek.com/v1");
  eq(
    `  and its request path is correct`,
    resolveEndpointPath(base, "openai"),
    "https://api.deepseek.com/v1/chat/completions",
  );
}

/* ------------------------------------------------------------------ */
section("Deployments with a path prefix");
/* ------------------------------------------------------------------ */

// Groq's real base URL has `/openai` in it, which a naive "strip to host"
// would destroy. Internal gateways look the same.
eq(
  "Groq's /openai prefix survives",
  normaliseEndpoint("https://api.groq.com/openai/v1").baseUrl,
  "https://api.groq.com/openai/v1",
);
eq(
  "a custom gateway prefix survives",
  normaliseEndpoint("https://llm.internal.corp/proxy/ai/v1").baseUrl,
  "https://llm.internal.corp/proxy/ai/v1",
);
eq(
  "a pasted endpoint under a prefix still collapses",
  normaliseEndpoint("https://llm.internal.corp/proxy/ai/v1/chat/completions").baseUrl,
  "https://llm.internal.corp/proxy/ai/v1",
);
eq(
  "query strings are dropped, since appending a path would corrupt them",
  normaliseEndpoint("https://api.deepseek.com/v1?key=abc").baseUrl,
  "https://api.deepseek.com/v1",
);

/* ------------------------------------------------------------------ */
section("/v1 is added only where it is safe");
/* ------------------------------------------------------------------ */

eq(
  "a known hosted provider gets the version it omitted",
  withDefaultVersion("https://api.deepseek.com", KNOWN_HOSTS),
  "https://api.deepseek.com/v1",
);
eq(
  "an already-versioned base is left alone",
  withDefaultVersion("https://api.deepseek.com/v1", KNOWN_HOSTS),
  "https://api.deepseek.com/v1",
);
eq(
  "a local runtime is left alone, because /v1 there is the user's business",
  withDefaultVersion("http://127.0.0.1:11434", KNOWN_HOSTS),
  "http://127.0.0.1:11434",
);
eq(
  "an unknown host is left alone rather than guessed at",
  withDefaultVersion("https://llm.internal.corp", KNOWN_HOSTS),
  "https://llm.internal.corp",
);
eq(
  "a non-numeric version segment counts as versioned",
  withDefaultVersion("https://api.deepseek.com/v2", KNOWN_HOSTS),
  "https://api.deepseek.com/v2",
);

/* ------------------------------------------------------------------ */
section("Anthropic is the one different shape");
/* ------------------------------------------------------------------ */

eq(
  "its base keeps no /v1, because the request builder adds it",
  normaliseEndpoint("https://api.anthropic.com").baseUrl,
  "https://api.anthropic.com",
);
eq(
  "a pasted messages endpoint collapses to the base",
  normaliseEndpoint("https://api.anthropic.com/v1/messages").baseUrl,
  "https://api.anthropic.com",
);
eq(
  "and the request path is /v1/messages",
  resolveEndpointPath("https://api.anthropic.com", "anthropic"),
  "https://api.anthropic.com/v1/messages",
);
eq(
  "the pasted endpoint implies the shape",
  shapeFromPath("/v1/messages"),
  "anthropic",
);
check(
  "an OpenAI-shaped path does not imply Anthropic",
  shapeFromPath("/v1/chat/completions") === undefined,
);
eq(
  "a hostname containing anthropic implies the shape",
  inferShape("https://api.anthropic.com"),
  "anthropic",
);
check(
  "a DeepSeek hostname does not",
  inferShape("https://api.deepseek.com/v1") === undefined,
);

/* ------------------------------------------------------------------ */
section("Presets match what the user configured");
/* ------------------------------------------------------------------ */

eq(
  "a DeepSeek base URL matches the DeepSeek preset",
  matchProvider("https://api.deepseek.com/v1", "deepseek-chat")?.id,
  "deepseek",
);
eq(
  "the model id disambiguates two presets on one host",
  matchProvider("https://openrouter.ai/api/v1", "deepseek/deepseek-chat")?.id,
  "openrouter",
);
eq(
  "Anthropic's base matches its preset",
  matchProvider("https://api.anthropic.com", "claude-3-5-haiku-latest")?.id,
  "anthropic",
);
eq(
  "Ollama's local base matches its preset",
  matchProvider("http://127.0.0.1:11434/v1", "llama3.2")?.id,
  "ollama",
);
check(
  "an unrecognised endpoint matches nothing rather than claiming 'custom'",
  matchProvider("https://my-own-thing.example/v1", "my-model") === undefined,
  "a false match would silently change the user's provider",
);
eq(
  "DeepSeek is the default preset, and leads the registry",
  PROVIDERS[0].id,
  "deepseek",
);

/* ------------------------------------------------------------------ */
section("Registry integrity");
/* ------------------------------------------------------------------ */

check(
  "every preset has a unique id",
  new Set(PROVIDERS.map((p) => p.id)).size === PROVIDERS.length,
);
check(
  "every preset with a base URL declares hosts",
  PROVIDERS.every((p) => !p.baseUrl || p.hosts.length > 0),
  "host inference depends on it",
);
check(
  "every hosted preset's default model is in its own model list",
  PROVIDERS.filter((p) => p.baseUrl && p.models.length > 0).every((p) =>
    p.models.includes(p.defaultModel),
  ),
);
check(
  "only the two known wire formats are used",
  PROVIDERS.every((p) => p.shape === "openai" || p.shape === "anthropic"),
);
check(
  "no base URL has a trailing slash",
  PROVIDERS.every((p) => !p.baseUrl.endsWith("/")),
  "a trailing slash doubles up when a path is appended",
);
check(
  "every base URL is already canonical",
  PROVIDERS.every((p) => !p.baseUrl || normaliseEndpoint(p.baseUrl).baseUrl === p.baseUrl),
);
check(
  "the Anthropic preset uses the Anthropic shape",
  findProvider("anthropic").shape === "anthropic",
);
check(
  "the keyless preset is a local one",
  PROVIDERS.filter((p) => p.keyless).every((p) =>
    p.hosts.every((h) =>
      /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|host\.docker\.internal)$/.test(h),
    ),
  ),
  "a preset that needs no key must not point at a remote API",
);

/* ------------------------------------------------------------------ */
section("Unusable input is reported, not thrown");
/* ------------------------------------------------------------------ */

eq("a missing scheme is named", endpointProblem("api.deepseek.com"), "Needs a scheme — start with http:// or https://");
eq("an empty value is allowed, meaning 'use the default'", endpointProblem(""), null);
eq("a complete URL passes", endpointProblem("https://api.deepseek.com/v1"), null);
check("nonsense passes through rather than throwing", (() => {
  try {
    normaliseEndpoint("not a url at all");
    return true;
  } catch {
    return false;
  }
})());
eq("an empty string normalises to empty", normaliseEndpoint("   ").baseUrl, "");
check(
  "a bare hostname still loses a pasted endpoint path",
  normaliseEndpoint("api.deepseek.com/v1/chat/completions").baseUrl === "api.deepseek.com/v1",
  normaliseEndpoint("api.deepseek.com/v1/chat/completions").baseUrl,
);

/* ------------------------------------------------------------------ */
section("The redaction guard");
/* ------------------------------------------------------------------ */

// Mirrors the logic in llm.ts. Kept here as a test because the failure it
// guards against is a credential fragment reaching a screenshot.
function redact(text) {
  return text
    .replace(/\s+/g, " ")
    .replace(/\b(sk|xai|gsk|or|key|api)[-_][A-Za-z0-9_-]{12,}/gi, "$1-…")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "…")
    .slice(0, 180);
}

const leaked =
  'Authentication Fails, Your api key: ****-000 is invalid';
check(
  "the upstream error that DeepSeek actually returns has no key fragment",
  !/sk-[A-Za-z0-9]{8,}/.test(redact(leaked)),
  redact(leaked),
);
check(
  "a long opaque token is masked",
  !/abcdefghijklmnopqrstuvwxyz012345/.test(
    redact("bad key abcdefghijklmnopqrstuvwxyz012345 rejected"),
  ),
);
check(
  "a real-looking key is masked",
  redact("invalid sk-1234567890abcdefghij").includes("…") &&
    !redact("invalid sk-1234567890abcdefghij").includes("1234567890abcdefghij"),
);

/* ------------------------------------------------------------------ */
section("The key round trip (the panel's acceptance test)");
/* ------------------------------------------------------------------ */

/**
 * This is the check the reported bug was about: "the key does not save".
 * It exercises the exact request the panel builds, then re-reads the
 * settings the way reopening the panel would. It needs a running server, so
 * it is skipped rather than failed when there is not one, so that `npm run
 * check` stays usable without a dev server.
 */
const base = process.env.XANA_URL ?? "http://127.0.0.1:4310";

/** Exactly what ModelPanel's modelPatch() produces for a typed key. */
function panelPatch({ apiKey, clearApiKey } = {}) {
  return {
    model: {
      enabled: true,
      provider: "openai",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      temperature: 0.7,
      ...(clearApiKey ? { clearApiKey: true } : apiKey ? { apiKey } : {}),
    },
  };
}

async function keyRoundTrip() {
  let reachable = true;
  try {
    await fetch(`${base}/api/settings`, { signal: AbortSignal.timeout(2500) });
  } catch {
    reachable = false;
  }
  if (!reachable) {
    console.log(`  skip  no server at ${base} (start one, or set XANA_URL)`);
    return;
  }

  /**
   * What the user had before this ran.
   *
   * This test talks to the REAL settings endpoint on the running server, so it
   * writes a key and switches the model on in the user's own configuration. The
   * intent was always to put it back — the cleanup did clear the key — but it
   * also asserted the model was off afterwards, which is only true if it had
   * been off beforehand. On a machine where the user had deliberately switched
   * the model on and given it a real key, this test would have:
   *
   *   1. overwritten their key with `sk-roundtrip-…`,
   *   2. left that invalid key stored, with the model still enabled, and
   *   3. failed two of its own assertions while doing it.
   *
   * The failure was the visible part, and the least bad part. So the state is
   * captured first and restored last, and the assertions compare against what
   * was actually there rather than against a hardcoded expectation.
   */
  const original = (await (await fetch(`${base}/api/settings`)).json()).settings?.model ?? {};
  /**
   * Only a key that lives in the settings FILE is at risk.
   *
   * A key from the environment is not touched by anything here — the store has
   * no way to write it — so warning about it would be crying wolf, and a warning
   * that fires on a correct setup is one people learn to ignore.
   */
  const hadStoredKey = original.apiKey?.present === true && original.apiKey?.from === "settings";

  const put = async (settings) => {
    const res = await fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings }),
    });
    return (await res.json()).settings;
  };

  const secret = `sk-roundtrip-${Date.now().toString(36)}`;

  // 1. Save a typed key, the way the panel's Save button does.
  const saved = await put(panelPatch({ apiKey: secret }));
  check(
    "saving a typed key reports it as present",
    saved?.model?.apiKey?.present === true,
    `present=${saved?.model?.apiKey?.present}`,
  );
  check(
    "the mask shows the last four characters of what was typed",
    saved?.model?.apiKey?.masked?.endsWith(secret.slice(-4)),
    saved?.model?.apiKey?.masked,
  );
  check(
    "the base URL without /v1 was normalised on save",
    saved?.model?.baseUrl === "https://api.deepseek.com/v1",
    saved?.model?.baseUrl,
  );
  check(
    "the model is reported as active, so replies will use it",
    saved?.effective?.active === true,
  );

  // 2. Re-read, the way reopening the panel does.
  const reread = (await (await fetch(`${base}/api/settings`)).json()).settings;
  check(
    "the key is still there after a fresh read",
    reread?.model?.apiKey?.present === true,
  );
  check(
    "and the raw key was never sent to the browser",
    !JSON.stringify(reread).includes(secret),
    "the response body contained the literal key",
  );

  // 3. Save again with the field empty, which must not wipe it.
  const kept = await put(panelPatch({}));
  check(
    "leaving the field empty keeps the stored key",
    kept?.model?.apiKey?.present === true,
  );

  // 4. A failing model call must SAY so, rather than silently answering
  //    locally. This is the regression that made a stored key look ignored:
  //    the reply said `local` with no explanation, which is identical to the
  //    reply when no model was ever configured.
  const failing = await put({
    model: { enabled: true, apiKey: "sk-deliberately-invalid-for-the-failure-test" },
  });
  // The detail matters: this asserts a field of a response, and when it fails
  // the question is always "what came back instead" — a bare FAIL here sent
  // one run looking for a bug in the model switch that was really a response
  // the script had not printed.
  check(
    "a broken key still leaves the model switched on",
    failing?.model?.enabled === true,
    JSON.stringify(failing)?.slice(0, 240),
  );

  const chat = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hello there", sessionId: "verify-providers" }),
  });
  const reply = (await chat.json()).message;
  check(
    "the reply falls back to the local engine",
    reply?.engine === "local",
    reply?.engine,
  );
  check(
    "and the reply carries the reason it fell back",
    typeof reply?.modelError === "string" && reply.modelError.length > 0,
    "a silent fallback is the bug this asserts against",
  );
  check(
    "the reason names the actual cause rather than being generic",
    /key|refus|reject|unreach|not found|timed out|limit/i.test(reply?.modelError ?? ""),
    reply?.modelError,
  );
  console.log(`  info  fallback reason: ${reply?.modelError}`);

  // 5. Leave the environment as it was found — genuinely, this time.
  //
  // A key that was already stored cannot be put back: the endpoint never returns
  // it, by design. So the honest outcome is to remove the test key, restore the
  // model switch to whatever it was, and SAY SO LOUDLY when a real key was
  // displaced, because a silent overwrite of someone's credentials is worse than
  // a failing test.
  await put({
    model: {
      ...panelPatch({ clearApiKey: true }).model,
      enabled: original.enabled === true,
    },
  });
  const cleared = (await (await fetch(`${base}/api/settings`)).json()).settings;
  /**
   * The assertion is about SOURCE, not presence.
   *
   * "no key present" is the wrong question and was a latent bug in this test:
   * when the user has a real key in `.env`, `present` is true no matter what
   * this test does, so the check fails on a correct configuration. What must be
   * true is that the test's own key is gone — the credential resolves from the
   * environment, or from nowhere, and never from the settings file.
   */
  check(
    "cleanup leaves the test key behind",
    cleared?.model?.apiKey?.from !== "settings",
    `from=${cleared?.model?.apiKey?.from}`,
  );
  check(
    "cleanup restores the model switch it found",
    cleared?.model?.enabled === (original.enabled === true),
    `was ${original.enabled}, now ${cleared?.model?.enabled}`,
  );

  if (hadStoredKey) {
    console.log(
      "  WARN  a stored API key was replaced by this test and could not be restored —\n" +
        "        the endpoint does not return keys. Re-enter yours in Settings > Model & key.",
    );
  }
}

await keyRoundTrip();

/* ------------------------------------------------------------------ */
section("Result");
console.log(`  ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exitCode = 1;
