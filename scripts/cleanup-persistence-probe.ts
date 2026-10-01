/**
 * Undo the persistence probe's residue in the user's real data.
 *
 * `npm run verify:persistence` is designed to run against a live server with the
 * **real** `data/` directory, because its whole point is a restart proving that
 * a stored value survived. That is a legitimate design, and it means running the
 * script has real side effects — which is exactly why it leaves a
 * `data/persistence-check.json` describing them, and why this script exists to
 * read that file and reverse what it names.
 *
 * WHAT IT UNDOES, AND WHAT IT DELIBERATELY DOES NOT
 *
 *  - Restores `identity.name` and `identity.latitude` to the values recorded
 *    *before* the run. `latitude` is where the script parks its marker, and
 *    `name` is what it sets to prove a settings write persists.
 *  - Deletes only the conversation rows whose text carries the marker. The
 *    script's `conversationBefore` count is not used to truncate: a real
 *    conversation may legitimately have grown during the same window, and
 *    deleting by count would take the user's own messages with it.
 *  - Leaves the marker file in place, so the record of what happened survives
 *    this cleanup. Delete it by hand once you are satisfied.
 *
 * Idempotent: run it twice and the second run finds nothing to do.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/cleanup-persistence-probe.ts
 */

import { existsSync, readFileSync } from "node:fs";

import { getStore } from "../src/lib/core/store";
import { mergePatch, loadSettings, saveSettings, settingsPath } from "../src/lib/settings/store";

const MARKER_FILE = "data/persistence-check.json";

if (!existsSync(MARKER_FILE)) {
  console.log(`no ${MARKER_FILE} — nothing to undo`);
  process.exit(0);
}

const record = JSON.parse(readFileSync(MARKER_FILE, "utf8")) as {
  marker?: string;
  markerBefore?: string;
  name?: string;
};
const marker = record.marker ?? "";
console.log(`probe marker: ${marker || "(none recorded)"}`);

/* ---- the settings the probe wrote --------------------------------- */

const before = record.markerBefore ?? "";
const nameNow = loadSettings().identity.name;
const latNow = loadSettings().identity.latitude;

// Only touch a field that still holds what the probe put there. If the user has
// since named themselves, that is their value and this script has no business
// overwriting it.
const patch =
  nameNow === (record.name ?? "")
    ? { identity: { name: "", latitude: before } }
    : latNow === marker
      ? { identity: { latitude: before } }
      : null;

if (patch) {
  const result = saveSettings(mergePatch(loadSettings(), patch));
  console.log(
    result.ok
      ? `settings restored: name="${loadSettings().identity.name}", latitude="${loadSettings().identity.latitude}"`
      : `settings could not be written: ${result.error ?? "unknown"}`,
  );
} else {
  console.log("settings untouched: neither field still holds a probe value");
}
console.log(`settings file: ${settingsPath()}`);

/* ---- the conversation row the probe wrote ------------------------- */

if (marker.length > 0) {
  const store = getStore();
  const deleted = store.db
    .prepare(`DELETE FROM conversation WHERE text LIKE ?`)
    .run(`%${marker}%`).changes;
  console.log(`conversation rows carrying the marker: ${deleted} deleted, ${store.counts().conversation} left`);
} else {
  console.log("no marker recorded, so no conversation row could be identified");
}
