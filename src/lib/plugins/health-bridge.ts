/**
 * The health plugin's device half: a token your phone can hold, and the sample
 * normaliser that turns whatever it posts into days in Xana's own store.
 *
 * WHY THIS EXISTS AT ALL
 *
 * The folder half of health (`adapters/health.ts`) can only read files that are
 * already on this machine, and a phone cannot put them there. There is no honest
 * way to read Apple Health or Google Fit directly: HealthKit is on-device only,
 * Google Fit needs OAuth and a cloud round trip. So the phone gets a one-line
 * Shortcut (or Tasker action) that POSTs a small JSON body to this machine, and
 * Xana treats the arriving bytes as the source of truth for that day.
 *
 * THE TOKEN IS THE AUTHORISATION
 *
 * The user generates the token on their own machine, copies it into their own
 * phone, and the phone presents it on every post. There is no capability grant
 * on that path, and asking for one would be theatre: `local.read` describes
 * Xana reading a folder the user named, which is not what happens when a request
 * arrives from the LAN. The token is the grant, and it is what makes an
 * unauthenticated POST impossible. Two consequences follow, and both are load
 * bearing:
 *
 *  1. `deviceToken()` never returns the token in an HTTP response. The panel
 *     shows it to the user locally so they can copy it to their phone; the
 *     ingest endpoint compares against it and says only "no" when it differs.
 *  2. The comparison is `timingSafeEqual` on equal-length buffers, exactly like
 *     `stateMatches` in `google-calendar.ts`, so a caller cannot learn the
 *     token one byte at a time by measuring how long a rejection takes.
 *
 * WHY `normalizeSample` RE-STATES THE ADAPTER'S KEY TABLE
 *
 * `adapters/health.ts` reads files; this file reads request bodies. The two
 * inputs are different (a body is already parsed, a file may be JSONL) but the
 * *vocabulary* is one thing and a phone posting `sleep_hours` has to land in the
 * same field as an Apple Health export saying `asleepHours`. The key lists below
 * are kept deliberately identical to the adapter's, and if a third spelling is
 * ever tolerated it must be added in both places — a divergence would mean the
 * same sample landing in different fields depending on which door it came in.
 *
 * The one rule that is NOT re-stated is the mood mapping: `asMood` is imported
 * from the adapter. It is the single place the two doors could genuinely have
 * disagreed, because a file always holds mood as a string while a parsed body
 * can hold `mood: 7` as a number, and a copy written against the file's shape
 * would have silently dropped every numeric mood a phone sent.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

import type { HealthSample } from "../core/types";
import { getStore } from "../core/store";
import { asMood } from "../adapters/health";
import { credential, savePluginSetting } from "../settings/store";

/** The settings key the token lives under. Declared in `PLUGIN_SETTING_KEYS`. */
const DEVICE_TOKEN_KEY = "health.deviceToken";

/**
 * The switch that lets a phone post at all.
 *
 * Off by default, and that is the consent model rather than an afterthought: an
 * endpoint that accepts samples from the LAN should not exist on a fresh install
 * before the user has decided they want one. `health.ingest` is the user saying
 * yes, and the token says who.
 */
const INGEST_KEY = "health.ingest";

/**
 * Values that count as "on".
 *
 * The field is declared as text with the example `on`, because a checkbox is not
 * available to the descriptor's config vocabulary. A phone shortcut or a script
 * will plausibly send `true` or `1`, so the check accepts those spellings rather
 * than making the setting a guessing game. Everything else — including `"off"`,
 * `"yes please"` and a stray `"0"` — is off.
 */
const AFFIRMATIVE = new Set(["on", "true", "yes", "1"]);

/** 32 bytes → 64 hex characters. Long enough that guessing is not a strategy. */
const TOKEN_BYTES = 32;

/**
 * How many samples one POST may carry.
 *
 * A Shortcut that has been running for a year would otherwise be able to hand
 * over an unbounded array and make the event loop chew on it. A month of daily
 * samples is 31; 500 leaves room for a backfill and still bounds the work.
 */
const MAX_PAYLOAD_SAMPLES = 500;

/* ------------------------------------------------------------------ */
/* The device token                                                    */
/* ------------------------------------------------------------------ */

/**
 * Cached so the "is it the same token across calls" question is answered without
 * depending on filesystem mtime resolution.
 *
 * `savePluginSetting` writes the file and updates the settings store's own
 * cache, so this variable is an optimisation rather than the source of truth —
 * it is filled from the settings layer on every miss, which is what keeps it
 * correct when the file is edited from outside the app.
 */
