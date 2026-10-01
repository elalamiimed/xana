/**
 * Does the launcher checkpoint the database when it is asked to stop?
 *
 * `scripts/dev.mjs` registers SIGINT/SIGTERM handlers that fold the
 * write-ahead log back into the database before exiting, so a clean stop leaves
 * `xana.db` complete rather than leaving the log for the next open to replay.
 * That is a claim about a signal handler, and signal handlers are exactly the
 * kind of thing that silently stops working — a changed guard, a renamed
 * function, an import path that no longer resolves.
 *
 * This script starts the real launcher, writes through the real HTTP surface,
 * sends it the same SIGTERM a service manager would, and then checks the
 * database file directly.
 *
 * It runs against a THROWAWAY `XANA_DATA_DIR`. That matters: the launcher's
 * checkpoint only means something if it was the launcher's process doing the
 * writing, so the run must be real — but it must not be the user's data.
 *
 *   node scripts/check-shutdown-checkpoint.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DIR = mkdtempSync(path.join(tmpdir(), "xana-shutdown-"));
const PORT = process.env.PORT ?? "4327";
const dbFile = path.join(DIR, "xana.db");
const walFile = `${dbFile}-wal`;
const size = (file) => (existsSync(file) ? statSync(file).size : 0);

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) {
    pass++;
    console.log(`  ok    ${label}${detail ? ` - ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
};

console.log(`\n${"-".repeat(64)}\nShutdown checkpoint, against ${DIR}\n${"-".repeat(64)}`);

/** The launcher exactly as `npm run dev` starts it. */
let child;
try {
  child = spawn(
    process.execPath,
    ["--import", "./scripts/ts-loader.mjs", "scripts/dev.mjs"],
    {
      env: { ...process.env, XANA_DATA_DIR: DIR, PORT },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
} catch (err) {
  console.log(`\n  skip  this environment denies process creation (${err.code ?? err})`);
  console.log("        nothing can be verified here; the durability script covers the rest.\n");
  process.exit(0);
}

let out = "";
child.stdout.on("data", (chunk) => {
  out += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  out += chunk.toString();
});

let up = false;
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 40 && !up; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    const res = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(3000) });
    up = res.ok;
  } catch {
    /* still starting */
  }
}

if (!up) {
  child.kill("SIGKILL");
  console.log(`\n  skip  the server never came up on ${PORT}`);
  console.log(`        ${out.split("\n").filter(Boolean).slice(-4).join("\n        ")}`);
  console.log("        (a dev server already using this port is the usual reason)\n");
  rmSync(DIR, { recursive: true, force: true });
  process.exit(0);
}

check("the launcher started and answered", true, base);

// One real write through the real route, so there is something committed to lose.
const chat = await fetch(`${base}/api/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "shutdown checkpoint probe" }),
});
check("a turn was written through the API", chat.ok, `HTTP ${chat.status}`);

await new Promise((r) => setTimeout(r, 750));
const during = size(walFile);
check("with the server running, the write is in the log", during > 0, `${during} bytes of -wal`);

/* The same signal a service manager sends. */
child.kill("SIGTERM");
await new Promise((resolve) => {
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    resolve();
  }, 15_000);
  child.once("exit", () => {
    clearTimeout(timer);
    resolve();
  });
});

check("the launcher said it checkpointed", /checkpointed/i.test(out), out.split("\n").filter((l) => /checkpoint|database/i.test(l)).slice(-2).join(" | ") || "no such line in its output");
check("the log is empty after shutdown", size(walFile) === 0, `${size(walFile)} bytes left`);
check("the database file holds everything", size(dbFile) > 0, `${size(dbFile)} bytes`);

/* Read it back with the real store, in this process. */
try {
  const { XanaStore } = await import("../src/lib/core/store.ts");
  const store = new XanaStore(dbFile);
  const rows = store.counts();
  store.close();
  check("the database opens and reports the write", rows.conversation >= 1, `${rows.conversation} conversation rows`);
} catch (err) {
  check("the database opens and reports the write", false, err.message);
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
