/**
 * Does a local write actually survive? Prove it, including across a close.
 *
 * WHAT THIS IS FOR
 *
 * "It saves to a local database" is a claim with three different meanings, and
 * only the last of them is worth anything:
 *
 *  1. the row is in SQLite's memory and will be written later, lost on a crash;
 *  2. the row is in a `-wal` file beside the database: survives a crash, *not*
 *     a naive copy of `xana.db`;
 *  3. the row is in `xana.db` itself: survives both.
 *
 * Xana was at (2) and never checkpointed, which is why her own data directory
 * held a 2.9 MB log beside a 320 KB database. The durable file was about a tenth
 * of what "your data" actually was, and a copy of it taken in that state looked
 * perfectly fine. Each assertion below says which of the three it is testing, so
 * a change that quietly drops back a level fails here with a sentence rather
 * than passing with a shrug.
 *
 * Every case runs in a temp `XANA_DATA_DIR`. The real `data/` is opened at the
 * end only to report its row counts.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-durability.ts
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { XanaStore, defaultDbPath } from "../src/lib/core/store";

const DIR = mkdtempSync(path.join(tmpdir(), "xana-durability-"));
process.env.XANA_DATA_DIR = DIR;

let pass = 0;
let fail = 0;
let skipped = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++;
    console.log(`  ok    ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

function skip(label: string, why: string): void {
  skipped++;
  console.log(`  skip  ${label}`);
  console.log(`        ${why}`);
}

function section(title: string): void {
  console.log(`\n${"-".repeat(64)}\n${title}\n${"-".repeat(64)}`);
}

const dbFile = path.join(DIR, "xana.db");
const walFile = `${dbFile}-wal`;
const size = (file: string) => (existsSync(file) ? statSync(file).size : 0);

/* ------------------------------------------------------------------ */

section("1. A scratch run is really scratch");

check("defaultDbPath() follows XANA_DATA_DIR", defaultDbPath().startsWith(DIR), defaultDbPath());

/* ------------------------------------------------------------------ */

section("2. A committed write reaches the database file on close");

{
  const store = new XanaStore(dbFile);
  store.createTask({ title: "durability probe: close", source: "probe" });
  check("the row is visible to the connection that wrote it", store.listTasks().length === 1);

  const during = size(walFile);
  check("while open, the write lives in the write-ahead log (meaning 2)", during > 0, `${during} bytes of -wal`);
  check("and is not yet in xana.db", size(dbFile) < during * 4, `db ${size(dbFile)} vs wal ${during}`);

  store.close();
  check("after close, the log is folded in and empty (meaning 3)", size(walFile) === 0, `${size(walFile)} bytes left`);
  check("and the database file grew to hold it", size(dbFile) > 0, `${size(dbFile)} bytes`);
}

/* ------------------------------------------------------------------ */

section("3. It survives a fresh connection opening the same file");

{
  const reopened = new XanaStore(dbFile);
  const titles = reopened.listTasks().map((t) => t.title);
  check("the row is still there after reopening", titles.includes("durability probe: close"), titles.join(", "));
  reopened.close();
}

/* ------------------------------------------------------------------ */

section("4. A checkpoint bounds the log instead of letting it grow");

{
  const store = new XanaStore(dbFile);
  // Enough writes to make the log worth measuring. Not a benchmark: the point
  // is that the log has a ceiling, not that a particular size is reached.
  for (let i = 0; i < 400; i++) {
    store.createTask({ title: `durability probe: bulk ${i}`, source: "probe" });
  }
  const before = size(walFile);
  const result = store.checkpoint();
  const after = size(walFile);
  check("the log had grown", before > 0, `${before} bytes`);
  check("checkpoint reports what it moved", result.log >= 0, JSON.stringify(result));
  check("TRUNCATE leaves the log at zero bytes", after === 0, `${before} -> ${after}`);

  /**
   * Counted with `counts()` rather than `listTasks()`: that reader is capped at
   * 200 rows by default, for the UI's sake, and the cap produced a false failure
   * the first time this script ran. The lesson is in the assertion, not hidden.
   */
  const straightFromFile = new XanaStore(dbFile);
  const rowsInFile = straightFromFile.counts().tasks;
  check("every row is in the database file, not only the log (meaning 3)", rowsInFile === 401, `${rowsInFile} rows in xana.db`);
  straightFromFile.close();
  store.close();
}

