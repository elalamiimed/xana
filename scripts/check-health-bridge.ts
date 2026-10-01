/**
 * The phone door, tested against the ways it can lie.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-health-bridge.ts
 *
 * WHAT IS BEING CHECKED
 *
 * A device token that is stable, unforgeable in the cheap ways, and never echoed.
 * A payload parser that accepts the three shapes a shortcut actually builds and
 * rejects a date that is not a day. An ingest that writes days rather than
 * samples, so running the same shortcut twice updates instead of double-counting.
 * And the one question the panel needs answered honestly: did anything a phone
 * sent actually arrive (`lastHealthSource()`), checked by reading the store back
 * rather than by trusting the response body.
 *
 * The assertions are written in the direction that fails when the guarantee stops
 * holding. "The token is refused" is checked for a wrong token, a *prefix* of the
 * right token, and the right token with one character changed — a comparison that
 * accepted a prefix would pass a naive `startsWith` check and fail this one. "The
 * invalid day did not write" is checked by counting rows before and after, not by
 * inspecting the 400, because a handler that answers 400 *and* writes is exactly
 * the bug worth catching.
 *
 * NO CAPABILITY IS GRANTED ANYWHERE IN THIS FILE, ON PURPOSE
 *
 * The settings file starts as `{}`, so `permissions` is empty and the health
 * plugin has no adapter at all — `health.folder` is absent too. Every POST below
 * must nevertheless write, because a phone posting is not the folder-read
 * permission. If the ingest path ever starts asking for `local.read`, most of this
 * file fails.
 *
 * ISOLATION
 *
 * `XANA_DATA_DIR` is pointed at a fresh temp directory BEFORE the settings store
 * is imported, because `store.ts` resolves `DATA_DIR` at module load. A settings
 * file is written there immediately, because `migrateLegacySettings()` moves
 * `<cwd>/.xana/settings.json` into the data dir when the target does not exist —
 * with a temp data dir and no file, that would MOVE a real file out of the
 * project and then delete it with the directory. The path is asserted to be the
 * temp one before anything else runs, and the directory is removed in a `finally`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/* ------------------------------------------------------------------ */
/* The temp world, before any module that reads it                     */
/* ------------------------------------------------------------------ */

const DATA_DIR = mkdtempSync(path.join(tmpdir(), "xana-health-"));
process.env.XANA_DATA_DIR = DATA_DIR;

/** `{}` coerces to the defaults: no permissions, no source values. */
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
writeFileSync(SETTINGS_FILE, "{}\n", { encoding: "utf8", mode: 0o600 });

/**
 * An exported variable would outrank "absent" and make the run depend on the
 * machine it happens to be running on. The token in particular must come from
 * this run's settings file, not from someone's shell.
 */
const INHERITED_ENV = [
  "XANA_HEALTH_DIR",
  "XANA_DEVICE_TOKEN",
  "XANA_HEALTH_DEVICE_TOKEN",
  "XANA_HEALTH_INGEST",
];
for (const name of INHERITED_ENV) delete process.env[name];

/* ------------------------------------------------------------------ */
/* Imports, after the data dir has moved                               */
/* ------------------------------------------------------------------ */

const { setStore, XanaStore } = await import("../src/lib/core/store");
const settings = await import("../src/lib/settings/store");
const bridge = await import("../src/lib/plugins/health-bridge");
const ingestRoute = await import("../src/lib/plugins/health-ingest");
const automation = await import("../src/lib/plugins/automation");

const store = new XanaStore(path.join(DATA_DIR, "health.db"));
setStore(store);

/* ------------------------------------------------------------------ */
/* Harness                                                            */
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

/* ------------------------------------------------------------------ */
/* Request helpers                                                    */
/* ------------------------------------------------------------------ */

const URL_INGEST = "http://127.0.0.1:4310/api/health/ingest";

interface Reply {
  status: number;
  body: string;
  json: () => unknown;
}

/**
 * A POST with a raw body, so a malformed body can be sent verbatim.
 *
 * `token` is a convenience: it splices the token into the JSON body the way a
 * shell `curl -d` would. `header` sets the header instead. They are separate
 * options because one of the checks is that the body field alone works, and
 * another is that whitespace around a header value is tolerated.
 */
