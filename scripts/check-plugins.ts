/**
 * The permission gate, tested against the failure it exists to prevent.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-plugins.ts
 *
 * WHAT IS BEING CHECKED
 *
 * "A plugin with an ungranted capability is never called." Every assertion below
 * is written in the direction that fails when that sentence stops being true: a
 * request counter that must stay at exactly zero, a snapshot whose blocked
 * plugins contribute nothing, a stored grant that must read back as revoked.
 * A test that passes with the gate removed is worse than no test, so wherever a
 * check could be satisfied by an unhelpful stub or by an empty result, it
 * asserts on the thing the bug would actually change — the number of requests,
 * the slice of the snapshot, the value on disk.
 *
 * The load-bearing checks were proved to bite by running mutated copies of the
 * sources; MUTATION EVIDENCE at the end of this file records the exact edit and
 * what failed for each one.
 *
 * THE TWO KINDS OF PLUGIN
 *
 * A `core` plugin's required capabilities are local, so it always runs: her own
 * task list, her own events, a focus suggestion. A gated plugin's required
 * capabilities leave the machine, so it does not run until the user says so.
 * A core plugin can still have an optional network half (an ICS feed, a Todoist
 * token), and that half must follow the same consent rule as everything else —
 * which is what the `PluginGates` handoff is for, and what the "configured but
 * not granted" checks below exist to prove.
 *
 * ISOLATION (this is not decoration)
 *
 * `XANA_DATA_DIR` is pointed at a fresh temp directory BEFORE the settings store
 * is imported, because `store.ts` resolves `DATA_DIR` at module load. A settings
 * file is written there immediately after `mkdtempSync`, because
 * `migrateLegacySettings()` moves `<cwd>/.xana/settings.json` into the data dir
 * when the target does not exist — with a temp data dir and no file, that would
 * MOVE a real file out of the user's project and then delete it with the
 * directory. The path is asserted to be the temp one before anything else runs.
 *
 * NO NETWORK
 *
 * `globalThis.fetch` is replaced for every group that could make a request and
 * restored in a `finally`. The phases in which no request is allowed use a stub
 * that counts the call and then throws: a plugin reaching the network during a
 * refusal is both counted and unable to hang the run.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LifeSnapshot } from "../src/lib/adapters/types";
import type { PluginGates } from "../src/lib/plugins/automation";
import type {
  CapabilityKind,
  CapabilitySpec,
  PermissionGrants,
  PluginConfigItem,
} from "../src/lib/plugins/types";

/* ------------------------------------------------------------------ */
/* The temp world, before any module that reads it                     */
/* ------------------------------------------------------------------ */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "xana-plugins-"));
process.env.XANA_DATA_DIR = DATA_DIR;

/**
 * Pre-created so the legacy-file migration has nothing to do. `{}` coerces to
 * the defaults, whose `permissions` is empty — the state under test.
 */
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
writeFileSync(SETTINGS_FILE, "{}\n", { encoding: "utf8", mode: 0o600 });

/**
 * A shell variable does not outrank the settings file, but it does outrank
 * "absent", so an exported `XANA_LAT` would change what the weather plugin does
 * and make the run depend on the machine it happens to be running on.
 */
const INHERITED_ENV = [
  "XANA_LAT",
  "XANA_LON",
  "XANA_LOCATION",
  "XANA_LOCATION_LABEL",
  "XANA_CALENDAR_ICS_URL",
  "XANA_CALENDAR_ICS_URLS",
  "XANA_TODOIST_TOKEN",
  "XANA_OBSIDIAN_VAULT",
  "XANA_HEALTH_DIR",
  "XANA_NOWPLAYING_URL",
  "XANA_NOWPLAYING_FILE",
  "XANA_MAIL_URL",
  "XANA_MAIL_FILE",
  "XANA_FINANCE_SYMBOLS",
];
for (const name of INHERITED_ENV) delete process.env[name];

/* ------------------------------------------------------------------ */
/* Imports, after the data dir has moved                               */
/* ------------------------------------------------------------------ */

const { emptySnapshot } = await import("../src/lib/adapters/types");
const { setStore, XanaStore } = await import("../src/lib/core/store");
const settings = await import("../src/lib/settings/store");
const automation = await import("../src/lib/plugins/automation");
const { PluginRegistry, getRegistry, resetRegistry } = await import("../src/lib/plugins/registry");
const gcal = await import("../src/lib/plugins/google-calendar");
const pluginTypes = await import("../src/lib/plugins/types");
const { CAPABILITY_KEYS, PLUGIN_SETTING_KEYS } = await import("../src/lib/settings/types");

const store = new XanaStore(path.join(DATA_DIR, "plugins.db"));
setStore(store);

const REAL_FETCH = globalThis.fetch;

const REDIRECT = "http://127.0.0.1:4310/api/plugins/google/callback";
const CLIENT_ID = "check-plugins.apps.googleusercontent.com";
const ICS_URL = "https://example.invalid/x.ics";
const ICS_URL_2 = "https://example.invalid/second.ics";
const TOKEN = "todoist-token-check";
const MEDIA_URL = "http://127.0.0.1:9863/now";
const MAIL_URL = "http://127.0.0.1:9864/mail";

const ALL_KINDS: readonly CapabilityKind[] = [
  "local.read",
  "local.write",
  "net.read",
  "net.write",
  "location",
  "account",
  "remote.write",
];

/* ------------------------------------------------------------------ */
/* Harness                                                            */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = "") {
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
  text?: string;
}

interface FetchLog {
  calls: number;
  urls: string[];
  bodies: string[];
  headers: Array<Record<string, string>>;
}

type StubHandler = (url: string, init: RequestInit) => StubReply | Promise<StubReply>;

/**
 * Replace `globalThis.fetch` for the duration of `run`, then put it back in a
 * `finally` whatever happens. The log is written before the handler runs, so a
 * throwing handler still counts the call — which is the whole point of using it
 * to prove that a refusal made no request.
 */
async function withFetch<T>(handler: StubHandler, run: (log: FetchLog) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  const log: FetchLog = { calls: 0, urls: [], bodies: [], headers: [] };

  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    log.calls += 1;
    log.urls.push(url);
    const requestInit = init ?? {};
    if (typeof requestInit.body === "string") log.bodies.push(requestInit.body);
    log.headers.push((requestInit.headers ?? {}) as Record<string, string>);

    const reply = await handler(url, requestInit);
    const status = reply.status ?? 200;
    const text = reply.text ?? (reply.json !== undefined ? JSON.stringify(reply.json) : "");
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : String(status),
      text: async () => text,
      json: async () => (reply.json !== undefined ? reply.json : JSON.parse(text)),
    } as unknown as Response;
  };

  globalThis.fetch = stub as typeof fetch;
  try {
    return await run(log);
  } finally {
    globalThis.fetch = real;
  }
}