let cachedToken: { value: string; from: "settings" | "env" | "none" } | undefined;

/**
 * The token a phone presents. Generated on first call and persisted.
 *
 * Persistence goes through the settings layer's plugin-setting path for the same
 * reason the model API key does: the user must never have to hand-edit a dotfile,
 * the file is written atomically with `0600` where the platform honours it, and
 * the value is addressable by key so the panel can show, and the user can clear,
 * exactly one field.
 *
 * An environment value wins over a stored one — that is `credential()`'s
 * documented precedence, and it is the escape hatch for a headless install — but
 * a generated value is only written to the file when no layer answered. A token
 * is either the user's chosen value or Xana's, never a generated one silently
 * replacing the user's.
 */
export function deviceToken(): string {
  const found = credential(DEVICE_TOKEN_KEY);
  if (found.present) {
    cachedToken = { value: found.value, from: found.from };
    return found.value;
  }

  // Another module in this process may have generated it already; the settings
  // write lands in the file and in the cache, so this only matters when the file
  // is unwritable and we are falling back to a process-local value.
  if (cachedToken && cachedToken.value.length > 0) return cachedToken.value;

  const generated = randomBytes(TOKEN_BYTES).toString("hex");
  savePluginSetting({ [DEVICE_TOKEN_KEY]: generated });
  cachedToken = { value: generated, from: "settings" };
  return generated;
}

/** Forget the memoised token. Tests use this to re-read the file. */
export function invalidateDeviceTokenCache(): void {
  cachedToken = undefined;
}

/**
 * Whether a presented token is the stored one.
 *
 * Three refusals, in order, and the shape of each matters:
 *
 *  - a blank candidate is refused before anything is read, so an absent header
 *    cannot accidentally match an absent stored value;
 *  - a length difference is refused without a comparison, because
 *    `timingSafeEqual` throws on unequal lengths and, more to the point, there
 *    is nothing to hide about the length of a value the caller did not supply;
 *  - equal lengths are compared in constant time, so the time to say "no" says
 *    nothing about how much of the token was right.
 *
 * The stored token is never returned, logged or echoed by this function — it
 * exists only as `left` for the duration of the comparison.
 */
export function tokenMatches(given: string): boolean {
  const candidate = typeof given === "string" ? given.trim() : "";
  if (candidate.length === 0) return false;

  const expected = deviceToken();
  if (expected.length === 0) return false;

  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Whether a phone is allowed to post at all right now. */
export function ingestEnabled(): boolean {
  return AFFIRMATIVE.has(credential(INGEST_KEY).value.toLowerCase());
}

/**
 * Normalising whatever the phone sent.
 *
 * The mood mapping is not implemented here: `asMood` is imported from
 * `adapters/health.ts` so a body and a file agree about what `7` means. Every
 * other key spelling below is the adapter's list, kept identical on purpose.
 */

/** Numbers arrive as JSON numbers or as strings from a hand-written shortcut. */
function num(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Whether a `YYYY-MM-DD` prefix is a plausible calendar day.
 *
 * The regex alone accepts `2026-13-45`, and a row keyed on a month that does not
 * exist sorts into the wrong place in every trend query downstream. The range
 * check costs three comparisons and stops that at the door.
 */
function plausibleDay(day: string): boolean {
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  return month >= 1 && month <= 12 && date >= 1 && date <= 31;
}

/**
 * One posted object → one sample, or `undefined` when there is nothing in it.
 *
 * The key-spelling tolerance is the adapter's, deliberately and exactly: the
 * same exporter names have to work whichever door the data comes in through.
 * `source` is stamped here as the caller's string — `ingest` passes `"device"`,
 * and a test wants to pass something else — so the normaliser itself makes no
 * claim about provenance.
 */
export function normalizeSample(raw: unknown, source = "device"): HealthSample | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;

  const pick = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (record[k] !== undefined && record[k] !== null) return record[k];
    }
    return undefined;
  };

  const dateRaw = pick("date", "day", "startDate", "start", "timestamp");
  if (typeof dateRaw !== "string") return undefined;
  const day = dateRaw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !plausibleDay(day)) return undefined;

  const sample: HealthSample = {
    date: day,
    sleepHours: num(pick("sleepHours", "sleep_hours", "sleep", "asleepHours", "hoursAsleep")),
    sleepQuality: num(pick("sleepQuality", "sleep_quality", "sleepScore")),
    steps: num(pick("steps", "stepCount", "step_count")),
    activeMinutes: num(pick("activeMinutes", "active_minutes", "exerciseMinutes", "activityMinutes")),
    restingHeartRate: num(pick("restingHeartRate", "resting_heart_rate", "restingHr", "rhr")),
    mood: asMood(pick("mood", "moodLabel", "mood_label")),
    /**
     * Energy and meals are accepted beyond the adapter's list because both are
     * things only *this* door can carry: the adapter reads an export that has no
     * reason to know about Xana's own energy scale, while the phone shortcut the
     * user writes is exactly where "how do you feel, 1-5" gets logged. Same
     * reasoning for the date, and the same `hasAnything` rule applies.
     */
    energy: num(pick("energy", "energyLevel", "energy_level")),
    energyAt: typeof pick("energyAt", "energy_at") === "string" ? String(pick("energyAt", "energy_at")) : undefined,
    meals: num(pick("meals", "mealCount", "meal_count")),
    source,
  };

  /**
   * A date with no reading in it is not a sample.
   *
   * Without this, a payload of `{date: "2026-01-01"}` would insert a row that
   * says nothing and every downstream average would have to defend itself
   * against an empty day.
   */
  const hasAnything =
    sample.sleepHours !== undefined ||
    sample.sleepQuality !== undefined ||
    sample.steps !== undefined ||
    sample.activeMinutes !== undefined ||
    sample.restingHeartRate !== undefined ||
    sample.mood !== undefined ||
    sample.energy !== undefined ||
    sample.meals !== undefined;
  return hasAnything ? sample : undefined;
}