async function post(
  body: string,
  opts: { token?: string; header?: string; url?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.header !== undefined) headers["X-Device-Token"] = opts.header;

  let payload = body;
  if (opts.token !== undefined) {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      payload = JSON.stringify({ ...(parsed as Record<string, unknown>), token: opts.token });
    }
  }

  const request = new Request(opts.url ?? URL_INGEST, {
    method: "POST",
    headers,
    body: payload,
  });
  const response = await ingestRoute.postHealthIngest(request);
  const text = await response.text();
  return {
    status: response.status,
    body: text,
    json: () => JSON.parse(text) as unknown,
  };
}

/** The message a refusal carries, so the wording is asserted, not just the code. */
function messageOf(reply: Reply): string {
  const parsed = reply.json();
  if (typeof parsed === "object" && parsed !== null) {
    const message = (parsed as Record<string, unknown>)["message"];
    if (typeof message === "string") return message;
  }
  return "";
}

const rows = () => store.healthSamples(50);
const rowFor = (day: string) => rows().find((row) => row.date === day);

/* ------------------------------------------------------------------ */
/* 1. The token                                                       */
/* ------------------------------------------------------------------ */

await group("The device token is generated once, persisted, and never echoed", () => {
  check(
    "the settings file is inside a temp directory, not the project's data/",
    settings.settingsPath() === SETTINGS_FILE && settings.settingsPath().startsWith(DATA_DIR),
    settings.settingsPath(),
  );
  check(
    "nothing is granted and the health folder is unset on this fresh file",
    Object.keys(automation.grants()).length === 0 && settings.credential("health.folder").present === false,
    JSON.stringify({ grants: automation.grants(), folder: settings.credential("health.folder").present }),
  );

  const first = bridge.deviceToken();
  const second = bridge.deviceToken();
  check("a token is 32 bytes of hex", /^[0-9a-f]{64}$/.test(first), first);
  check("asking twice returns the same token", first === second, `${first} vs ${second}`);
  check(
    "the token is stored under the plugin key the settings layer owns",
    settings.credential("health.deviceToken").present &&
      settings.credential("health.deviceToken").value === first,
    settings.credential("health.deviceToken").from,
  );

  const onDisk = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as {
    sources?: Record<string, string>;
  };
  check(
    "the token reached the settings file, so no one has to hand-edit it",
    onDisk.sources?.["health.deviceToken"] === first,
    JSON.stringify(onDisk.sources),
  );

  /**
   * A second, independently seeded settings file must produce a different token.
   * A generator that returned a constant would pass every check above.
   */
  const secondToken = bridge.deviceToken();
  settings.savePluginSetting({ "health.deviceToken": "" });
  bridge.invalidateDeviceTokenCache();
  const regenerated = bridge.deviceToken();
  check(
    "a cleared token is replaced by a new one, not reissued",
    /^[0-9a-f]{64}$/.test(regenerated) && regenerated !== secondToken,
    `${regenerated} vs ${secondToken}`,
  );
  // Back to the original for the rest of the run.
  settings.savePluginSetting({ "health.deviceToken": first });
  bridge.invalidateDeviceTokenCache();
  check("the token under test is the stored one again", bridge.deviceToken() === first);
});

/* ------------------------------------------------------------------ */
/* 2. Matching                                                        */
/* ------------------------------------------------------------------ */

await group("A wrong, short or missing token is refused", () => {
  const token = bridge.deviceToken();

  check("the right token matches", bridge.tokenMatches(token) === true);
  check(
    "surrounding whitespace is tolerated, because a shortcut field often adds it",
    bridge.tokenMatches(`  ${token}\n`) === true,
  );
  check("an empty token matches nothing", bridge.tokenMatches("") === false);
  check("a whitespace-only token matches nothing", bridge.tokenMatches("   ") === false);
  check(
    "a short token matches nothing",
    bridge.tokenMatches(token.slice(0, 8)) === false &&
      bridge.tokenMatches("abc") === false,
  );
  check(
    "a prefix of the right token matches nothing",
    bridge.tokenMatches(token.slice(0, token.length - 1)) === false,
  );
  check(
    "a token with one character changed matches nothing",
    bridge.tokenMatches(`${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`) === false,
  );
  check(
    "a token of the right length but the wrong bytes matches nothing",
    bridge.tokenMatches("0".repeat(token.length)) === false,
  );
});

/* ------------------------------------------------------------------ */
/* 3. Normalising a posted body                                       */
/* ------------------------------------------------------------------ */

