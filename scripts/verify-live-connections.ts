/**
 * The connections surface and the phone door, over real HTTP.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/verify-live-connections.ts
 *   node --import ./scripts/ts-loader.mjs scripts/verify-live-connections.ts http://127.0.0.1:4310
 *
 * WHY THIS EXISTS BESIDE check-plugins AND check-health-bridge
 *
 * Those two prove the gate and the ingest in-process, with `fetch` stubbed and
 * the store swapped. What they cannot prove is the transport and the wiring: that
 * the route modules Next actually serves re-export the handlers we think they do,
 * that the alias paths answer byte-for-byte the same body, and that a grant made
 * over `POST /api/connections` changes what the *next* request does.
 *
 * TWO PARTS, AND WHY THEY RUN AGAINST DIFFERENT SERVERS
 *
 * Part A is read-only — alias parity and the refusals — and runs against a server
 * that is already up (the real `next dev`), because those checks are about the
 * running app and mutate nothing.
 *
 * Part B starts its own `node:http` server over the REAL route modules with
 * `XANA_DATA_DIR` pointed at a temp directory. It has to: Next refuses a second
 * `next dev` in the same directory ("Another next dev server is already
 * running"), and the grant round trip, the settings write and the phone ingest
 * all write. Doing that to the real `data/settings.json` and `data/xana.db` would
 * leave the user's install changed, so the harness gives the same handlers a
 * scratch life instead.
 *
 * `globalThis.fetch` is replaced for the gate checks below and restored after
 * each one. The script's own HTTP calls use the real `fetch` captured at boot, so
 * a stub can never intercept the transport it is measuring.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

/* ------------------------------------------------------------------ */
/* Harness                                                            */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
let skipped = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(label: string, why: string): void {
  skipped += 1;
  console.log(`  skip  ${label} — ${why}`);
}

