/**
 * Save everything Xana knows into one folder you can move.
 *
 * WHAT "LOCAL DATABASE SAVING" ACTUALLY REQUIRES
 *
 * Xana's state is three things, and a backup that takes two of them is a backup
 * that quietly loses something:
 *
 *   1. `xana.db` — every task, event, memory, habit, goal, health reading and
 *      utterance. This is the one people remember to copy.
 *   2. `settings.json` — which connections are allowed, the keys you pasted,
 *      the theme, the voice. This is the one people forget, and losing it means
 *      re-pasting every key and re-granting every permission.
 *   3. Nothing else. `-wal` and `-shm` are not data; they are the working files
 *      of an open connection, and copying them by hand is how a "backup" ends
 *      up inconsistent with the database beside it.
 *
 * THE MISTAKE THIS AVOIDS
 *
 * The obvious backup is `copy data\xana.db somewhere`. That is wrong twice over
 * while Xana is running. A file copy of a database mid-write can catch it
 * half-updated, and — because this app runs in WAL mode — a copy of `xana.db`
 * alone misses every write still sitting in the write-ahead log. That is not a
 * theoretical hazard here: this project's own `data/` directory held a 2.9 MB
 * log beside a 320 KB database, so a file copy would have captured roughly a
 * tenth of the history and looked perfectly fine.
 *
 * So the database is copied through SQLite's Online Backup API (`db.backup()`),
 * which takes a read lock, copies page by page, and restarts if a writer changes
 * something underneath it. The result is a database as of one instant, taken
 * while the app is running, with no need to stop her first.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/backup.ts
 *   node --import ./scripts/ts-loader.mjs scripts/backup.ts --keep 20
 *   node --import ./scripts/ts-loader.mjs scripts/backup.ts --out D:\xana-backups
 *
 * Restoring is three steps, and the middle one is not optional:
 *
 *   1. stop Xana;
 *   2. **delete `data/xana.db-wal` and `data/xana.db-shm`**;
 *   3. copy `xana.db` and `settings.json` back into `data/`, and start her.
 *
 * Step 2 used to be missing from this file and from the README, which made the
 * documented restore actively dangerous. A `-wal` is not a scratch file that the
 * next open discards: it is a log SQLite *replays over whatever database it
 * finds*, so restoring a backup beside the log of the database being replaced
 * applies the newer writes to the older file and yields a database that is a
 * mixture of two moments — rows the backup never had, and rows it deliberately
 * does not contain — with a clean integrity check and no warning at all. Every
 * step here, including the one this paragraph is about, is written into the
 * snapshot's own `BACKUP.json` so the folder explains itself in six months.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { XanaStore, defaultDbPath } from "../src/lib/core/store";
import { settingsPath } from "../src/lib/settings/store";

const DEFAULT_KEEP = 10;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const keep = Math.max(1, Number(arg("keep") ?? DEFAULT_KEEP) || DEFAULT_KEEP);
const dbFile = defaultDbPath();
const settingsFile = settingsPath();
const dataDir = path.dirname(dbFile);
const outRoot = arg("out") ?? path.join(dataDir, "backups");

if (!existsSync(dbFile)) {
  console.error(`There is no database at ${dbFile} — nothing worth backing up yet.`);
  process.exit(1);
}

/** `xana-2026-10-01T13-45-02` — sortable, and legal on Windows. */
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const target = path.join(outRoot, `xana-${stamp}`);
mkdirSync(target, { recursive: true });

/* ---- 1. the database, through SQLite itself ------------------------ */

const store = new XanaStore(dbFile);
const before = store.counts();
const backupPath = path.join(target, "xana.db");
const result = await store.backupTo(backupPath);

if (!result.ok) {
  store.close();
  rmSync(target, { recursive: true, force: true });
  console.error(`The database could not be copied: ${result.error}`);
  process.exit(1);
}

/**
 * Read the copy back before declaring success.
 *
 * A backup that has never been opened is a file, not a backup. Opening it here
 * costs milliseconds and turns "the copy exists" into "the copy is a database
 * with the same rows in it" — and if the open fails, the folder is removed
 * rather than left behind looking like something you can rely on.
 */
let verified: Record<string, number> | undefined;
try {
  const check = new XanaStore(backupPath);
  verified = check.counts();
  check.close();
} catch (err) {
  store.close();
  rmSync(target, { recursive: true, force: true });
  console.error(`The copy was written but could not be opened: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

/* ---- 2. the settings, which are half the state -------------------- */

let settingsCopied = false;
if (existsSync(settingsFile)) {
  copyFileSync(settingsFile, path.join(target, "settings.json"));
  settingsCopied = true;
}

/* ---- 3. a note so the folder explains itself ---------------------- */

const summary = {
  savedAt: new Date().toISOString(),
  from: dataDir,
  database: { file: "xana.db", bytes: statSync(backupPath).size, rows: verified },
  settings: settingsCopied ? { file: "settings.json", bytes: statSync(path.join(target, "settings.json")).size } : "not present, so nothing to copy",
  restore: [
    "Stop Xana (Ctrl+C in the terminal running it).",
    "Delete xana.db-wal and xana.db-shm from the data/ directory. This is not optional: -wal is a log SQLite replays over the file it finds, so a leftover one applies the OLD database's newest writes on top of this backup and silently gives you a mixture of the two.",
    "Copy xana.db and settings.json from this folder into the data/ directory.",
    "Start her again with: npm run dev",
    "Nothing else is required. The -wal and -shm files are rebuilt on open — from the restored database, which is why they must not be there first.",
  ],
};

writeFileSync(path.join(target, "BACKUP.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
/* ---- 4. prune, so this can run on a schedule ---------------------- */

const siblings = existsSync(outRoot)
  ? readdirSync(outRoot)
      .filter((name) => name.startsWith("xana-") && statSync(path.join(outRoot, name)).isDirectory())
      .sort()
  : [];
const pruned = siblings.slice(0, Math.max(0, siblings.length - keep));
for (const name of pruned) rmSync(path.join(outRoot, name), { recursive: true, force: true });

/* ---- report ------------------------------------------------------- */

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
console.log(`\n  Saved to  ${target}`);
console.log(`  Database  ${mb(summary.database.bytes)} — ${Object.values(verified ?? {}).reduce((a, b) => a + b, 0)} rows across ${Object.keys(verified ?? {}).length} tables`);
console.log(`  Settings  ${settingsCopied ? "copied (keys and grants included)" : "none present"}`);
console.log(`  Kept      ${Math.min(siblings.length, keep)} of ${siblings.length} snapshot${siblings.length === 1 ? "" : "s"}${pruned.length ? `, pruned ${pruned.length}` : ""}`);
console.log(
  `\n  To restore: stop Xana, delete data/xana.db-wal and data/xana.db-shm, then copy\n  xana.db and settings.json into ${dataDir} and start her. Skipping the delete merges\n  this snapshot with the tail of the database you are replacing, and nothing says so.\n`,
);

// Told rather than assumed: a backup taken while a writer is mid-transaction is
// the case the Online Backup API exists to handle, but a reader should know
// whether there was one.
const changed = Object.entries(verified ?? {}).filter(([table, n]) => before[table] !== n);
if (changed.length > 0) {
  console.log(`  Rows moved while the copy ran (the copy is a consistent instant, not a mixture):`);
  for (const [table, n] of changed) console.log(`    ${table}: ${before[table]} -> ${n}`);
  console.log("");
}

store.close();