await group("A posted body is normalised the way the adapter's files are", () => {
  const single = bridge.normalizeSample({ date: "2026-01-05", steps: 8000 });
  check(
    "one object becomes one device sample",
    single !== undefined && single.date === "2026-01-05" && single.steps === 8000 && single.source === "device",
    JSON.stringify(single),
  );
  check(
    "the key spellings the adapter tolerates are tolerated here",
    (() => {
      const s = bridge.normalizeSample({
        startDate: "2026-01-06T08:12:00Z",
        sleep_hours: "7.5",
        stepCount: "9123",
        active_minutes: 42,
        resting_heart_rate: 54,
        mood_label: "bright",
      });
      return (
        s !== undefined &&
        s.date === "2026-01-06" &&
        s.sleepHours === 7.5 &&
        s.steps === 9123 &&
        s.activeMinutes === 42 &&
        s.restingHeartRate === 54 &&
        s.mood === "bright"
      );
    })(),
    JSON.stringify(bridge.normalizeSample({ startDate: "2026-01-06T08:12:00Z", sleep_hours: "7.5" })),
  );
  check(
    "a numeric mood is placed on the four-point scale, as the adapter does",
    bridge.normalizeSample({ day: "2026-01-07", mood: "9" })?.mood === "bright" &&
      bridge.normalizeSample({ day: "2026-01-07", mood: "1" })?.mood === "low",
    JSON.stringify(bridge.normalizeSample({ day: "2026-01-07", mood: "1" })),
  );
  check(
    "a date with no reading attached is not a sample",
    bridge.normalizeSample({ date: "2026-01-08" }) === undefined,
  );
  check(
    "a sample with no date is not a sample",
    bridge.normalizeSample({ steps: 4000 }) === undefined,
  );
  check(
    "a day that is not a day is refused",
    bridge.normalizeSample({ date: "2026-13-45", steps: 1 }) === undefined &&
      bridge.normalizeSample({ date: "not-a-date", steps: 1 }) === undefined &&
      bridge.normalizeSample({ date: "2026-1-5", steps: 1 }) === undefined,
  );
  check(
    "energy and meals survive, because the phone is the only door they come through",
    (() => {
      const s = bridge.normalizeSample({ date: "2026-01-09", energy: 4, meals: 2 });
      return s !== undefined && s.energy === 4 && s.meals === 2;
    })(),
    JSON.stringify(bridge.normalizeSample({ date: "2026-01-09", energy: 4, meals: 2 })),
  );

  const array = bridge.normalizePayload([{ date: "2026-01-10", steps: 1 }, { nope: true }]);
  check(
    "an array yields its usable entries and counts the rest",
    array.samples.length === 1 && array.rejected === 1,
    JSON.stringify(array),
  );
  const wrapped = bridge.normalizePayload({ samples: [{ date: "2026-01-11", steps: 2 }] });
  check(
    "a {samples:[…]} wrapper is unwrapped",
    wrapped.samples.length === 1 && wrapped.rejected === 0,
    JSON.stringify(wrapped),
  );
  for (const key of ["health", "data", "records"]) {
    const other = bridge.normalizePayload({ [key]: [{ date: "2026-01-12", steps: 3 }] });
    check(`a {${key}:[…]} wrapper is unwrapped too`, other.samples.length === 1, JSON.stringify(other));
  }
  const bare = bridge.normalizePayload({ date: "2026-01-13", steps: 4 });
  check("a bare object is a payload of one", bare.samples.length === 1, JSON.stringify(bare));
  const nothing = bridge.normalizePayload({ hello: "world" });
  check(
    "an object with nothing usable is reported as rejected, not as empty success",
    nothing.samples.length === 0 && nothing.rejected > 0,
    JSON.stringify(nothing),
  );
});

/* ------------------------------------------------------------------ */
/* 4. The endpoint, before anything is switched on                    */
/* ------------------------------------------------------------------ */