async function group(title: string, run: () => Promise<void> | void): Promise<void> {
  console.log(`\n${title}\n`);
  try {
    await run();
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${title} threw — ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The real transport, captured before any stub can shadow it. */
const REAL_FETCH = globalThis.fetch;

interface Reply {
  status: number;
  text: string;
}

async function request(
  base: string,
  method: string,
  urlPath: string,
  init: RequestInit = {},
): Promise<Reply> {
  const response = await REAL_FETCH(`${base}${urlPath}`, { method, ...init });
  return { status: response.status, text: await response.text() };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function messageOf(text: string): string {
  const body = asRecord(JSON.parse(text) as unknown);
  return typeof body.message === "string" ? body.message : "";
}

/** Source rows out of a life state, whatever shape the body arrived in. */
function sourcesOf(text: string): Array<Record<string, unknown>> {
  const life = asRecord(asRecord(JSON.parse(text) as unknown).lifeState);
  return Array.isArray(life.sources) ? (life.sources as Array<Record<string, unknown>>) : [];
}

function financeOf(text: string): unknown[] {
  const life = asRecord(asRecord(JSON.parse(text) as unknown).lifeState);
  return Array.isArray(life.finance) ? (life.finance as unknown[]) : [];
}

const rowFor = (rows: Array<Record<string, unknown>>, id: string) =>
  rows.find((row) => row.id === id);

/* ------------------------------------------------------------------ */
/* Part A — the running server, read-only                             */
/* ------------------------------------------------------------------ */

const LIVE_BASE = (process.argv[2] ?? "http://127.0.0.1:4310").replace(/\/+$/, "");

async function liveServerAnswers(base: string): Promise<boolean> {
  try {
    const response = await REAL_FETCH(`${base}/api/state`, { signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch {
    return false;
  }
}

await group(`Part A — ${LIVE_BASE}, the running server (read-only)`, async () => {
  if (!(await liveServerAnswers(LIVE_BASE))) {
    skip("every Part A check", `${LIVE_BASE} is not answering`);
    return;
  }

  const canonical = await request(LIVE_BASE, "GET", "/api/connections");
  check("GET /api/connections answers 200", canonical.status === 200, String(canonical.status));

  const body = asRecord(JSON.parse(canonical.text) as unknown);
  const rows = Array.isArray(body.plugins) ? (body.plugins as unknown[]) : [];
  const groups = Array.isArray(body.groups) ? (body.groups as Array<Record<string, unknown>>) : [];
  console.log(
    `        rows=${rows.length} groups=${groups.map((g) => `${g.kind}:${(g.plugins as unknown[]).length}`).join(" ")}`,
  );
  check("the surface reports rows", rows.length > 0, String(rows.length));
  check("it is grouped into the four kinds", groups.length === 4, String(groups.length));

  // Byte parity, not structural parity: these paths run the same function, so a
  // difference here would mean the alias is a copy that has started to drift.
  const aliases = [
    ["/api/plugins", canonical.text],
    ["/xana/connections", canonical.text],
    ["/xana/plugins", canonical.text],
  ] as const;
  for (const [path, expected] of aliases) {
    const reply = await request(LIVE_BASE, "GET", path);
    check(
      `GET ${path} is byte-identical to /api/connections`,
      reply.status === 200 && reply.text === expected,
      `${reply.status}, ${reply.text.length} vs ${expected.length} bytes`,
    );
  }

  for (const [label, payload] of [
    ["an unknown connection id", { id: "not-a-connection", action: "grant" }],
    ["an unknown action", { id: "crypto", action: "explode" }],
    ["an empty body", {}],
  ] as const) {
    const reply = await request(LIVE_BASE, "POST", "/api/connections", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    check(
      `POST /api/connections refuses ${label} with a 4xx`,
      reply.status >= 400 && reply.status < 500,
      `${reply.status} ${messageOf(reply.text)}`,
    );
  }

  for (const path of ["/api/connections/google/callback", "/api/plugins/google/callback"]) {
    const reply = await request(LIVE_BASE, "GET", path);
    check(
      `GET ${path} without parameters is a 400 page, not a 404`,
      reply.status === 400 && reply.text.includes("Nothing to do"),
      `${reply.status}, "Nothing to do" present=${reply.text.includes("Nothing to do")}`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* Part B — the same handlers over real HTTP, on a scratch life        */
/* ------------------------------------------------------------------ */

type Handler = (request: Request) => Promise<Response>;

interface Route {
  load: () => Promise<Handler>;
}

/**
 * A node:http server in front of the real route modules.
 *
 * Deliberately the same shape as `scripts/serve.ts`: the point is that the
 * handler modules under `src/app` are loaded exactly as Next loads them, so a
 * broken re-export or a wrong path fails here.
 */
function harness(routes: Map<string, Route>) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = routes.get(`${req.method} ${url.pathname}`);
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", path: url.pathname }));
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body =
        req.method === "POST" || req.method === "PUT"
          ? Buffer.concat(chunks).toString("utf8")
          : undefined;
      const request = new Request(url.toString(), {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body,
      });
      const handler = await route.load();
      const response = await handler(request);
      const text = await response.text();
      const headers: Record<string, string> = { "content-type": "application/json" };
      response.headers.forEach((value, name) => {
        if (name.toLowerCase() !== "content-length") headers[name] = value;
      });
      res.writeHead(response.status, headers);
      res.end(text);
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "handler_threw",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  });
}

await group("Part B — the surface and the phone door on a scratch life", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "xana-live-"));
  process.env.XANA_DATA_DIR = dataDir;
  /**
   * Written before any module reads it: with a fresh data dir and no file,
   * `migrateLegacySettings()` would MOVE `<cwd>/.xana/settings.json` into the
   * temp directory and delete it with the directory at the end of this run.
   */
  const settingsFile = path.join(dataDir, "settings.json");
  writeFileSync(settingsFile, "{}\n", { encoding: "utf8", mode: 0o600 });

  const { getRegistry } = await import("../src/lib/plugins/registry");
  const { XanaStore, getStore, setStore } = await import("../src/lib/core/store");

  /**
   * The store is swapped explicitly, and that is not belt-and-braces:
   * `core/store.ts`'s `defaultDbPath()` resolves `<projectRoot>/data/xana.db`
   * from the module's own location and reads no environment variable, so
   * `XANA_DATA_DIR` moves the settings file but NOT the database. Relying on the
   * variable here would have this script write health rows into the real
   * `data/xana.db` — which is exactly what the first version did.
   */
  setStore(new XanaStore(path.join(dataDir, "live.db")));

  const routes = new Map<string, Route>();
  const register = (method: string, pathname: string, load: () => Promise<Handler>) =>
    routes.set(`${method} ${pathname}`, { load });

  register("GET", "/api/connections", async () => (await import("../src/app/api/connections/route")).GET);
  register("POST", "/api/connections", async () => (await import("../src/app/api/connections/route")).POST);
  register("GET", "/api/plugins", async () => (await import("../src/app/api/plugins/route")).GET);
  register("POST", "/api/plugins", async () => (await import("../src/app/api/plugins/route")).POST);
  register("PUT", "/api/connections/settings", async () => (await import("../src/app/api/connections/settings/route")).PUT);
  register("PUT", "/api/plugins/settings", async () => (await import("../src/app/api/plugins/settings/route")).PUT);
  register("GET", "/xana/connections", async () => (await import("../src/app/xana/connections/route")).GET);
  register("POST", "/xana/connections", async () => (await import("../src/app/xana/connections/route")).POST);
  register("POST", "/api/health/ingest", async () => (await import("../src/app/api/health/ingest/route")).POST);
  register("POST", "/xana/health/ingest", async () => (await import("../src/app/xana/health/ingest/route")).POST);
  register("GET", "/api/context", async () => (await import("../src/app/api/context/route")).GET);

  const server = harness(routes);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const base = typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : "";

  const readSettings = (): Record<string, unknown> =>
    JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
  const permissions = (): Record<string, unknown> => asRecord(readSettings()["permissions"]);
  const sourceValues = (): Record<string, unknown> => asRecord(readSettings()["sources"]);
  const connectionJson = async (): Promise<Record<string, unknown>> =>
    asRecord(JSON.parse((await request(base, "GET", "/api/connections")).text) as unknown);
  const approve = async (action: "grant" | "revoke"): Promise<Reply> =>
    request(base, "POST", "/api/connections", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "crypto", action }),
    });

  try {
    /* ---- the register and the wire agree ------------------------- */

    const response = await connectionJson();
    const pluginRows = Array.isArray(response["plugins"]) ? (response["plugins"] as Array<Record<string, unknown>>) : [];
    const groupRows = Array.isArray(response["groups"]) ? (response["groups"] as Array<Record<string, unknown>>) : [];
    check(
      "the HTTP surface has one row per registered connection",
      pluginRows.length === getRegistry().list().length,
      `${pluginRows.length} rows for ${getRegistry().list().length} connections`,
    );
    check(
      "every group's counts add up to its cards",
      groupRows.every((item) => {
        const members = Array.isArray(item["plugins"]) ? (item["plugins"] as unknown[]) : [];
        return item["ready"] === undefined
          ? false
          : (item["ready"] as number) + (item["pending"] as number) === members.length;
      }),
      groupRows.map((item) => `${String(item["kind"])}:${String(item["ready"])}+${String(item["pending"])}`).join(", "),
    );

    /* ---- nothing granted: no request, no data -------------------- */

    check(
      "a fresh settings file holds no grants",
      Object.keys(permissions()).length === 0 || Object.values(permissions()).every((value) => value !== true),
      JSON.stringify(permissions()),
    );
    check(
      "and crypto starts blocked",
      rowFor(pluginRows, "crypto")?.["state"] === "blocked",
      String(rowFor(pluginRows, "crypto")?.["state"]),
    );

    /**
     * A refused action must not write, and the file is the proof: the API could
     * answer 4xx and still have stored something, which is the bug worth
     * catching. The bytes are compared, not the parsed document.
     */
    const beforeRefusals = readFileSync(settingsFile, "utf8");
    for (const [label, payload] of [
      ["an unknown connection id", { id: "not-a-connection", action: "grant" }],
      ["an unknown action", { id: "crypto", action: "explode" }],
      ["an empty body", {}],
    ] as const) {
      const reply = await request(base, "POST", "/api/connections", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      check(
        `POST /api/connections refuses ${label} with a 4xx`,
        reply.status >= 400 && reply.status < 500,
        `${reply.status} ${messageOf(reply.text)}`,
      );
    }
    check(
      "and a refusal wrote nothing to the settings file",
      readFileSync(settingsFile, "utf8") === beforeRefusals,
    );

    /**
     * A counting stub: it records the URLs a request tried to reach and throws,
     * so a call is both counted and unable to hang the run. Restore it in a
     * `finally` — the script's own transport uses the real `fetch`.
     */
    const stubWindow = (why: string) => {
      const urls: string[] = [];
      const real = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        throw new Error(`a request was made ${why}`);
      }) as typeof fetch;
      return { urls, restore: () => { globalThis.fetch = real; } };
    };

    /**
     * The gate, measured on a live HTTP request rather than in-process: with
     * nothing granted, assembling the life state must not open a socket.
     *
     * `force=1` matters here and is not decoration: `/api/context` serves the
     * assembled state from a four-second cache, and a cached answer is not a
     * decision the gate made. Without it this block would "prove" that nothing
     * was called by never calling anything at all.
     */
    const nothingGranted = stubWindow("with nothing granted");
    try {
      const state = await request(base, "GET", "/api/context?force=1");
      check("GET /api/context assembles while nothing is granted", state.status === 200, String(state.status));
      check(
        "and no plugin reached the network",
        nothingGranted.urls.length === 0,
        nothingGranted.urls.join(", "),
      );
      check("so finance carries nothing", financeOf(state.text).length === 0);
    } finally {
      nothingGranted.restore();
    }

    /* ---- the grant round trip, through the API ------------------- */

    const granted = await approve("grant");
    check("POST /api/connections grant answers 200", granted.status === 200, `${granted.status} ${messageOf(granted.text)}`);
    check(
      "the grant reached the settings file",
      permissions()["net.read"] === true,
      JSON.stringify(permissions()),
    );

    const grantedWindow = stubWindow("while only crypto is granted");
    try {
      const state = await request(base, "GET", "/api/context?force=1");
      const cryptoRow = rowFor(sourcesOf(state.text), "crypto");
      check(
        "the granted connection is no longer blocked",
        cryptoRow !== undefined && cryptoRow["state"] !== "blocked",
        `${String(cryptoRow?.["state"])} ${String(cryptoRow?.["detail"])}`,
      );
      check(
        "and crypto is one of the connections that got called",
        grantedWindow.urls.some((url) => url.includes("api.coingecko.com/api/v3/simple/price")),
        grantedWindow.urls.join(", "),
      );
      /**
       * A capability is shared, not per-connection: granting `net.read` for
       * crypto also satisfies markets, which needs nothing else. So the count
       * here is five (four stooq symbols and one CoinGecko), and asserting "one"
       * — as the first version of this script did — would have been asserting
       * the wrong model. What must NOT happen is a connection whose own
       * requirements are still unmet being called: weather still lacks
       * `location`, Todoist still lacks `account`, Google still lacks three.
       */
      const unmetElsewhere = ["open-meteo.com", "ipapi.co", "todoist.com", "googleapis.com"];
      check(
        "no connection with an unmet requirement was called",
        grantedWindow.urls.every((url) => !unmetElsewhere.some((host) => url.includes(host))),
        grantedWindow.urls.join(", "),
      );
      check(
        "and every request came from a connection whose capabilities are granted",
        grantedWindow.urls.every(
          (url) => url.includes("api.coingecko.com") || url.includes("stooq.com"),
        ),
        grantedWindow.urls.join(", "),
      );
    } finally {
      grantedWindow.restore();
    }

    const revoked = await approve("revoke");
    check("POST /api/connections revoke answers 200", revoked.status === 200, `${revoked.status} ${messageOf(revoked.text)}`);
    check(
      "the revoke reached the settings file",
      permissions()["net.read"] !== true,
      JSON.stringify(permissions()),
    );

    const revokedWindow = stubWindow("after a revoke");
    try {
      const state = await request(base, "GET", "/api/context?force=1");
      check(
        "the next request after a revoke does not call it again",
        revokedWindow.urls.length === 0,
        revokedWindow.urls.join(", "),
      );
      check(
        "and its row is blocked again",
        rowFor(sourcesOf(state.text), "crypto")?.["state"] === "blocked",
        String(rowFor(sourcesOf(state.text), "crypto")?.["state"]),
      );
    } finally {
      revokedWindow.restore();
    }

    check(
      "three refusals left the grants untouched",
      Object.values(permissions()).every((value) => value !== true),
      JSON.stringify(permissions()),
    );

    /* ---- secrets and the phone token ----------------------------- */

    const SECRET_TODOIST = "sentinel-todoist-token-must-not-echo";
    const SECRET_GOOGLE = "sentinel-google-client-secret-must-not-echo";
    const PHONE_TOKEN = "sentinel-phone-token-0123456789abcdef";
    const saved = await request(base, "PUT", "/api/connections/settings", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        values: {
          "tasks.token": SECRET_TODOIST,
          "google.clientSecret": SECRET_GOOGLE,
          "health.deviceToken": PHONE_TOKEN,
          "health.ingest": "on",
        },
      }),
    });
    check("PUT /api/connections/settings accepts four values", saved.status === 200, `${saved.status} ${messageOf(saved.text)}`);
    check(
      "they are on disk, not just in memory",
      sourceValues()["tasks.token"] === SECRET_TODOIST &&
        sourceValues()["health.deviceToken"] === PHONE_TOKEN &&
        sourceValues()["health.ingest"] === "on",
      Object.keys(sourceValues()).join(", "),
    );

    const listed = (await request(base, "GET", "/api/connections")).text;
    check(
      "a stored secret is never echoed in the response",
      !listed.includes(SECRET_TODOIST) && !listed.includes(SECRET_GOOGLE),
      `todoist=${listed.includes(SECRET_TODOIST)} google=${listed.includes(SECRET_GOOGLE)}`,
    );
    const listedBody = asRecord(JSON.parse(listed) as unknown);
    const listedRows = Array.isArray(listedBody["plugins"]) ? (listedBody["plugins"] as Array<Record<string, unknown>>) : [];
    const configOf = (id: string) => {
      const config = rowFor(listedRows, id)?.["config"];
      return Array.isArray(config) ? (config as Array<Record<string, unknown>>) : [];
    };
    const todoistField = configOf("tasks").find((item) => item["key"] === "tasks.token");
    check(
      "a secret reports presence and no value",
      todoistField?.["present"] === true && todoistField?.["value"] === undefined,
      JSON.stringify(todoistField),
    );
    /**
     * The health token is declared `text`, not `secret`, and this asserts the
     * consequence rather than leaving it implicit: it IS echoed, deliberately,
     * because the value exists to be carried to a phone. A build that quietly
     * turned it into a secret would break the only way to configure the phone.
     */
    check(
      "the phone token is echoed on purpose, so it can be copied to a device",
      listed.includes(PHONE_TOKEN),
      `present=${listed.includes(PHONE_TOKEN)}`,
    );

    /* ---- the phone door ------------------------------------------ */

    const sample = { date: "2026-02-01", sleepHours: 7.4, steps: 8420, restingHeartRate: 54, mood: "good" };
    const posted = await request(base, "POST", "/api/health/ingest", {
      headers: { "content-type": "application/json", "X-Device-Token": PHONE_TOKEN },
      body: JSON.stringify(sample),
    });
    const postedBody = asRecord(JSON.parse(posted.text) as unknown);
    check("a phone post is accepted", posted.status === 200, `${posted.status} ${posted.text.slice(0, 120)}`);
    check(
      "and answers { ok, days, lastDay }",
      postedBody["ok"] === true && postedBody["days"] === 1 && postedBody["lastDay"] === "2026-02-01",
      JSON.stringify(postedBody),
    );
    check("the ingest response does not carry the token", !posted.text.includes(PHONE_TOKEN));

    const again = await request(base, "POST", "/api/health/ingest", {
      headers: { "content-type": "application/json", "X-Device-Token": PHONE_TOKEN },
      body: JSON.stringify({ ...sample, steps: 9999 }),
    });
    const againBody = asRecord(JSON.parse(again.text) as unknown);
    const storedRows = getStore()
      .healthSamples(400)
      .filter((row) => row.date === "2026-02-01");
    const inStore = getStore()
      .healthSamples(400)
      .map((row) => `${row.date}:${String(row.steps)}:${row.source}`)
      .join(" | ");
    check(
      "the same day posted twice updates instead of duplicating",
      again.status === 200 && againBody["days"] === 1 && storedRows.length === 1 && storedRows[0]?.steps === 9999,
      `${storedRows.length} row(s), steps=${String(storedRows[0]?.steps)}; store: ${inStore}`,
    );

    const viaGateway = await request(base, "POST", "/xana/health/ingest", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: PHONE_TOKEN, date: "2026-02-02", steps: 1200 }),
    });
    check(
      "the gateway path runs the same handler",
      viaGateway.status === 200 && asRecord(JSON.parse(viaGateway.text) as unknown)["lastDay"] === "2026-02-02",
      `${viaGateway.status} ${viaGateway.text.slice(0, 120)}`,
    );
    check(
      "and the newest row in the store is the one the phone sent",
      getStore().lastHealthSource()?.day === "2026-02-02" &&
        getStore().lastHealthSource()?.source === "device",
      JSON.stringify(getStore().lastHealthSource()),
    );

    const noToken = await request(base, "POST", "/api/health/ingest", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date: "2026-02-03", steps: 10 }),
    });
    check(
      'a post with no token is 400 "No device token"',
      noToken.status === 400 && messageOf(noToken.text) === "No device token",
      `${noToken.status} ${messageOf(noToken.text)}`,
    );

    const wrongToken = await request(base, "POST", "/api/health/ingest", {
      headers: { "content-type": "application/json", "X-Device-Token": "not-the-token" },
      body: JSON.stringify({ date: "2026-02-03", steps: 10 }),
    });
    check(
      'a wrong token is 403 "That token is not right."',
      wrongToken.status === 403 && messageOf(wrongToken.text) === "That token is not right.",
      `${wrongToken.status} ${messageOf(wrongToken.text)}`,
    );
    check(
      "and no row was written for the refused day",
      getStore().healthSamples(20).every((row) => row.date !== "2026-02-03"),
    );

    const switchedOff = await request(base, "PUT", "/api/plugins/settings", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: { "health.ingest": "off" } }),
    });
    check("the alias writes settings too", switchedOff.status === 200, String(switchedOff.status));
    const refused = await request(base, "POST", "/api/health/ingest", {
      headers: { "content-type": "application/json", "X-Device-Token": PHONE_TOKEN },
      body: JSON.stringify({ date: "2026-02-04", steps: 55 }),
    });
    check(
      'with the switch off the answer is 409 "Phone ingest is off."',
      refused.status === 409 && messageOf(refused.text) === "Phone ingest is off.",
      `${refused.status} ${messageOf(refused.text)}`,
    );

    /* ---- the aliases on this harness ----------------------------- */

    const canonical = await request(base, "GET", "/api/connections");
    const alias = await request(base, "GET", "/api/plugins");
    check(
      "GET /api/plugins is byte-identical to /api/connections here too",
      alias.status === 200 && alias.text === canonical.text,
      `${alias.text.length} vs ${canonical.text.length} bytes`,
    );
  } finally {
    // `fetch` keeps its sockets alive, and `close()` waits for them: without
    // dropping the connections first this script would sit here until the
    // keep-alive timeout and look like a hang.
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    try {
      getStore().close();
    } catch {
      /* the store may never have been opened; nothing to release */
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Result                                                             */
/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ""}\n`);
process.exit(failed === 0 ? 0 : 1);