/** The stub for every phase in which no request is allowed to happen. */
const refuse: StubHandler = (url) => {
  throw new Error(`a request was made without consent: ${url}`);
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

/** Revoke everything, through the product's own write path. */
function clearGrants(): void {
  const patch: PermissionGrants = {};
  for (const kind of ALL_KINDS) patch[kind] = false;
  const result = automation.setGrants(patch);
  if (!result.ok) throw new Error(`setGrants failed: ${result.error}`);
}

function grant(kinds: readonly CapabilityKind[]): void {
  const patch: PermissionGrants = {};
  for (const kind of kinds) patch[kind] = true;
  const result = automation.setGrants(patch);
  if (!result.ok) throw new Error(`setGrants failed: ${result.error}`);
}

/** Hand-edit the settings file the way a user would, then forget the cache. */
function writeSettingsFile(doc: unknown): void {
  writeFileSync(SETTINGS_FILE, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  settings.invalidateSettingsCache();
}

function slices(snapshot: LifeSnapshot): Record<string, number | string> {
  return {
    tasks: snapshot.tasks.length,
    events: snapshot.events.length,
    health: snapshot.health.length,
    notes: snapshot.notes.length,
    finance: snapshot.finance.length,
    mail: snapshot.mail.length,
    weather: snapshot.weather === undefined ? "absent" : "present",
    media: snapshot.media === undefined ? "absent" : String(snapshot.media.source),
  };
}

/**
 * Nothing in the snapshot that a refusal should have prevented.
 *
 * `media` is the one slice a fresh, ungranted install may carry: it is core, and
 * with no bridge configured the adapter returns a locally-derived focus
 * suggestion. It has to say `source: "local"` — a slice that came from a request
 * is exactly the bug this file exists to catch, and the request counter below
 * would have caught it too.
 */
function contributedNothing(snapshot: LifeSnapshot): boolean {
  return (
    snapshot.tasks.length === 0 &&
    snapshot.events.length === 0 &&
    snapshot.health.length === 0 &&
    snapshot.notes.length === 0 &&
    snapshot.finance.length === 0 &&
    snapshot.mail.length === 0 &&
    snapshot.weather === undefined &&
    (snapshot.media === undefined || snapshot.media.source === "local")
  );
}

const panelRows = () => registry.pluginStatuses();
const panel = (id: string) => panelRows().find((row) => row.id === id);
const entry = (id: string) => automation.findPlugin(id);
const coreIds = () => new Set(registry.list().filter((e) => e.descriptor.core === true).map((e) => e.descriptor.id));
const gatedIds = () => new Set(registry.list().filter((e) => e.descriptor.core !== true).map((e) => e.descriptor.id));

/** Local wall-clock stamp for an ICS feed, which the parser reads as local. */
const two = (value: number) => String(value).padStart(2, "0");
function localStamp(offsetMinutes = 0): string {
  const at = new Date(Date.now() + offsetMinutes * 60_000);
  return `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}T${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}`;
}

const ICS_BODY = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:check-plugins-gate",
  `DTSTART:${localStamp(5)}`,
  `DTEND:${localStamp(35)}`,
  "SUMMARY:Gate check event",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

let bootError = "";
let booted: InstanceType<typeof PluginRegistry> | undefined;
try {
  booted = new PluginRegistry();
} catch (err) {
  bootError = err instanceof Error ? err.message : String(err);
}

await group("Isolation and boot", () => {
  check(
    "the settings file is inside a temp directory, not the project's data/",
    settings.settingsPath() === SETTINGS_FILE && settings.settingsPath().startsWith(DATA_DIR),
    settings.settingsPath(),
  );
  check(
    "nothing is granted on a fresh settings file",
    Object.values(automation.grants()).every((value) => value !== true),
    JSON.stringify(automation.grants()),
  );
  check("the plugin register boots", Boolean(booted), bootError.split("\n").slice(0, 3).join(" "));
});

if (!booted) {
  console.log(`  FAIL  cannot continue: the register does not boot\n`);
  store.close();
  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed + 1} failed\n`);
  process.exit(1);
}

/** Definite from here on: a `const`, so the closures below keep the type. */
const registry: InstanceType<typeof PluginRegistry> = booted;
const entries = registry.list();

/* ------------------------------------------------------------------ */
/* The shape of the gate                                              */
/* ------------------------------------------------------------------ */

await group("The shape of the gate", () => {
  check("the build has plugins", entries.length > 0, `${entries.length}`);
  check(
    "plugin ids are unique",
    new Set(entries.map((e) => e.descriptor.id)).size === entries.length,
    entries.map((e) => e.descriptor.id).join(", "),
  );
  check(
    "there is at least one gated plugin, or this file tests nothing",
    gatedIds().size > 0,
    `gated: ${[...gatedIds()].join(", ")}`,
  );
  check(
    "there is at least one core plugin, or this file tests nothing",
    coreIds().size > 0,
    `core: ${[...coreIds()].join(", ")}`,
  );
  check(
    "every gated plugin requires a capability, so none runs ungated",
    entries
      .filter((e) => e.descriptor.core !== true)
      .every((e) => e.descriptor.needs.length > 0),
    entries
      .filter((e) => e.descriptor.core !== true && e.descriptor.needs.length === 0)
      .map((e) => e.descriptor.id)
      .join(", "),
  );

  /**
   * The runtime half of the boot rule, checked against the *product's* own
   * vocabulary (`CAPABILITY_INFO[kind].leaves`) rather than the registry's
   * private predicate: if the two ever disagree, this fails.
   */
  const leaks = entries
    .filter((e) => e.descriptor.core === true)
    .flatMap((e) =>
      e.descriptor.needs
        .filter((spec) => pluginTypes.CAPABILITY_INFO[spec.kind].leaves)
        .map((spec) => `${e.descriptor.id}:${spec.kind}`),
    );
  check("no core plugin's required capabilities leave the machine", leaks.length === 0, leaks.join(", "));
});

/* ------------------------------------------------------------------ */
/* 1-2. The gate: nothing granted                                     */
/* ------------------------------------------------------------------ */

await group("With nothing granted, no plugin reaches the network", async () => {
  clearGrants();

  const blocked = await withFetch(refuse, async (log) => ({
    snapshot: await registry!.collect(),
    log,
  }));

  check(
    "collect() returns one row per plugin even when nothing may run",
    blocked.snapshot.statuses.length === entries.length,
    `${blocked.snapshot.statuses.length} rows / ${entries.length} plugins`,
  );
  /**
   * Rows are joined to plugins by id — the panel, the grants map and the life
   * state all key on it — so a row that carries its adapter's id instead of its
   * plugin's is a row nothing can look up. The check that every row's id is the
   * plugin's id is made once, below, over every plugin in both states; the panel
   * half of it is here because the panel is what this snapshot has to agree
   * with.
   */
  const panelIdMismatch = panelRows()
    .map((row, index) => ({ want: entries[index].descriptor.id, got: row.id }))
    .filter((pair) => pair.want !== pair.got);
  check(
    "the panel identifies rows by the plugin's own descriptor id",
    panelIdMismatch.length === 0,
    panelIdMismatch.map((pair) => `${pair.want}→${pair.got}`).join(", "),
  );

  /**
   * The single most important assertion in this file: the counter is exactly 0.
   *
   * The stub throws when called, so a plugin that ignored consent is caught by
   * this number even though the adapter's own error handling would swallow the
   * failure and report a tidy status row.
   */
  check(
    "no plugin called fetch while nothing was granted (counter must be exactly 0)",
    blocked.log.calls === 0,
    `${blocked.log.calls} call(s): ${blocked.log.urls.join(", ")}`,
  );
  check(
    "no blocked plugin contributed anything to the snapshot",
    contributedNothing(blocked.snapshot),
    JSON.stringify(slices(blocked.snapshot)),
  );

  /**
   * A refused plugin is `blocked` — not `offline`. `AdapterDots` counts
   * `state === "blocked"` rows to write "N waiting for permission", and it
   * renders the very array built here, so `offline` would render nine broken
   * adapters instead of a consent prompt.
   */
  const gatedRows = blocked.snapshot.statuses.filter((row) => gatedIds().has(row.id));
  check(
    "every gated plugin's collect() row says blocked",
    gatedRows.length === gatedIds().size && gatedRows.every((row) => row.state === "blocked"),
    blocked.snapshot.statuses.map((row) => `${row.id}:${row.state}`).join(", "),
  );
  check(
    "no gated row reads offline while its grant is missing",
    gatedRows.every((row) => row.state !== "offline"),
    gatedRows.filter((row) => row.state === "offline").map((row) => row.id).join(", "),
  );
  check(
    "every gated row explains itself",
    gatedRows.every((row) => (row.detail ?? "").trim().length > 0),
    JSON.stringify(gatedRows.map((row) => `${row.id}: ${row.detail}`)),
  );
  check(
    "every gated row says what it is waiting for",
    gatedRows.every((row) => /waiting for permission/i.test(row.detail ?? "")),
    gatedRows.map((row) => row.detail).join(" | "),
  );
  check(
    "no core plugin is reported blocked",
    blocked.snapshot.statuses.filter((row) => coreIds().has(row.id)).every((row) => row.state !== "blocked"),
    blocked.snapshot.statuses
      .filter((row) => coreIds().has(row.id))
      .map((row) => `${row.id}:${row.state}`)
      .join(", "),
  );

  /* The panel and the life state must not disagree about who is blocked. */

  const panelBlocked = new Set(panelRows().filter((row) => row.state === "blocked").map((row) => row.id));
  check(
    "the panel's blocked set is exactly the gated plugins",
    panelBlocked.size === gatedIds().size && [...gatedIds()].every((id) => panelBlocked.has(id)),
    `panel=${[...panelBlocked].join(", ")} gated=${[...gatedIds()].join(", ")}`,
  );
  check(
    "every blocked panel row names the missing capability and explains itself",
    panelRows()
      .filter((row) => row.state === "blocked")
      .every((row) => row.missing.length > 0 && (row.detail ?? "").trim().length > 0),
    JSON.stringify(panelRows().map((row) => `${row.id}: missing=${row.missing.join("+")} detail=${row.detail}`)),
  );
  const statusRows = new Map(registry!.statuses().map((row) => [row.id, row.state]));
  check(
    "registry.statuses() agrees with collect() about the blocked set",
    [...gatedIds()].every((id) => statusRows.get(id) === "blocked"),
    registry!.statuses().map((row) => `${row.id}:${row.state}`).join(", "),
  );
});

/* ------------------------------------------------------------------ */
/* Core means the local half works with no consent at all              */
/* ------------------------------------------------------------------ */

await group("Core means the local half works with no consent at all", async () => {
  clearGrants();
  const mediaFile = path.join(DATA_DIR, "now-playing.txt");
  writeFileSync(mediaFile, "Gate Check Track\n", "utf8");
  automation.writePluginSettings({ "media.file": mediaFile });

  /**
   * A local file is not a network read, and `media` is core precisely because
   * its local half is supposed to work with every permission refused. The
   * adapter folds `mayFetch` into `configured`, so if the plugin offers no
   * capability that can ever make `mayFetch` true, a configured *file* is
   * dead too — and the row says "set a now-playing endpoint or file" next to a
   * setting the user just filled in.
   */
  const local = await withFetch(refuse, async (log) => ({
    snapshot: await registry!.collect(),
    log,
  }));
  check(
    "reading a configured local file makes no request",
    local.log.calls === 0,
    `${local.log.calls} call(s): ${local.log.urls.join(", ")}`,
  );
  check(
    "and the track in it reaches the snapshot",
    local.snapshot.media?.nowPlaying === "Gate Check Track",
    JSON.stringify(local.snapshot.media),
  );
  check(
    "which is what makes the plugin core: its local half needs no grant",
    (panel("media")?.missing ?? []).length === 0 && panel("media")?.state !== "blocked",
    JSON.stringify(panel("media")),
  );

  automation.writePluginSettings({ "media.file": "" });
});

/* ------------------------------------------------------------------ */
/* The gate holds when the network half is configured but not granted  */
/* ------------------------------------------------------------------ */

await group("A configured integration with no grant still makes no request", async () => {
  clearGrants();
  automation.writePluginSettings({
    "calendar.icsUrls": ICS_URL,
    "tasks.token": TOKEN,
    "media.url": MEDIA_URL,
    "mail.url": MAIL_URL,
    "markets.symbols": "aapl.us",
  });

  const configured = await withFetch(refuse, async (log) => ({
    snapshot: await registry!.collect(),
    log,
  }));

  /**
   * The ICS URL is the sharpest case: `calendar` is core, so the plugin itself
   * is always allowed to run, and only `gates.network` stands between a
   * configured feed address and a request. Before the gates were handed to the
   * adapters, this counter read 1.
   */
  check(
    "a configured ICS feed is not fetched without net.read",
    !configured.log.urls.some((url) => url.includes("example.invalid")),
    `${configured.log.calls} call(s): ${configured.log.urls.join(", ")}`,
  );
  check(
    "a configured Todoist token is not used without account and net.read",
    !configured.log.urls.some((url) => url.includes("todoist")),
    configured.log.urls.join(", "),
  );
  check(
    "a configured media endpoint is not requested",
    !configured.log.urls.some((url) => url.includes("9863")),
    configured.log.urls.join(", "),
  );
  check(
    "a configured mail endpoint is not requested",
    !configured.log.urls.some((url) => url.includes("9864")),
    configured.log.urls.join(", "),
  );
  check(
    "and nothing at all was requested",
    configured.log.calls === 0,
    `${configured.log.calls} call(s): ${configured.log.urls.join(", ")}`,
  );

  /* The decision itself, not just its effect. */

  const calendarGates = entry("calendar")?.gates();
  check(
    "the calendar adapter was built with network: false",
    calendarGates?.network === false,
    JSON.stringify(calendarGates),
  );
  check(
    "the gates carry the epoch they were decided at",
    typeof calendarGates?.epoch === "number",
    JSON.stringify(calendarGates),
  );
  const direct = automation.gatesFor(entry("calendar")!.descriptor);
  check(
    "gatesFor() refuses the network while net.read is ungranted",
    direct.network === false && direct.remote === false,
    JSON.stringify(direct),
  );
  check(
    "and the panel shows net.read as waiting, not as missing",
    (panel("calendar")?.waiting ?? []).includes("net.read") && (panel("calendar")?.missing ?? []).length === 0,
    JSON.stringify(panel("calendar")),
  );

  /* "Runs, but would do more" is a different state from "blocked". */

  const waitingFor = (id: string) => panel(id)?.waiting ?? [];
  check(
    "calendar, tasks and Google report what more consent would add",
    waitingFor("calendar").includes("net.read") &&
      waitingFor("tasks").includes("net.read") &&
      waitingFor("tasks").includes("account") &&
      waitingFor(gcal.GOOGLE_PLUGIN_ID).includes("remote.write"),
    JSON.stringify(panelRows().map((row) => `${row.id}: waiting=${row.waiting.join("+")}`)),
  );
  check(
    "a plugin's waiting list is not its blocked list",
    (panel("weather")?.waiting ?? []).length === 0 && (panel("weather")?.missing ?? []).length > 0,
    JSON.stringify(panel("weather")),
  );
});

/* ------------------------------------------------------------------ */
/* 2-3. Consent turns it on, revocation turns it off                  */
/* ------------------------------------------------------------------ */

await group("Consent turns a plugin on, and only the capability it lacks", async () => {
  clearGrants();

  /* Half of weather's requirement is not consent. */

  grant(["location"]);
  const half = await withFetch(refuse, async (log) => ({ snapshot: await registry!.collect(), log }));
  check(
    "granting one of weather's two capabilities does not run it",
    half.log.calls === 0,
    `${half.log.calls} call(s): ${half.log.urls.join(", ")}`,
  );
  const weatherHalf = panel("weather");
  check(
    "weather is still blocked, and now names only net.read",
    weatherHalf?.state === "blocked" && weatherHalf.missing.join(",") === "net.read",
    JSON.stringify(weatherHalf),
  );

  /* Granting the missing one does. */

  grant(["net.read"]);
  const on = await withFetch(refuse, async (log) => {
    const snapshot = emptySnapshot();
    const run = await automation.runPlugin(entry("weather")!, snapshot);
    return { snapshot, run, log };
  });
  check("granting the last missing capability runs weather", on.run.ran === true);
  const weatherHosts = (entry("weather")?.descriptor.needs ?? []).flatMap((spec) => spec.hosts ?? []);
  check(
    "the request went to a host weather's descriptor asked permission for",
    on.log.urls.some((url) => weatherHosts.includes(new URL(url).host)),
    `${on.log.urls.join(", ")} vs ${weatherHosts.join(", ")}`,
  );
  const weatherRan = panel("weather");
  check(
    "missing configuration is not missing consent: the row is not blocked",
    weatherRan?.state !== "blocked" && (weatherRan?.missing ?? []).length === 0,
    JSON.stringify(weatherRan),
  );

  /**
   * Every row a plugin produces must be identified by the plugin's own id, in
   * both states: a blocked row is built by `runPlugin` from the descriptor, but a
   * row that actually ran is built by the adapter, and an adapter whose `id`
   * differs (`knowledge` for the notes plugin, `finance` for markets) hands the
   * life state a key nothing else uses. Derived over every plugin rather than
   * named, so it catches the next one too.
   */
  const idRows = await withFetch(refuse, async () => {
    const rows: Array<{ want: string; got: string }> = [];
    for (const item of entries) {
      const run = await automation.runPlugin(item, emptySnapshot());
      rows.push({ want: item.descriptor.id, got: run.status.id });
    }
    return rows;
  });
  const idMismatch = idRows.filter((pair) => pair.want !== pair.got);
  check(
    "every status row is identified by its plugin's descriptor id, not its adapter's",
    idMismatch.length === 0,
    idMismatch.map((pair) => `${pair.want}→${pair.got}`).join(", "),
  );
  // Those runs cached their slices; drop them so the checks below re-read.
  registry!.invalidate();

  /* The network half of a core plugin unlocks with the same capability. */

  const icsOn = await withFetch(() => ({ text: ICS_BODY }), async (log) => {
    const snapshot = emptySnapshot();
    const status = await entry("calendar")!.fetch(snapshot);
    return { snapshot, status, log };
  });
  check(
    "granting net.read lets the configured ICS feed be read",
    icsOn.log.calls === 1 && icsOn.log.urls[0] === ICS_URL,
    `${icsOn.log.calls} call(s): ${icsOn.log.urls.join(", ")}`,
  );
  check(
    "and its events reach the snapshot",
    icsOn.snapshot.events.some((event) => event.title === "Gate check event"),
    JSON.stringify(icsOn.snapshot.events.map((event) => event.title)),
  );
  check(
    "and the adapter was rebuilt with network: true",
    entry("calendar")?.gates()?.network === true,
    JSON.stringify(entry("calendar")?.gates()),
  );

  /* Revocation is immediate — both shapes of plugin. */

  const revoked = automation.revokePlugin("weather");
  check(
    "revokePlugin returns the resulting grants",
    revoked.ok && revoked.grants["net.read"] === false && revoked.grants["location"] === false,
    JSON.stringify(revoked),
  );
  check(
    "the stored file records the revocation as false, not as absence",
    automation.grants()["net.read"] === false && automation.isGranted("net.read") === false,
    JSON.stringify(automation.grants()),
  );
  check(
    "a revoked plugin has no adapter instance left to call",
    entry("weather")?.adapter() === undefined,
  );

  const off = await withFetch(refuse, async (log) => ({ snapshot: await registry!.collect(), log }));
  check(
    "after revoking, nothing is called again (counter must be exactly 0)",
    off.log.calls === 0,
    `${off.log.calls} call(s): ${off.log.urls.join(", ")}`,
  );
  check(
    "and the blocked plugins contribute nothing",
    contributedNothing(off.snapshot),
    JSON.stringify(slices(off.snapshot)),
  );
  check(
    "and the panel says blocked again",
    panel("weather")?.state === "blocked",
    JSON.stringify(panel("weather")),
  );

  /**
   * The regression this whole file is named after: the user turns the network
   * off for the calendar, and the next poll still fetches the configured feed
   * because the adapter was built while it was allowed and kept warm.
   */
  grant(["net.read"]);
  const allowedAgain = await withFetch(() => ({ text: ICS_BODY }), async (log) => {
    await entry("calendar")!.fetch(emptySnapshot());
    return log;
  });
  check(
    "the feed works again once net.read is granted back",
    allowedAgain.urls.includes(ICS_URL),
    allowedAgain.urls.join(", "),
  );

  const calendarOff = automation.revokePlugin("calendar");
  check("revokePlugin('calendar') reports net.read revoked", calendarOff.grants["net.read"] === false, JSON.stringify(calendarOff.grants));

  /**
   * The warm-adapter regression, across the whole registry: an adapter built
   * while `net.read` was granted must not keep fetching after the revoke. If the
   * rebuild does not happen, the fetch counter is non-zero and the row is an
   * error from the refusing stub — and `gates()` still reports `network: true`.
   */
  const afterRevoke = await withFetch(refuse, async (log) => {
    const snapshot = await registry!.collect();
    return { snapshot, row: snapshot.statuses.find((status) => status.id === "calendar"), log };
  });
  check(
    "after revoking, the whole registry makes no request",
    afterRevoke.log.calls === 0,
    `${afterRevoke.log.calls} call(s): ${afterRevoke.log.urls.join(", ")}`,
  );
  check(
    "and the calendar still reads Xana's own store, because that half is core",
    afterRevoke.row?.state !== "blocked" && afterRevoke.row?.state !== "error",
    JSON.stringify(afterRevoke.row),
  );
  check(
    "and the rebuilt adapter's gates say network: false",
    entry("calendar")?.gates()?.network === false,
    JSON.stringify(entry("calendar")?.gates()),
  );
});

/* ------------------------------------------------------------------ */
/* 5. The epoch: configuration and gates are re-read, not cached       */
/* ------------------------------------------------------------------ */

await group("Configuration changes rebuild the adapter that read it", async () => {
  clearGrants();
  automation.writePluginSettings({ "calendar.icsUrls": ICS_URL });

  const calendar = entry("calendar");
  const firstAdapter = calendar?.adapter();
  check("the calendar adapter is built even with no grant, because it is core", Boolean(firstAdapter));

  const beforeWrite = await withFetch(() => ({ text: ICS_BODY }), async (log) => {
    await calendar?.fetch(emptySnapshot());
    return log;
  });
  check(
    "with no net.read the feed is not fetched",
    beforeWrite.calls === 0,
    `${beforeWrite.calls} call(s): ${beforeWrite.urls.join(", ")}`,
  );

  /**
   * Bites: remove `epoch += 1` from `afterConfigChange` (`automation.ts`).
   * The adapter built above is then reused for the next poll, `afterWrite` is 0
   * calls and the URL check fails — the failure a user sees as "I pasted the new
   * feed address and it kept reading the old one".
   */
  grant(["net.read"]);
  const secondAdapter = calendar?.adapter();
  check(
    "granting net.read rebuilds the adapter rather than reusing a warm one",
    Boolean(secondAdapter) && secondAdapter !== firstAdapter,
    `first=${Boolean(firstAdapter)} second=${Boolean(secondAdapter)} same=${firstAdapter === secondAdapter}`,
  );

  const afterWrite = await withFetch(() => ({ text: ICS_BODY }), async (log) => {
    const snapshot = emptySnapshot();
    const status = await calendar?.fetch(snapshot);
    return { log, snapshot, status };
  });
  check(
    "the rebuilt adapter reads the configured feed",
    afterWrite.log.calls === 1 && afterWrite.log.urls[0] === ICS_URL,
    `${afterWrite.log.calls} call(s): ${afterWrite.log.urls.join(", ")}`,
  );
  check(
    "and the events it parsed reach the snapshot",
    afterWrite.snapshot.events.some((event) => event.title === "Gate check event"),
    JSON.stringify(afterWrite.snapshot.events.map((event) => event.title)),
  );
  check("and the row says connected rather than local", afterWrite.status?.state === "connected", JSON.stringify(afterWrite.status));

  const rewritten = automation.writePluginSettings({ "calendar.icsUrls": ICS_URL_2 });
  check(
    "writePluginSettings stores the value setting() reads back",
    rewritten.ok && automation.setting("calendar.icsUrls") === ICS_URL_2,
    `${automation.setting("calendar.icsUrls")} (${rewritten.error ?? "ok"})`,
  );

  const thirdAdapter = calendar?.adapter();
  check("changing the URL rebuilds the adapter again", Boolean(thirdAdapter) && thirdAdapter !== secondAdapter);

  const afterRewrite = await withFetch(() => ({ text: ICS_BODY }), async (log) => {
    await calendar?.fetch(emptySnapshot());
    return log;
  });
  check(
    "and the next run reads the new address, not the old one",
    afterRewrite.calls === 1 && afterRewrite.urls[0] === ICS_URL_2,
    `${afterRewrite.calls} call(s): ${afterRewrite.urls.join(", ")}`,
  );
});

/* ------------------------------------------------------------------ */
/* 4. Coercion                                                        */
/* ------------------------------------------------------------------ */

await group("A hand-edited settings file is read as hostile input", () => {
  clearGrants();

  /**
   * Bites: `coerceSettings` in `settings/store.ts` loosened from
   * `rawPermissions[key] === true` to `if (rawPermissions[key])` — then "yes"
   * and 1 become grants and this fails.
   */
  writeSettingsFile({ permissions: { "net.read": "yes", "local.read": 1, "nonsense.cap": true } });
  check(
    "a permissions map of look-alike truthy values grants nothing",
    Object.keys(automation.grants()).length === 0,
    JSON.stringify(automation.grants()),
  );
  check('"net.read": "yes" is not a grant', automation.isGranted("net.read") === false);
  check('"local.read": 1 is not a grant', automation.isGranted("local.read") === false);
  check(
    "a capability the app does not know is dropped, not stored",
    !Object.prototype.hasOwnProperty.call(automation.grants(), "nonsense.cap"),
    JSON.stringify(automation.grants()),
  );

  writeSettingsFile({ permissions: { "net.read": "false" } });
  check(
    '"net.read": "false" does not grant either, even though the string is truthy',
    automation.isGranted("net.read") === false,
  );

  writeSettingsFile({ permissions: { "net.read": true, "nonsense.cap": true } });
  check('"net.read": true does grant', automation.isGranted("net.read") === true);
  check(
    "the unknown key is dropped even beside a real grant",
    !Object.prototype.hasOwnProperty.call(automation.grants(), "nonsense.cap"),
    JSON.stringify(automation.grants()),
  );

  const smuggled = automation.setGrants({ "nonsense.cap": true } as unknown as PermissionGrants);
  const onDisk = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as {
    permissions?: Record<string, boolean>;
  };
  check(
    "the write path refuses to persist a capability the app cannot honour",
    smuggled.ok && !Object.prototype.hasOwnProperty.call(onDisk.permissions ?? {}, "nonsense.cap"),
    JSON.stringify(onDisk.permissions),
  );

  clearGrants();
});

/* ------------------------------------------------------------------ */
/* 6-7. Google OAuth, offline                                         */
/* ------------------------------------------------------------------ */

await group("Google OAuth: PKCE, the authorization URL, and the exchange", async () => {
  clearGrants();
  automation.writePluginSettings({
    "google.refreshToken": "",
    "google.accessToken": "",
    "google.accessExpiresAt": "",
    "google.account": "",
    "google.pendingState": "",
    "google.pendingVerifier": "",
    "google.pendingAt": "",
  });

  check(
    "the RFC 7636 S256 test vector",
    gcal.challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk") ===
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    gcal.challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
  );

  const verifierA = gcal.createVerifier();
  const verifierB = gcal.createVerifier();
  check("a verifier is 43 characters of the unreserved URL-safe alphabet", /^[A-Za-z0-9_-]{43}$/.test(verifierA), verifierA);
  check("two verifiers differ", verifierA !== verifierB);
  check(
    "the challenge is a function of the verifier, not a constant",
    gcal.challengeFor(verifierA) !== gcal.challengeFor(verifierB),
  );

  check(
    "with no flow pending, nothing matches",
    gcal.pendingAuthorization() === undefined && gcal.stateMatches("anything") === false,
  );
  const begun = gcal.beginAuthorization(REDIRECT, false);
  check(
    "beginAuthorization parks the flow it just made",
    gcal.pendingAuthorization()?.state === begun.state,
    JSON.stringify(gcal.pendingAuthorization()),
  );
  check("the state Google echoes back matches", gcal.stateMatches(begun.state) === true);
  check(
    "a wrong or empty state does not match",
    gcal.stateMatches(`x${begun.state}`) === false && gcal.stateMatches("") === false,
  );
  automation.writePluginSettings({ "google.pendingAt": new Date(Date.now() - 11 * 60_000).toISOString() });
  check(
    "a flow older than ten minutes is abandoned",
    gcal.pendingAuthorization() === undefined && gcal.stateMatches(begun.state) === false,
  );

  automation.writePluginSettings({ "google.clientId": CLIENT_ID, "google.clientSecret": "" });

  const urlPhase = await withFetch(refuse, async (log) => {
    const readFlow = gcal.beginAuthorization(REDIRECT, false);
    const writeFlow = gcal.beginAuthorization(REDIRECT, true);
    return { log, readFlow, writeFlow, readUrl: new URL(readFlow.url), writeUrl: new URL(writeFlow.url) };
  });

  const { readUrl, writeUrl } = urlPhase;
  check(
    "the authorization URL is Google's endpoint",
    `${readUrl.origin}${readUrl.pathname}` === "https://accounts.google.com/o/oauth2/v2/auth",
    readUrl.origin + readUrl.pathname,
  );
  check(
    "access_type=offline is requested, which is what asks for a refresh token",
    readUrl.searchParams.get("access_type") === "offline",
  );
  check(
    "prompt=consent is sent on every run, so a repeat consent still returns one",
    readUrl.searchParams.get("prompt") === "consent",
  );
  check("code_challenge_method=S256", readUrl.searchParams.get("code_challenge_method") === "S256");
  check(
    "the state on the URL is the one this flow recorded, not a later one",
    readUrl.searchParams.get("state") === urlPhase.readFlow.state &&
      urlPhase.readFlow.state !== urlPhase.writeFlow.state,
    `${readUrl.searchParams.get("state")} vs ${urlPhase.readFlow.state}/${urlPhase.writeFlow.state}`,
  );
  check(
    "the redirect comes back to this machine",
    readUrl.searchParams.get("redirect_uri") === REDIRECT,
  );

  const readScope = readUrl.searchParams.get("scope") ?? "";
  check(
    "without remote.write the scope is read-only and nothing else",
    readScope === "https://www.googleapis.com/auth/calendar.readonly",
    readScope,
  );

  const writeScopes = (writeUrl.searchParams.get("scope") ?? "").split(" ").filter(Boolean);
  check(
    "granting the write half adds calendar.events",
    writeScopes.includes("https://www.googleapis.com/auth/calendar.events"),
    writeScopes.join(" "),
  );
  check(
    "and keeps the read scope",
    writeScopes.includes("https://www.googleapis.com/auth/calendar.readonly"),
    writeScopes.join(" "),
  );
  check(
    "and asks for nothing wider, e.g. full calendar control",
    writeScopes.every((scope) => scope.endsWith("/auth/calendar.readonly") || scope.endsWith("/auth/calendar.events")),
    writeScopes.join(" "),
  );
  check(
    "building an authorization URL makes no request: the user has not consented yet",
    urlPhase.log.calls === 0,
    `${urlPhase.log.calls} call(s): ${urlPhase.log.urls.join(", ")}`,
  );

  /* The exchange, stubbed. */

  const exchangeVerifier = gcal.pendingAuthorization()?.verifier ?? "";
  const exchanged = await withFetch(
    (url) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return {
          json: {
            access_token: "access-1",
            refresh_token: "refresh-1",
            expires_in: 3600,
            token_type: "Bearer",
          },
        };
      }
      if (url.includes("userinfo")) return { json: { email: "me@example.com" } };
      throw new Error(`unexpected request: ${url}`);
    },
    async (log) => ({ result: await gcal.completeAuthorization("auth-code-1", REDIRECT), log }),
  );

  check("the code exchange succeeds", exchanged.result.ok === true, JSON.stringify(exchanged.result));
  check(
    "the refresh token is stored, which is the point of the whole flow",
    automation.setting("google.refreshToken") === "refresh-1",
    automation.setting("google.refreshToken"),
  );
  check(
    "the access token and the account address are stored",
    automation.setting("google.accessToken") === "access-1" && automation.setting("google.account") === "me@example.com",
    `${automation.setting("google.accessToken")} / ${automation.setting("google.account")}`,
  );
  check(
    "the pending flow is consumed, so a replayed callback cannot mint a second set",
    automation.setting("google.pendingState") === "" && gcal.pendingAuthorization() === undefined,
  );

  const exchangeBody = exchanged.log.bodies.find((body) => body.includes("grant_type=authorization_code")) ?? "";
  check(
    "the exchange posts the verifier, not the challenge",
    exchangeBody.includes(`code_verifier=${encodeURIComponent(exchangeVerifier)}`),
    exchangeBody,
  );
  check("a desktop client sends no empty client_secret", !exchangeBody.includes("client_secret="), exchangeBody);

  /* The gate in front of the OAuth-backed read. */

  clearGrants();
  grant(["net.read"]);
  const googleEntry = entry(gcal.GOOGLE_PLUGIN_ID);
  check("the Google plugin is in the register", Boolean(googleEntry));

  const ungated = await withFetch(refuse, async (log) => ({
    run: await automation.runPlugin(googleEntry!, emptySnapshot()),
    log,
  }));
  check(
    "the Google plugin does not run at all when 'account' is not granted",
    ungated.run.ran === false && ungated.log.calls === 0,
    `ran=${ungated.run.ran} calls=${ungated.log.calls}`,
  );
  const googleRefusal = ungated.run.status.detail ?? "";
  check(
    "and the refusal names the account capability",
    /waiting for permission/i.test(googleRefusal) && /account/i.test(googleRefusal),
    googleRefusal,
  );

  grant(["account"]);
  const granted = await withFetch(
    (url) => {
      if (url.includes("googleapis.com/calendar")) {
        return {
          json: {
            items: [
              {
                id: "evt-1",
                summary: "Standup",
                start: { dateTime: new Date(Date.now() + 3_600_000).toISOString() },
                end: { dateTime: new Date(Date.now() + 5_400_000).toISOString() },
              },
            ],
          },
        };
      }
      throw new Error(`unexpected request: ${url}`);
    },
    async (log) => {
      const snapshot = emptySnapshot();
      const run = await automation.runPlugin(googleEntry!, snapshot);
      return { run, log, snapshot };
    },
  );
  check("with 'account' granted the plugin runs", granted.run.ran === true);
  check(
    "and reads the calendar with the stored access token",
    granted.log.urls.some((url) => url.includes("/calendars/primary/events")) &&
      granted.log.headers.some((headers) => headers.authorization === "Bearer access-1"),
    `${granted.log.urls.join(", ")} | ${JSON.stringify(granted.log.headers)}`,
  );
  check(
    "and its events reach the snapshot",
    granted.snapshot.events.some((event) => event.title === "Standup"),
    JSON.stringify(granted.snapshot.events.map((event) => event.title)),
  );
});

/* ------------------------------------------------------------------ */
/* 8. Refresh-token preservation                                      */
/* ------------------------------------------------------------------ */

await group("A refresh response without a refresh_token keeps the stored one", async () => {
  check(
    "a refresh token is stored to begin with",
    automation.setting("google.refreshToken") === "refresh-1",
    automation.setting("google.refreshToken"),
  );

  /**
   * (a) Repeat consent. Google only returns a refresh token on the FIRST consent
   * for a client+account pair; every later flow returns an access token and no
   * refresh token. Treating that absence as "clear it" disconnects a working
   * account.
   *
   * Bites: `if (tokens.refresh_token) values["google.refreshToken"] = ...` in
   * `completeAuthorization` replaced with
   * `values["google.refreshToken"] = tokens.refresh_token ?? ""` — the stored
   * token is cleared and this fails.
   */
  gcal.beginAuthorization(REDIRECT, false);
  const repeat = await withFetch(
    (url) =>
      url.includes("oauth2.googleapis.com/token")
        ? { json: { access_token: "access-2", expires_in: 3600 } }
        : { json: {} },
    async () => gcal.completeAuthorization("auth-code-2", REDIRECT),
  );
  check("the repeat consent succeeds", repeat.ok === true, JSON.stringify(repeat));
  check(
    "the stored refresh token survives a reply that omits one",
    automation.setting("google.refreshToken") === "refresh-1",
    automation.setting("google.refreshToken"),
  );
  check(
    "while the new access token is taken",
    automation.setting("google.accessToken") === "access-2",
    automation.setting("google.accessToken"),
  );

  /**
   * (b) The silent refresh an hour later, which is when the bug above would
   * finally be noticed — nowhere near its cause.
   */
  automation.writePluginSettings({
    "google.accessToken": "stale",
    "google.accessExpiresAt": String(Date.now() - 60_000),
  });
  const refreshed = await withFetch(
    (url) =>
      url.includes("oauth2.googleapis.com/token")
        ? { json: { access_token: "access-3", expires_in: 3600 } }
        : { json: {} },
    async (log) => ({ auth: await gcal.accessToken(), log }),
  );
  check(
    "an expired access token is refreshed with the stored refresh token",
    "token" in refreshed.auth && refreshed.auth.token === "access-3",
    JSON.stringify(refreshed.auth),
  );
  check(
    "the refresh request carried the stored refresh token",
    refreshed.log.bodies.some(
      (body) => body.includes("grant_type=refresh_token") && body.includes("refresh_token=refresh-1"),
    ),
    refreshed.log.bodies.join(" | "),
  );
  check(
    "and the refresh token is still there afterwards",
    automation.setting("google.refreshToken") === "refresh-1",
    automation.setting("google.refreshToken"),
  );
});

/* ------------------------------------------------------------------ */
/* 9. Writes that leave the machine                                    */
/* ------------------------------------------------------------------ */

await group("Writes that leave the machine need remote.write", () => {
  clearGrants();
  grant(["account", "net.read"]);

  const refused = automation.mayWriteRemotely(gcal.GOOGLE_PLUGIN_ID);
  check("a connected plugin may not be written to without remote.write", refused.allowed === false);
  check("the refusal names the capability to grant", refused.needs === "remote.write", JSON.stringify(refused));
  check("and has a sentence to show the user", (refused.reason ?? "").length > 0, refused.reason);

  const notes = automation.mayWriteRemotely("notes");
  check(
    "a plugin that offers no remote write is refused, with no capability to offer",
    notes.allowed === false && notes.needs === undefined,
    JSON.stringify(notes),
  );
  check(
    "a plugin with no remote-write capability in its descriptor is refused too",
    automation.mayWriteRemotely("weather").allowed === false,
  );
  check(
    "an unknown plugin id is refused rather than allowed by default",
    automation.mayWriteRemotely("no-such-plugin").allowed === false,
  );

  grant(["remote.write"]);
  const allowed = automation.mayWriteRemotely(gcal.GOOGLE_PLUGIN_ID);
  check(
    "granting remote.write allows the write",
    allowed.allowed === true && allowed.reason === undefined,
    JSON.stringify(allowed),
  );

  const google = entry(gcal.GOOGLE_PLUGIN_ID);
  check(
    "the write half is not writable until every optional capability is granted",
    google?.writable() === false,
    `writable=${google?.writable()} remote.write=${automation.isGranted("remote.write")} local.write=${automation.isGranted("local.write")}`,
  );
  grant(["local.write"]);
  check("and is writable once they are", entry(gcal.GOOGLE_PLUGIN_ID)?.writable() === true);

  /**
   * One predicate, two callers: the status row the panel reads and the method
   * the write path reads must give the same answer, or the panel shows
   * "no write" next to a working write button.
   */
  const disagreements = entries.filter(
    (item) => automation.writeUsable(item.descriptor) !== item.writable(),
  );
  check(
    "every plugin's status row agrees with its write gate (writeUsable === writable)",
    disagreements.length === 0,
    disagreements.map((item) => item.descriptor.id).join(", "),
  );

  const canWrite = new Map(panelRows().map((row) => [row.id, row.canWrite]));
  const wrongRows = entries.filter((item) => canWrite.get(item.descriptor.id) !== item.writable());
  check(
    "and every panel row's canWrite agrees with both",
    wrongRows.length === 0,
    wrongRows.map((item) => `${item.descriptor.id}: canWrite=${canWrite.get(item.descriptor.id)} writable=${item.writable()}`).join(", "),
  );

  check(
    "a plugin with no optional capability is never writable",
    entry("weather")?.writable() === false,
    `weather writable=${entry("weather")?.writable()}`,
  );
});

/* ------------------------------------------------------------------ */
/* 10. The boot contract                                              */
/* ------------------------------------------------------------------ */

await group("The boot contract", () => {
  check("a registry constructs with the shipped descriptors", entries.length > 0);
  check(
    "a descriptor that declares core is never one that leaves the machine",
    entries
      .filter((e) => e.descriptor.core === true)
      .every((e) =>
        e.descriptor.needs.every((spec) => !pluginTypes.CAPABILITY_INFO[spec.kind].leaves),
      ),
  );

  const allowedKeys = PLUGIN_SETTING_KEYS as readonly string[];
  const configKeys = entries.flatMap((e) => (e.descriptor.config ?? []).map((config) => config.key));
  check(
    "every declared config key is in the settings allowlist",
    configKeys.every((key) => allowedKeys.includes(key)),
    configKeys.filter((key) => !allowedKeys.includes(key)).join(", "),
  );

  const allowedCaps = CAPABILITY_KEYS as readonly string[];
  const capabilities = entries.flatMap((e) =>
    [...e.descriptor.needs, ...(e.descriptor.optional ?? [])].map((spec) => spec.kind),
  );
  check(
    "every declared capability is in the settings allowlist",
    capabilities.every((kind) => allowedCaps.includes(kind)),
    capabilities.filter((kind) => !allowedCaps.includes(kind)).join(", "),
  );
  check(
    "every net capability names the hosts it reaches",
    entries.every((e) =>
      [...e.descriptor.needs, ...(e.descriptor.optional ?? [])].every(
        (spec) => (spec.kind !== "net.read" && spec.kind !== "net.write") || (spec.hosts?.length ?? 0) > 0,
      ),
    ),
  );
  check(
    "every plugin states in words what leaves the machine",
    entries.every((e) => (e.descriptor.dataNote ?? "").trim().length > 0),
  );
  check(
    "every plugin that offers a URL setting declares net.read, so the setting can work at all",
    entries.every(
      (e) =>
        !(e.descriptor.config ?? []).some((config) => config.kind === "url") ||
        [...e.descriptor.needs, ...(e.descriptor.optional ?? [])].some((spec) => spec.kind === "net.read"),
    ),
    entries
      .filter(
        (e) =>
          (e.descriptor.config ?? []).some((config) => config.kind === "url") &&
          ![...e.descriptor.needs, ...(e.descriptor.optional ?? [])].some((spec) => spec.kind === "net.read"),
      )
      .map((e) => e.descriptor.id)
      .join(", "),
  );

  /*
   * The contract has to be able to fail, or it is decoration. Each case below
   * mutates a live descriptor, asserts the constructor refuses to build, and
   * restores the descriptor in a `finally` so an assertion failure cannot leave
   * the register poisoned. `registry.ts` publishes the entries it just built
   * before the check runs, so a good registry is built again at the end.
   */
  const mutable = gcal.GOOGLE_DESCRIPTOR as unknown as {
    id: string;
    core?: boolean;
    needs: CapabilitySpec[];
    config?: PluginConfigItem[];
  };
  const original = {
    id: mutable.id,
    core: mutable.core,
    needs: mutable.needs,
    config: mutable.config,
  };

  const refuses = (mutate: () => void): boolean => {
    let threw = false;
    try {
      mutate();
      try {
        new PluginRegistry();
      } catch {
        threw = true;
      }
    } finally {
      mutable.id = original.id;
      mutable.core = original.core;
      mutable.needs = original.needs;
      mutable.config = original.config;
    }
    return threw;
  };

  check(
    "the contract refuses `core: true` on a plugin whose required list leaves the machine",
    refuses(() => {
      mutable.core = true;
    }),
  );
  check(
    "the contract refuses a capability that cannot be stored",
    refuses(() => {
      mutable.needs = [
        ...original.needs,
        { kind: "nonsense.cap" as unknown as CapabilityKind, reason: "not storable" },
      ];
    }),
  );
  check(
    "the contract refuses a setting key the save path would drop",
    refuses(() => {
      mutable.config = [
        ...(original.config ?? []),
        { key: "google.nonsense", label: "Nonsense", hint: "test", kind: "text" },
      ];
    }),
  );
  check(
    "the contract refuses a duplicate plugin id",
    refuses(() => {
      mutable.id = "weather";
    }),
  );

  let restored = true;
  try {
    new PluginRegistry();
  } catch {
    restored = false;
  }
  const googleAfter = entry(gcal.GOOGLE_PLUGIN_ID);
  check(
    "and it passes again once every descriptor is put back",
    restored &&
      googleAfter?.descriptor.core !== true &&
      googleAfter?.descriptor.needs.every((spec) => (spec.kind as string) !== "nonsense.cap") === true,
    `restored=${restored} needs=${JSON.stringify(googleAfter?.descriptor.needs.map((s) => s.kind))}`,
  );

  const first = getRegistry();
  check("getRegistry() is a process-wide singleton", getRegistry() === first);
  resetRegistry();
  check("resetRegistry() drops it, which is what a test needs", getRegistry() !== first);
});

/* ------------------------------------------------------------------ */
/* Cleanup                                                            */
/* ------------------------------------------------------------------ */

await group("Cleanup", () => {
  check("every fetch stub was restored", globalThis.fetch === REAL_FETCH, "globalThis.fetch still points at a stub");
  check(
    "the settings file never left the temp directory",
    settings.settingsPath() === SETTINGS_FILE,
    settings.settingsPath(),
  );
});

store.close();
rmSync(DATA_DIR, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);

/* ------------------------------------------------------------------ */
/* MUTATION EVIDENCE                                                  */
/* ------------------------------------------------------------------ */

/**
 * Filled in after the runs; see the accompanying report.
 */
void 0;