await group("The endpoint refuses before it writes", async () => {
  const token = bridge.deviceToken();
  const good = JSON.stringify({ date: "2026-02-01", steps: 1111 });

  const noToken = await post(good);
  check(
    '400 "No device token" when the header and the body both lack one',
    noToken.status === 400 && messageOf(noToken) === "No device token",
    `${noToken.status} ${noToken.body}`,
  );

  const wrong = await post(good, { token: "definitely-not-the-token" });
  check(
    '403 "That token is not right." on a mismatch',
    wrong.status === 403 && messageOf(wrong) === "That token is not right.",
    `${wrong.status} ${wrong.body}`,
  );
  check(
    "and the refusal does not contain the stored token",
    !wrong.body.includes(token) && !wrong.body.includes(token.slice(0, 16)),
    wrong.body,
  );

  const short = await post(good, { token: token.slice(0, 8) });
  check(
    "a short token is refused at the endpoint too, before anything is read",
    short.status === 403 && messageOf(short) === "That token is not right.",
    `${short.status} ${short.body}`,
  );

  const broken = await post("{not json", { header: token });
  check(
    "400 on a body that is not JSON, checked before the switch",
    broken.status === 400 && /not JSON/i.test(messageOf(broken)),
    `${broken.status} ${broken.body}`,
  );

  const off = await post(good, { header: token });
  check(
    '409 "Phone ingest is off." while health.ingest is not affirmative',
    off.status === 409 && messageOf(off) === "Phone ingest is off.",
    `${off.status} ${off.body}`,
  );
  check("nothing was written by any refused post", rows().length === 0, JSON.stringify(rows()));

  check(
    "health.ingest is off because it was never set, not because of a broken read",
    settings.credential("health.ingest").present === false && bridge.ingestEnabled() === false,
  );
});

/* ------------------------------------------------------------------ */
/* 5. The endpoint switched on, with no capability granted            */
/* ------------------------------------------------------------------ */

