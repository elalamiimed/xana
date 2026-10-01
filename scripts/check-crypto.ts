/**
 * The crypto quote: what CoinGecko returns, and what happens when it does not.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-crypto.ts
 *
 * WHAT IS BEING CHECKED
 *
 * The interesting failure is not "did a price arrive". It is the two ways a
 * quote line can be wrong without anyone noticing:
 *
 *   1. **A number that is not a number.** `simple/price` is public and
 *      unauthenticated, so its body is the one input here that no type can
 *      vouch for. A shape change, an error page or a rate-limit document has to
 *      come out as "no rows", not as `$NaN +0.00%` printed on the card.
 *   2. **The network taking the day down.** A request that fails must leave a
 *      status row saying why and contribute nothing to `finance[]` — an adapter
 *      that throws from `fetch` takes the whole life state with it.
 *
 * parseCoinGecko is checked directly on a fixture, and then the adapter is
 * checked on the same fixture through a stubbed `fetch`, because the labels and
 * the trends are the adapter's work and not the parser's.
 *
 * NO NETWORK
 *
 * `globalThis.fetch` is replaced for every call below and restored in a
 * `finally`; the last group asserts it points at the real one again. The stub is
 * also a counter, which is how "no request is made with nothing to ask for" and
 * "two reads inside the TTL make one request" are proved.
 *
 * ISOLATION
 *
 * `XANA_DATA_DIR` is moved to a temp directory BEFORE the settings store is
 * imported, because `cred()` reads settings.json and `XANA_CRYPTO_COINS` before
 * it falls back to the built-in list — a settings file in the working tree
 * would otherwise decide what this run asserts. The settings file is created
 * immediately, because `migrateLegacySettings()` moves `<cwd>/.xana/settings.json`
 * into the data dir when the target does not exist, which would MOVE a real file
 * out of the user's project.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LifeAdapter, LifeSnapshot } from "../src/lib/adapters/types";
import type { AdapterStatus, FinanceSignal } from "../src/lib/core/types";
import type { PluginDescriptor } from "../src/lib/plugins/types";

/* ------------------------------------------------------------------ */
/* The temp world, before any module that reads it                     */
/* ------------------------------------------------------------------ */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "xana-crypto-"));
process.env.XANA_DATA_DIR = DATA_DIR;
writeFileSync(path.join(DATA_DIR, "settings.json"), "{}\n", { encoding: "utf8", mode: 0o600 });

/** An exported variable would otherwise decide what the built-in list is. */
delete process.env.XANA_CRYPTO_COINS;
delete process.env.XANA_FINANCE_SYMBOLS;

/* ------------------------------------------------------------------ */
/* Imports, after the settings layer has been pointed at the temp dir  */
/* ------------------------------------------------------------------ */

const { cryptoAdapter, parseCoinGecko } = await import("../src/lib/adapters/crypto");
const { emptySnapshot } = await import("../src/lib/adapters/types");

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Every group is wrapped, so one unexpected throw cannot end the run. */
async function group(title: string, run: () => Promise<void> | void): Promise<void> {
  console.log(`\n${title}\n`);
  try {
    await run();
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${title} threw — ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface StubReply {
  status?: number;
  json?: unknown;
  /** A body that is not JSON at all: an error page, a rate-limit document. */
  jsonThrows?: boolean;
}

type StubHandler = (url: string) => StubReply;

interface FetchLog {
  calls: number;
  urls: string[];
}

/**
 * Replace `globalThis.fetch` for the duration of `run`, then put it back in a
 * `finally` whatever happens. A handler that throws is the dead-connection case;
 * a handler that is never called leaves `log.calls` at zero, which is what the
 * "nothing to ask for" check reads.
 */
async function withFetch<T>(handler: StubHandler, run: (log: FetchLog) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const log: FetchLog = { calls: 0, urls: [] };

  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    log.calls += 1;
    log.urls.push(url);
    const reply = handler(url);
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : String(status),
      text: async () => (reply.json === undefined ? "" : JSON.stringify(reply.json)),
      json: async () => {
        if (reply.jsonThrows) throw new SyntaxError("Unexpected token '<'");
        if (reply.json === undefined) throw new SyntaxError("Unexpected end of JSON input");
        return reply.json;
      },
    } as unknown as Response;
  };

  globalThis.fetch = stub as typeof fetch;
  try {
    return await run(log);
  } finally {
    globalThis.fetch = real;
  }
}

interface Read {
  /** What the adapter merged into `finance[]`, and nothing else. */
  signals: FinanceSignal[];
  status: AdapterStatus | undefined;
  /** The error the adapter threw, which must stay undefined: it never throws. */
  threw: string | undefined;
  calls: number;
  urls: string[];
}

