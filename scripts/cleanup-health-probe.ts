/**
 * Delete the day and the settings the phone-token check wrote.
 *
 * A one-shot maintenance script, not part of any suite. The live check for the
 * phone-token endpoint needs a real server with the real settings file, and the
 * real settings file and database belong to the user, so the check owes an undo
 * that touches exactly what it touched and nothing else:
 *
 *   - the `1999-01-01` probe day, deleted by day so no other reading moves;
 *   - `health.ingest` and `health.deviceToken`, removed from `data/settings.json`
 *     so the endpoint is closed again and no token the user did not choose is
 *     left behind. An environment value, if the user set one, takes over again
 *     by itself — that is `credential()`'s precedence, not something this undoes.
 *
 * Both operations are idempotent, so running it twice is safe. It is deliberately
 * a script rather than a store method: nothing in the app needs to delete a day,
 * and adding a method for a test's convenience is how a product grows an API it
 * cannot justify.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/cleanup-health-probe.ts
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { getStore } from "../src/lib/core/store";
import { invalidateSettingsCache, settingsPath } from "../src/lib/settings/store";

const PROBE_DAY = "1999-01-01";
const PROBE_KEYS = ["health.deviceToken", "health.ingest"] as const;

const store = getStore();
const deleted = store.db.prepare(`DELETE FROM health_samples WHERE day = ?`).run(PROBE_DAY).changes;
console.log(`probe day ${PROBE_DAY}: ${deleted} row(s) deleted`);

const file = settingsPath();
if (!existsSync(file)) {
  console.log(`no settings file at ${file}`);
} else {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { sources?: Record<string, string> };
  const sources = raw.sources ?? {};
  const removed = PROBE_KEYS.filter((key) => {
    if (sources[key] === undefined) return false;
    delete sources[key];
    return true;
  });
  raw.sources = sources;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  invalidateSettingsCache();
  console.log(`settings: ${removed.length ? `removed ${removed.join(", ")}` : "nothing to remove"}`);
}