/* ------------------------------------------------------------------ */

section("5. A backup is one self-contained file, opened to prove it is a database");

{
  const store = new XanaStore(dbFile);
  const target = path.join(DIR, "backup", "copy.db");
  const result = await store.backupTo(target);
  check("the copy reports success", result.ok, result.error);
  check("the copy exists", existsSync(target));
  check("the copy has no write-ahead log of its own", size(`${target}-wal`) === 0, `${size(`${target}-wal`)} bytes`);

  const original = store.counts().tasks;
  let rows = -1;
  try {
    const copy = new XanaStore(target);
    rows = copy.counts().tasks;
    copy.close();
    check("the copy opens as a database", true, `${rows} rows`);
  } catch (err) {
    check("the copy opens as a database", false, err instanceof Error ? err.message : String(err));
  }
  check("the copy holds the same rows as the original", rows === original, `${rows} vs ${original}`);
  store.close();
}

/* ------------------------------------------------------------------ */

section("6. A killed process loses nothing that was committed");

/**
 * The case the whole design is for: a kill, no shutdown handler, no close.
 *
 * `synchronous = NORMAL` in WAL mode documents that a committed transaction
 * survives an *application* crash. Testing that needs a second process to kill,
 * and this sandbox denies process creation, so the case is skipped with its
 * reason rather than reported as a pass. It is worth keeping: on a normal
 * machine it is the assertion that would catch a change to `synchronous = OFF`.
 */
{
  const childFile = path.join(DIR, "killed.db");
  const storeUrl = new URL("../src/lib/core/store.ts", import.meta.url).href;
  const script = [
    `const { XanaStore } = await import(${JSON.stringify(storeUrl)});`,
    `const store = new XanaStore(${JSON.stringify(childFile)});`,
    `store.createTask({ title: "written before the kill", source: "probe" });`,
    `process.stdout.write("COMMITTED");`,
    `setInterval(() => {}, 1000);`,
  ].join("\n");

  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(process.execPath, ["--import", "./scripts/ts-loader.mjs", "--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    skip(
      "a row committed by a killed process is still there",
      code === "EPERM"
        ? "this environment denies process creation (spawn EPERM), so there is no second process to kill."
        : `could not start the child process: ${code ?? String(err)}`,
    );
  }

  if (child) {
    const committed = await new Promise<boolean>((resolve) => {
      let seen = "";
      const timer = setTimeout(() => resolve(false), 20_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        seen += chunk.toString();
        if (seen.includes("COMMITTED")) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      child.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    check("the child process committed a row", committed, committed ? undefined : "the child never reported a commit");

    // SIGKILL: no handler runs, no checkpoint, no close.
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));

    const survivor = new XanaStore(childFile);
    const titles = survivor.listTasks().map((t) => t.title);
    check("the committed row survived the kill", titles.includes("written before the kill"), titles.join(", ") || "no rows");
    survivor.close();
  }
}

/* ------------------------------------------------------------------ */

section("7. The real database is untouched by any of this");

{
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const realPath = path.resolve(here, "..", "data", "xana.db");
  if (!existsSync(realPath)) {
    skip("the real database opens", `no database at ${realPath} yet`);
  } else {
    const probe = new XanaStore(realPath);
    const counts = probe.counts();
    check("the real database opens and reports its tables", Object.keys(counts).length > 0, `${counts.tasks} tasks, ${counts.memories} memories`);
    check("the temp run never pointed at it", !probe.path.startsWith(DIR));
    probe.close();
  }
}

/* ------------------------------------------------------------------ */

rmSync(DIR, { recursive: true, force: true });

console.log(`\n${"-".repeat(64)}`);
console.log(`  ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ""}`);
console.log(`  temp directory removed: ${!existsSync(DIR)}`);
console.log(`${"-".repeat(64)}\n`);

if (fail > 0) process.exit(1);