/**
 * Run one adapter against one stub and hand back both halves of what it
 * produced: the slice it wrote and the row it reported. The snapshot starts
 * empty, so `signals` is the adapter's contribution — which is also how the
 * check proves it merges into `finance[]` rather than inventing a key.
 */
async function readWith(handler: StubHandler, build: () => LifeAdapter = cryptoAdapter): Promise<Read> {
  return withFetch(handler, async (log) => {
    const snapshot: LifeSnapshot = emptySnapshot();
    let status: AdapterStatus | undefined;
    let threw: string | undefined;
    try {
      status = await build().fetch(snapshot);
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    return { signals: snapshot.finance, status, threw, calls: log.calls, urls: log.urls };
  });
}

const detailOf = (read: Read): string => read.status?.detail ?? "";

const REAL_FETCH = globalThis.fetch;

/** The shape `simple/price` actually returns, for the default coin list. */
const QUOTES = {
  bitcoin: { usd: 67123.456, usd_24h_change: 2.4 },
  ethereum: { usd: 3200.5, usd_24h_change: -1.2 },
  solana: { usd: 148.2, usd_24h_change: 0.2 },
};

/* ------------------------------------------------------------------ */
/* The body, read into rows                                            */
/* ------------------------------------------------------------------ */

await group("The body, read into rows", () => {
  const rows = parseCoinGecko(QUOTES);
  check(
    "one row per coin, in the order the body listed them",
    rows.map((r) => r.id).join(",") === "bitcoin,ethereum,solana",
    rows.map((r) => r.id).join(","),
  );
  check(
    "each row carries the price and the change as numbers",
    rows.every((r) => typeof r.price === "number" && typeof r.change === "number"),
    JSON.stringify(rows),
  );
  check(
    "and the values are the ones from the body",
    rows[0]?.price === 67123.456 && rows[1]?.change === -1.2,
    JSON.stringify(rows[0]),
  );

  // The guard that matters. Every one of these is a body the endpoint could
  // plausibly return, and none of them may become a price on the card.
  check(
    "a row with no price is dropped rather than priced at zero",
    parseCoinGecko({ bitcoin: {}, ethereum: { usd: null } }).length === 0,
  );
  check("a price sent as a string is not coerced", parseCoinGecko({ bitcoin: { usd: "67000" } }).length === 0);
  check(
    "a zero or negative price is not a quote",
    parseCoinGecko({ a: { usd: 0 }, b: { usd: -1 } }).length === 0,
  );
  check(
    "a non-finite price is not a quote",
    parseCoinGecko({ a: { usd: Number.POSITIVE_INFINITY }, b: { usd: Number.NaN } }).length === 0,
  );
  check("a missing change reads as flat, not as NaN", parseCoinGecko({ bitcoin: { usd: 5 } })[0]?.change === 0);
  check(
    "a change sent as a string reads as flat too",
    parseCoinGecko({ bitcoin: { usd: 5, usd_24h_change: "2.4" } })[0]?.change === 0,
  );
  check(
    "an empty or non-object body yields no rows",
    parseCoinGecko({}).length === 0 &&
      parseCoinGecko(null).length === 0 &&
      parseCoinGecko([QUOTES]).length === 0 &&
      parseCoinGecko("nope").length === 0,
  );
});

/* ------------------------------------------------------------------ */
/* What lands on the card                                              */
/* ------------------------------------------------------------------ */

await group("What lands on the card", async () => {
  const read = await readWith(() => ({ json: QUOTES }));
  const st = read.status;

  check("the adapter did not throw", read.threw === undefined, read.threw);
  check("three coins become three finance lines", read.signals.length === 3, String(read.signals.length));
  check(
    "labelled by name, in the order they were asked for",
    read.signals.map((s) => s.label).join(", ") === "Bitcoin, Ethereum, Solana",
    read.signals.map((s) => s.label).join(", "),
  );
  check("a rise over half a percent reads as up", read.signals[0]?.trend === "up", String(read.signals[0]?.trend));
  check("a fall over half a percent reads as down", read.signals[1]?.trend === "down", String(read.signals[1]?.trend));
  check("a move inside the band reads as flat", read.signals[2]?.trend === "flat", String(read.signals[2]?.trend));
  check(
    "above a thousand the price is grouped, to at most two decimals",
    read.signals[0]?.value === "$67,123.46 +2.40%",
    String(read.signals[0]?.value),
  );
  // Not `3,200.50`: the band above a thousand keeps *at most* two decimals, so
  // a trailing zero is a digit the price does not have. `67,000.00` on the line
  // above would be the same mistake in the other direction.
  check(
    "a few thousand is grouped and its cents are kept",
    read.signals[1]?.value === "$3,200.5 -1.20%",
    String(read.signals[1]?.value),
  );
  check("the note names the window the change covers", read.signals.every((s) => s.note === "24h"));
  check(
    "the status counts the lines",
    st !== undefined && st.state === "connected" && st.mode === "live" && st.detail === "3 coins",
    `${st?.state}/${st?.mode}/${st?.detail}`,
  );
  check(
    "and it is keyless: one simple/price call for the three ids",
    read.calls === 1 &&
      read.urls[0] ===
        "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd&include_24hr_change=true",
    read.urls.join(" "),
  );
});

/* ------------------------------------------------------------------ */
/* Coins below a dollar                                                */
/* ------------------------------------------------------------------ */

await group("Coins below a dollar", async () => {
  process.env.XANA_CRYPTO_COINS = "dogecoin, shiba-inu, usd-coin";
  try {
    const read = await readWith(() => ({
      json: {
        dogecoin: { usd: 0.0842137, usd_24h_change: 0.1 },
        "shiba-inu": { usd: 0.0000123456, usd_24h_change: 0 },
        "usd-coin": { usd: 1.0001, usd_24h_change: 0 },
      },
    }));

    check(
      "the list is used as given, lowercased and in order",
      read.urls[0]?.includes("ids=dogecoin,shiba-inu,usd-coin") === true,
      read.urls[0],
    );
    check(
      "a sub-dollar price keeps its significant digits",
      read.signals[0]?.value === "$0.0842137 +0.10%",
      String(read.signals[0]?.value),
    );
    check(
      "a very small price is not rounded to $0.00",
      read.signals[1]?.value === "$0.0000123456 +0.00%",
      String(read.signals[1]?.value),
    );
    check(
      "a coin at a dollar gets two decimals",
      read.signals[2]?.value === "$1.00 +0.00%",
      String(read.signals[2]?.value),
    );
    check(
      "an id that is not a name is spelled out rather than title-cased",
      read.signals[2]?.label === "USDC",
      String(read.signals[2]?.label),
    );
    check("a hyphenated id keeps its words apart", read.signals[1]?.label === "Shiba Inu", String(read.signals[1]?.label));
  } finally {
    delete process.env.XANA_CRYPTO_COINS;
  }
});

/* ------------------------------------------------------------------ */
/* Reading the coin list                                               */
/* ------------------------------------------------------------------ */

await group("Reading the coin list", async () => {
  const run = async (raw: string): Promise<Read> => {
    process.env.XANA_CRYPTO_COINS = raw;
    try {
      return await readWith(() => ({ json: QUOTES }));
    } finally {
      delete process.env.XANA_CRYPTO_COINS;
    }
  };

  const mixed = await run(" BitCoin , !!! , eth-2 ");
  check(
    "ids are lowercased and junk is dropped before the request",
    mixed.urls[0]?.includes("ids=bitcoin,eth-2&") === true,
    mixed.urls[0],
  );

  const capped = await run("btc,eth,sol,doge,xrp,ada,dot,link,uni,atom,ltc,bch");
  check(
    "the list is capped at eight ids",
    capped.urls[0]?.split("ids=")[1]?.split("&")[0]?.split(",").length === 8,
    capped.urls[0],
  );

  const repeated = await run("bitcoin, bitcoin, BITCOIN");
  check("a repeated id is asked for once", repeated.urls[0]?.includes("ids=bitcoin&") === true, repeated.urls[0]);
});

/* ------------------------------------------------------------------ */
/* When the answer is not a quote                                      */
/* ------------------------------------------------------------------ */

await group("When the answer is not a quote", async () => {
  const cases: Array<[string, StubHandler, string]> = [
    ["a body with no coins in it", () => ({ json: {} }), "no usable quote in the response"],
    ["a coin with no price", () => ({ json: { bitcoin: {} } }), "no usable quote in the response"],
    ["a body that is not JSON", () => ({ jsonThrows: true }), ""],
    ["a rate limit", () => ({ status: 429 }), "HTTP 429"],
    [
      "a dead connection",
      () => {
        throw new Error("getaddrinfo ENOTFOUND api.coingecko.com");
      },
      "ENOTFOUND",
    ],
  ];

  for (const [label, handler, expected] of cases) {
    const read = await readWith(handler);
    const st = read.status;
    check(`${label}: the adapter still returns`, read.threw === undefined, read.threw);
    check(`${label}: nothing is merged into finance`, read.signals.length === 0, String(read.signals.length));
    check(
      `${label}: it reports error / local`,
      st !== undefined && st.state === "error" && st.mode === "local",
      `${st?.state}/${st?.mode}`,
    );
    check(
      `${label}: and the detail says what happened`,
      detailOf(read).length > 0 && detailOf(read).includes(expected),
      detailOf(read),
    );
  }
});

/* ------------------------------------------------------------------ */
/* Nothing to ask for                                                  */
/* ------------------------------------------------------------------ */

await group("Nothing to ask for", async () => {
  process.env.XANA_CRYPTO_COINS = "!!!, ???";
  try {
    const read = await readWith(() => {
      throw new Error("a request was made with no usable coin id");
    });
    check("a list that filters to nothing makes no request", read.calls === 0, String(read.calls));
    check(
      "and it is reported rather than passed off as an empty day",
      read.status?.state === "error" && detailOf(read).includes("no coin id"),
      `${read.status?.state}: ${detailOf(read)}`,
    );
    check("with nothing merged into finance", read.signals.length === 0, String(read.signals.length));
    check("and no throw", read.threw === undefined, read.threw);
  } finally {
    delete process.env.XANA_CRYPTO_COINS;
  }
});

/* ------------------------------------------------------------------ */
/* The descriptor it will be wired to                                  */
/* ------------------------------------------------------------------ */

/**
 * A copy of the `DESCRIPTORS` entry the lead pastes into `plugins/registry.ts`,
 * kept here so the wiring is checked before it exists. `assertBootContract`
 * throws at import time on a config key that is not storable, a network
 * capability with no host, or `core` on a plugin that leaves the machine — all
 * three rules are asserted below against the real lists, so the paste cannot
 * fail at boot. This is a proof the recommendation fits, not a second source of
 * truth: if the entry changes, change it here too.
 */
const DESCRIPTOR: PluginDescriptor = {
  id: "crypto",
  name: "Crypto",
  category: "signal",
  kind: "service",
  tagline: "Coin prices beside the markets, with no key to paste.",
  dataNote:
    "Sends the coin ids you list to api.coingecko.com. The list is visible to them; nothing else is sent, and no key or account is involved.",
  provides: "A line per coin — its price and 24h move — in the same signals as the markets.",
  needs: [{ kind: "net.read", reason: "Fetch coin prices.", hosts: ["api.coingecko.com"] }],
  config: [
    {
      key: "crypto.coins",
      label: "Coins",
      hint: "CoinGecko ids, comma separated. Empty means bitcoin, ethereum and solana.",
      kind: "text",
      example: "bitcoin, ethereum, solana",
      // Not `required`: the adapter has a working default of three coins, and a
      // required field with no value would leave the card reading "not ready"
      // for a plugin that in fact works out of the box.
      required: false,
    },
  ],
};

await group("The descriptor it will be wired to", async () => {
  const { PLUGIN_SETTING_KEYS } = await import("../src/lib/settings/types");
  const read = await readWith(() => ({ json: QUOTES }));
  const declared = DESCRIPTOR.needs[0]?.hosts?.[0] ?? "";
  const requested = read.urls.length > 0 ? new URL(read.urls[0]).host : "(no request)";

  check(
    "the plugin id and the status row id are the same",
    DESCRIPTOR.id === cryptoAdapter().id,
    `${DESCRIPTOR.id} / ${cryptoAdapter().id}`,
  );
  check(
    "the config key is in the settings allowlist, so boot accepts it",
    (PLUGIN_SETTING_KEYS as readonly string[]).includes(DESCRIPTOR.config?.[0]?.key ?? ""),
    String(DESCRIPTOR.config?.[0]?.key),
  );
  check(
    "the host named in the consent prompt is the host actually requested",
    declared.length > 0 && requested === declared,
    `declared ${declared}, requested ${requested}`,
  );
  check(
    "and it is not core, which a plugin that leaves the machine cannot be",
    DESCRIPTOR.core !== true,
  );
});

/* ------------------------------------------------------------------ */
/* The cache, and the stub                                             */
/* ------------------------------------------------------------------ */

await group("The cache, and the stub", async () => {
  const cached = await withFetch(() => ({ json: QUOTES }), async (log) => {
    const snapshot = emptySnapshot();
    const adapter = cryptoAdapter();
    const first = await adapter.fetch(snapshot);
    const second = await adapter.fetch(snapshot);
    return { calls: log.calls, first, second };
  });
  check("two reads inside the TTL make one request", cached.calls === 1, String(cached.calls));
  check("and the second read reports the same row", cached.first === cached.second, "the cache handed back a new row");
  check("globalThis.fetch points at the real fetch again", globalThis.fetch === REAL_FETCH, "still a stub");
});

/* ------------------------------------------------------------------ */
/* Done                                                                */
/* ------------------------------------------------------------------ */

rmSync(DATA_DIR, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