/**
 * A posted body → zero or more samples, plus how many entries were unusable.
 *
 * Accepts the three shapes a shortcut plausibly builds:
 *
 *   - a single object, `{"date":"2026-01-01","steps":9000}`;
 *   - an array of those;
 *   - a wrapper — `{samples|health|data|records: [...]}` — which is what the
 *     adapter's file parser accepts, so a payload can be piped straight from an
 *     export into a POST.
 *
 * A wrapper holding nothing usable falls back to treating the outer object as a
 * single sample, matching `parseHealthFile`. There is no JSONL branch: the body
 * is parsed once by the route, and a phone sends one JSON document.
 *
 * `rejected` exists so the route can be honest: a payload with nothing valid in
 * it is a 400 the user can act on, not a silent 200 that stored nothing.
 */
export function normalizePayload(raw: unknown): { samples: HealthSample[]; rejected: number } {
  const samples: HealthSample[] = [];
  let rejected = 0;

  const take = (items: unknown[]): void => {
    for (const item of items) {
      if (samples.length >= MAX_PAYLOAD_SAMPLES) {
        rejected += 1;
        continue;
      }
      const sample = normalizeSample(item);
      if (sample) samples.push(sample);
      else rejected += 1;
    }
  };

  if (Array.isArray(raw)) {
    take(raw);
    return { samples, rejected };
  }

  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    const wrapped = record["samples"] ?? record["health"] ?? record["data"] ?? record["records"];
    if (Array.isArray(wrapped)) {
      take(wrapped);
      if (samples.length > 0) return { samples, rejected };
      /**
       * The wrapper was there and held nothing usable. Fall through and try the
       * outer object as a single sample, exactly as the file parser does — but
       * keep the count from the entries that were rejected, because a phone's
       * owner needs "2 rejected" rather than "1 rejected" when they sent an array
       * of two bad rows. An empty wrapper leaves the count at zero and is not
       * penalised for being empty.
       */
      const single = normalizeSample(record);
      if (single) {
        samples.push(single);
        return { samples, rejected };
      }
      return { samples, rejected: rejected > 0 ? rejected : rejected + 1 };
    }
    const single = normalizeSample(record);
    if (single) samples.push(single);
    else rejected += 1;
    return { samples, rejected };
  }

  return { samples, rejected: 1 };
}

/* ------------------------------------------------------------------ */
/* Writing the days                                                    */
/* ------------------------------------------------------------------ */

export interface IngestResult {
  /** Distinct days written. Days, not samples: the store is keyed by day. */
  days: number;
  /**
   * The newest day in the payload, so a caller can confirm what landed.
   * Absent only when there was nothing to write, which the route refuses first.
   */
  lastDay?: string;
}

