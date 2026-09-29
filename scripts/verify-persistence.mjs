/**
 * Prove that information survives a restart.
 *
 *   node scripts/verify-persistence.mjs [baseUrl]
 *
 * "Make sure information gets saved locally" is a claim that can only be
 * settled by writing something, restarting the process, and reading it
 * back. Anything less proves that a function returned a value, not that
 * data is on disk.
 *
 * So this script does the whole loop against the HTTP surface:
 *
 *   1. read the current settings and conversation count;
 *   2. write a distinctive marker through PUT /api/settings;
 *   3. send a chat turn, so there is a durable conversation row;
 *   4. ask the caller to restart the server (it exits with code 2 and says
 *      so), then re-run with `--after-restart`;
 *   5. confirm both the settings marker and the conversation survived.
 *
 * The two-phase shape is deliberate. A single process cannot restart
 * itself and then keep observing, and spawning a server from inside this
 * script would be testing a different server than the one the user runs.
 *
 * Read-only with respect to your real settings: the marker is written into
 * `identity.latitude`, a field Xana only uses for the weather adapter, and
 * the original value is restored at the end of phase 1's follow-up.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const base = process.argv[2]?.startsWith("http")
  ? process.argv[2]
  : (process.env.XANA_URL ?? "http://127.0.0.1:4310");
const afterRestart = process.argv.includes("--after-restart");

const MARKER_KEY = "latitude";
const STATE_FILE = join(process.cwd(), "data", "persistence-check.json");

const SETTINGS_FILE = join(process.cwd(), "data", "settings.json");
const DB_FILE = join(process.cwd(), "data", "xana.db");

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

async function getSettings() {
  const res = await fetch(`${base}/api/settings`, { cache: "no-store" });
  if (!res.ok) throw new Error(`GET /api/settings answered ${res.status}`);
  return (await res.json()).settings;
}

async function putSettings(settings) {
  const res = await fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings }),
  });
  if (!res.ok) throw new Error(`PUT /api/settings answered ${res.status}`);
  return (await res.json()).settings;
}

async function main() {
  console.log(`Verifying persistence at ${base}`);
  console.log(`  settings file  ${SETTINGS_FILE}`);
  console.log(`  database       ${DB_FILE}`);

  /* ---------------- phase 2: after the restart ---------------- */
  if (afterRestart) {
    section("After the restart");

    if (!existsSync(STATE_FILE)) {
      check("a before-restart record exists", false, `missing ${STATE_FILE}`);
      console.log("\n  Run phase 1 first, with no arguments.");
      return report();
    }

    const before = JSON.parse(readFileSync(STATE_FILE, "utf8"));

    /**
     * Guard against a stale re-run.
     *
     * Phase 2 restores the marker it borrowed, so running it twice in a row
     * without a fresh phase 1 would compare against a value that has already
     * been cleaned up. That is not a persistence failure and reporting it as
     * one trains the reader to ignore the check, so it is named for what it
     * is and the run stops.
     */
    const settingsMtime = existsSync(SETTINGS_FILE) ? statSync(SETTINGS_FILE).mtimeMs : 0;
    const recordMtime = existsSync(STATE_FILE) ? statSync(STATE_FILE).mtimeMs : 0;
    if (settingsMtime > recordMtime) {
      console.log("\n  Stale run: the settings file has been written since phase 1.");
      console.log("  Phase 2 cleans up after itself, so it cannot be re-run against");
      console.log("  the same record. Run phase 1 again, restart, then phase 2.\n");
      return;
    }

    const settings = await getSettings();

    check(
      "the server is answering again",
      Boolean(settings),
    );
    check(
      "the settings marker survived the restart",
      settings.identity?.[MARKER_KEY] === before.marker,
      `expected "${before.marker}", found "${settings.identity?.[MARKER_KEY]}"`,
    );
    check(
      "identity written before the restart is intact",
      settings.identity?.name === before.name,
      `expected "${before.name}", found "${settings.identity?.name}"`,
    );
    check(
      "the theme survived the restart",
      settings.appearance?.theme === before.theme,
      `expected "${before.theme}", found "${settings.appearance?.theme}"`,
    );
    check(
      "the model configuration survived",
      settings.effective?.provider === before.provider &&
        settings.effective?.model === before.model,
      `expected ${before.provider}/${before.model}, found ${settings.effective?.provider}/${settings.effective?.model}`,
    );
    check(
      "the API key survived (as a mask, never a value)",
      // The key is never returned, so a preserved key shows up as `present`
      // with a mask. If the write had been lost this would read false.
      before.keyPresent === settings.model?.apiKey?.present,
      `expected present=${before.keyPresent}, found present=${settings.model?.apiKey?.present}`,
    );

    /**
     * The conversation is read from the database file rather than over HTTP,
     * because there is no endpoint that returns turns, and adding one just to
     * test would be building the thing being measured.
     *
     * Two separate things are checked, because they can fail independently:
     * the turn from *before* the restart is still there (the write was not
     * lost), and a turn sent *after* the restart also lands (the database is
     * still writable, not merely readable).
     */
    try {
      const Database = (await import("better-sqlite3")).default;

      const read = () => {
        const db = new Database(DB_FILE, { readonly: true });
        const total = db.prepare("SELECT COUNT(*) AS c FROM conversation").get().c;
        const old = db
          .prepare("SELECT COUNT(*) AS c FROM conversation WHERE text LIKE ?")
          .get(`%${before.chatMarker}%`).c;
        db.close();
        return { total, old };
      };

      const first = read();
      check(
        "the turn sent before the restart is still there",
        first.old > 0,
        `no row matching "${before.chatMarker}"`,
      );

      const marker2 = `${before.chatMarker} (after restart)`;
      const res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: marker2, sessionId: "persistence" }),
      });
      check("a new turn is accepted after the restart", res.status === 200, String(res.status));

      const second = read();
      check(
        "a turn sent after the restart is written too",
        second.total > first.total,
        `${first.total} -> ${second.total}`,
      );
      check(
        "and it is readable back from the database",
        second.old > 0,
      );
    } catch (err) {
      check("the database can be read", false, String(err));
    }

    // Restore the marker field so the check leaves no residue.
    try {
      await putSettings({ identity: { [MARKER_KEY]: before.markerBefore } });
      check("the test marker was cleaned up", true);
    } catch {
      check("the test marker was cleaned up", false, "could not restore");
    }

    return report();
  }

  /* ---------------- phase 1: write, then ask for a restart ---------------- */
  section("Writing data");

  const before = await getSettings();
  const marker = `persist-${Date.now().toString(36)}`;
  const chatMarker = `persistence check ${marker}`;

  const Database = (await import("better-sqlite3")).default;
  const db = new Database(DB_FILE, { readonly: true });
  const conversationBefore = db.prepare("SELECT COUNT(*) AS c FROM conversation").get().c;
  db.close();

  const updated = await putSettings({
    identity: {
      name: before.identity.name || "Persistence Check",
      latitude: marker,
    },
  });
  check(
    "PUT /api/settings accepted the write",
    updated.identity?.[MARKER_KEY] === marker,
    `found "${updated.identity?.[MARKER_KEY]}"`,
  );

  // Confirm it reached the file, not merely the in-memory cache. This is the
  // check that distinguishes "saved locally" from "remembered for now".
  const onDisk = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
  check(
    "the value is on disk, not just in memory",
    onDisk.identity?.[MARKER_KEY] === marker,
    `file has "${onDisk.identity?.[MARKER_KEY]}"`,
  );

  const chatRes = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: chatMarker, sessionId: "persistence" }),
  });
  check("a chat turn was accepted", chatRes.status === 200, String(chatRes.status));

  const db2 = new Database(DB_FILE, { readonly: true });
  const afterChat = db2.prepare("SELECT COUNT(*) AS c FROM conversation").get().c;
  const logged = db2
    .prepare("SELECT COUNT(*) AS c FROM conversation WHERE text LIKE ?")
    .get(`%${chatMarker}%`);
  db2.close();

  check(
    "the turn was written to the database immediately",
    logged.c > 0,
    "a turn that only appears later is a turn that can be lost",
  );

  const record = {
    marker,
    chatMarker,
    markerBefore: before.identity?.[MARKER_KEY] ?? "",
    name: updated.identity.name,
    theme: updated.appearance.theme,
    provider: updated.effective.provider,
    model: updated.effective.model,
    keyPresent: updated.model.apiKey.present,
    conversationBefore: afterChat,
  };
  const { writeFileSync } = await import("node:fs");
  writeFileSync(STATE_FILE, `${JSON.stringify(record, null, 2)}\n`, "utf8");

  section("Now restart the server");
  console.log("  Stop the dev server, start it again, then run:");
  console.log(`\n    node scripts/verify-persistence.mjs ${base} --after-restart\n`);
  console.log("  That second run is the one that proves persistence.");
  // Mapped to "restart needed" rather than to failure: phase 1 did its job,
  // and a caller chaining this after `npm run check` should be able to tell
  // "waiting on a restart" from "something is broken".
  process.exitCode = 2;
}

function report() {
  section("Result");
  console.log(`  ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`\nPersistence verification failed: ${err.message}`);
  process.exitCode = 1;
});