await group("With phone ingest on, a valid post lands — with no capability granted", async () => {
  const token = bridge.deviceToken();
  automation.writePluginSettings({ "health.ingest": "on" });

  check("the affirmative spelling is recognised", bridge.ingestEnabled() === true);
  check(
    "still nothing granted: the token is the whole authorisation on this path",
    Object.keys(automation.grants()).length === 0,
    JSON.stringify(automation.grants()),
  );

  const single = await post(JSON.stringify({ date: "2026-03-01", steps: 5000, sleepHours: 7 }), {
    header: token,
  });
  check(
    "a single sample is accepted",
    single.status === 200,
    `${single.status} ${single.body}`,
  );
  const body = single.json() as Record<string, unknown>;
  check(
    "the response is { ok, days, lastDay }",
    body["ok"] === true && body["days"] === 1 && body["lastDay"] === "2026-03-01",
    JSON.stringify(body),
  );
  check("the response never carries the token", !single.body.includes(token), single.body);

  const landed = rowFor("2026-03-01");
  check(
    "the day is in the store, stamped as a device reading",
    landed !== undefined && landed.steps === 5000 && landed.sleepHours === 7 && landed.source === "device",
    JSON.stringify(landed),
  );

  /**
   * The phone's second natural move, and the reason `refreshHealth` is awaited:
   * the adapter caches its slice for five minutes, so a stale read here would
   * show the user a state that predates their own post.
   */
  const { buildLifeState } = await import("../src/lib/context/gateway");
  const lifeState = await buildLifeState({ force: true });
  check(
    "the assembled life state sees the day immediately",
    lifeState.health.latest?.date === "2026-03-01" && lifeState.health.latest?.steps === 5000,
    JSON.stringify(lifeState.health.latest),
  );

  const plugins = await import("../src/lib/plugins/registry");
  const registry = plugins.getRegistry();
  await bridge.refreshHealth();
  const healthStatus = registry.statuses().find((row) => row.id === "health");
  const healthEntry = registry.list().find((entry) => entry.descriptor.id === "health");
  /**
   * The health plugin is deliberately still *blocked* — its required
   * `local.read` is for the export folder, and no one has granted it. That is the
   * point rather than a problem: the reading above landed in the store and in the
   * life state while the plugin that owns the folder half had no adapter at all.
   * A phone posting is not the folder-read permission, and if this path ever
   * starts requiring the grant, the write checks above fail before this does.
   */
  check(
    "the plugin that owns the folder half is still ungranted and blocked",
    healthStatus?.state === "blocked" && healthEntry?.missing().includes("local.read") === true,
    JSON.stringify(healthStatus),
  );
  check(
    "and its folder setting is still unset, so nothing could have been imported",
    settings.credential("health.folder").present === false,
  );

  /* A batch of three days, through the body field rather than the header. */
  const batch = await post(
    JSON.stringify({
      token,
      samples: [
        { date: "2026-03-02", steps: 6000, mood: 7 },
        { date: "2026-03-03", steps: 7000, activeMinutes: 30 },
        { date: "2026-03-04", steps: 8000, restingHeartRate: 58 },
      ],
    }),
  );
  check(
    "a three-sample batch is accepted with the token in the body",
    batch.status === 200,
    `${batch.status} ${batch.body}`,
  );
  const batchBody = batch.json() as Record<string, unknown>;
  check(
    "the batch reports three days and the newest one",
    batchBody["days"] === 3 && batchBody["lastDay"] === "2026-03-04",
    JSON.stringify(batchBody),
  );
  check(
    "every day in the batch is in the store",
    ["2026-03-02", "2026-03-03", "2026-03-04"].every((day) => rowFor(day)?.source === "device"),
    JSON.stringify(rows().map((row) => `${row.date}:${row.source}`)),
  );
  check(
    "the numeric mood was mapped on the way through",
    rowFor("2026-03-02")?.mood === "good",
    JSON.stringify(rowFor("2026-03-02")),
  );

  const before = rows().length;
  const invalid = await post(
    JSON.stringify({ token, samples: [{ date: "2026-13-45", steps: 1 }, { date: "2026-03-05" }] }),
    { header: token },
  );
  check(
    "a payload with no usable sample is a 400",
    invalid.status === 400 && /no usable samples/i.test(messageOf(invalid)),
    `${invalid.status} ${invalid.body}`,
  );
  check(
    "and an invalid day is rejected without writing anything",
    rows().length === before && rowFor("2026-13-45") === undefined,
    `${before} → ${rows().length}`,
  );
  check(
    "the 400 says how many entries were rejected, so the phone's owner can fix it",
    messageOf(invalid).includes("2 rejected"),
    messageOf(invalid),
  );

  /* The same day twice. */
  const again = await post(JSON.stringify({ token, date: "2026-03-03", steps: 9999 }), {
    header: token,
  });
  check("re-posting a day is accepted", again.status === 200, `${again.status} ${again.body}`);
  const updated = rowFor("2026-03-03");
  check(
    "the same day updates instead of duplicating",
    rows().filter((row) => row.date === "2026-03-03").length === 1 && updated?.steps === 9999,
    JSON.stringify(rows().filter((row) => row.date === "2026-03-03")),
  );
  check(
    "a field the second post omitted is kept rather than erased",
    updated?.activeMinutes === 30,
    JSON.stringify(updated),
  );
  check(
    "the row total is still one per day",
    new Set(rows().map((row) => row.date)).size === rows().length,
    JSON.stringify(rows().map((row) => row.date)),
  );

  /* The provenance question the panel asks. */
  const last = store.lastHealthSource();
  check(
    "lastHealthSource names the newest day and says a device sent it",
    last !== undefined && last.day === "2026-03-04" && last.source === "device",
    JSON.stringify(last),
  );

  /* The other door. */
  const viaXana = await post(JSON.stringify({ token, date: "2026-04-01", steps: 1234 }), {
    header: token,
    url: "http://127.0.0.1:4310/xana/health/ingest",
  });
  check(
    "the /xana path runs the same handler",
    viaXana.status === 200 && (viaXana.json() as Record<string, unknown>)["lastDay"] === "2026-04-01",
    `${viaXana.status} ${viaXana.body}`,
  );
});

/* ------------------------------------------------------------------ */
/* 6. Revoking the switch                                             */
/* ------------------------------------------------------------------ */

await group("Turning the switch off closes the door again", async () => {
  const token = bridge.deviceToken();
  automation.writePluginSettings({ "health.ingest": "off" });
  check("the word off is not affirmative", bridge.ingestEnabled() === false);

  const refused = await post(JSON.stringify({ date: "2026-05-01", steps: 5 }), { header: token });
  check(
    "a valid token with the switch off is a 409, not a write",
    refused.status === 409 && rowFor("2026-05-01") === undefined,
    `${refused.status} ${refused.body}`,
  );

  /**
   * And the check a user will actually perform: a wrong token must not be able
   * to use the endpoint to discover that the switch is off. The token is checked
   * first, so this is a 403.
   */
  const probe = await post(JSON.stringify({ date: "2026-05-01", steps: 5 }), { token: "nope" });
  check(
    "a wrong token cannot probe whether the switch is on",
    probe.status === 403,
    `${probe.status} ${probe.body}`,
  );
});

/* ------------------------------------------------------------------ */
/* Result                                                             */
/* ------------------------------------------------------------------ */

store.close();
rmSync(DATA_DIR, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