/**
 * Upsert posted samples as device readings.
 *
 * Rows are written oldest-first so the file's per-day "newest wins" rule holds
 * across an overlapping payload, and each day is written exactly once — the
 * store's `ON CONFLICT(day)` upsert means posting the same day twice updates it
 * rather than adding a second row, which is what makes a shortcut safe to run
 * repeatedly without double-counting steps.
 *
 * The `source` column is stamped `"device"` on every row this function writes,
 * so `lastHealthSource()` can answer the one question the panel needs to be
 * honest about: has anything a phone sent actually ever arrived?
 *
 * AFTER THE WRITE
 *
 * A device post has to be visible on the next read, and two caches stand in the
 * way. `refreshHealth()` drops both: `invalidateContext()` clears the assembled
 * life state *and* the adapter cache it was built from, and the plugin registry's
 * own entry is invalidated as well, because the gateway's registry and the plugin
 * registry are separate objects and a status row that still says "3 days" after a
 * post is a lie the panel would show.
 *
 * The write and the refresh are separate steps on purpose. `ingest` returning
 * means the day is in SQLite — that is the durable fact, and a caller can rely on
 * it. The refresh is cache maintenance, so a caller that is about to *read* the
 * state must `await refreshHealth()` to sequence behind it; the route does, and
 * so does the check script. Nothing about the refresh can fail the ingest: the
 * row is already written, so a failed import or adapter build is swallowed and
 * the next cold read picks the day up regardless.
 */
export function ingest(samples: HealthSample[]): IngestResult {
  const store = getStore();

  // Oldest first, so a payload that overlaps an earlier post ends with the
  // newest values on top. `sort` is stable, so equal days keep their order and
  // the last one written still wins.
  const ordered = [...samples].sort((a, b) => a.date.localeCompare(b.date));

  const days = new Set<string>();
  for (const sample of ordered) {
    store.upsertHealth({ ...sample, source: "device" });
    days.add(sample.date);
  }

  /**
   * The flush is kicked off here rather than awaited so that `ingest` stays a
   * plain synchronous write — the durable half — and a caller that is not about
   * to read the state does not pay for it. A caller that *is* about to read
   * awaits `refreshHealth()`, which chains behind this one rather than
   * overlapping it.
   */
  void refreshHealth();
  const lastDay = ordered.length > 0 ? ordered[ordered.length - 1].date : undefined;
  return { days: days.size, lastDay };
}

/**
 * Make just-written days visible to the next read.
 *
 * Both layers are dropped, and the failure of either is not an error: this is
 * cache maintenance after a successful write, not part of it. The dynamic
 * imports are not stylistic — the context gateway pulls in the whole adapter
 * graph, so importing it statically here would make this module the newest link
 * in a cycle for a function only the write path needs. Dynamic `import()`
 * resolves to the same module instance the rest of the process is using, so the
 * invalidation reaches the live cache and not a second copy of it.
 *
 * CONCURRENT CALLS ARE SEQUENCED, NOT OVERLAPPED
 *
 * `ingest` starts a refresh without awaiting it, and the route then awaits one to
 * be sure the post is visible before it answers. Left as two independent calls
 * those would interleave — the first would invalidate the adapter after the
 * second had already re-read it — so a call that arrives while a refresh is in
 * flight chains *behind* it and runs again afterwards. The second pass is what
 * makes the trailing write visible; the chaining is what stops the two from
 * undoing each other. Every await below resolves inside a `try`, so a failing
 * import cannot leave a rejected promise waiting for the next caller.
 */
let inFlightRefresh: Promise<void> = Promise.resolve();

export function refreshHealth(): Promise<void> {
  inFlightRefresh = inFlightRefresh.then(() => runRefresh(), () => runRefresh());
  return inFlightRefresh;
}

async function runRefresh(): Promise<void> {
  try {
    const { invalidateContext } = await import("../context/gateway");
    invalidateContext();
  } catch {
    // The row is durable. A gateway that cannot be loaded now will read the
    // day from SQLite when it is next asked to assemble the state.
  }
  try {
    const { getRegistry } = await import("./registry");
    // `refresh` invalidates the plugin's cached slice before re-running it, so
    // the health adapter's five-minute TTL cannot hide the day that just landed.
    await getRegistry().refresh("health");
  } catch {
    // Same reasoning: the plugin cache is an optimisation over the store.
  }
}

/** The two exported fallbacks, for the boot contract and the panel. */
export { DEVICE_TOKEN_KEY, INGEST_KEY };
