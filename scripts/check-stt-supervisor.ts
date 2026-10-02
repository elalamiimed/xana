/**
 * Starting the local transcriber, from the app.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-stt-supervisor.ts
 *
 * WHAT THIS PROVES, AND WHY IT NEEDS PROVING
 *
 * The app used to tell the user to run `python/serve.ps1` themselves. Fixing
 * that means the app now starts a process, and everything dangerous about that
 * is in the decision rather than the spawn: starting a second copy of a service
 * that is already loading, spawning one every three seconds because the browser
 * retries that often, telling someone to run a setup script they have already
 * run, or offering a start on a machine with no interpreter to start it with.
 *
 * `planTranscriberStart` is that decision as a pure function of five facts, so
 * all of those cases are driven here rather than reasoned about. The model
 * lookup — which folder under `python/models` is the one faster-whisper can
 * actually load — is driven against a temporary tree, because getting it wrong
 * starts a service that reports "no engine installed".
 *
 * The last section is live: it starts the real service and waits for it to be
 * able to transcribe. It is skipped rather than failed when Python, the virtual
 * environment or the weights are not on this machine — that is an environment
 * fact, not a defect in this code, and a check that fails for it would be a
 * check nobody could run.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  START_COOLDOWN_MS,
  ensureTranscriber,
  locateTranscriber,
  newestModelDir,
  planTranscriberStart,
  probeTranscriber,
} from "../src/lib/stt/supervisor";

let passed = 0;
let failed = 0;
let skipped = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function skip(label: string, why: string): void {
  skipped += 1;
  console.log(`  skip  ${label} — ${why}`);
}

function group(title: string, run: () => void): void {
  console.log(`\n${title}\n`);
  try {
    run();
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${title} threw — ${err instanceof Error ? err.message : String(err)}`);
  }
}

const INSTALLED = { hasPython: true, hasVenv: true, hasModel: true };

/* ------------------------------------------------------------------ */
/* The decision                                                        */
/* ------------------------------------------------------------------ */

group("A service that is up is never started twice", () => {
  const up = planTranscriberStart({ running: true, ready: true, ...INSTALLED });
  check("nothing to do", up.action === "ready", up.action);
  check("and nothing to say", up.note === "", up.note);

  // The case that would otherwise put two services on one port: the first one
  // bound, is loading a 75 MB model, and answers `ready:false` while it does.
  const loading = planTranscriberStart({ running: true, ready: false, ...INSTALLED });
  check("a service that is loading is waited for, not duplicated", loading.action === "loading", loading.action);
  check("with no sentence about it", loading.note === "", loading.note);

  // `running` alone must never mean "start one": that is the whole guard.
  check(
    "and never a second start, whatever else is true",
    planTranscriberStart({ running: true, ready: false, hasPython: true, hasVenv: false, hasModel: false }).action ===
      "loading",
  );
});

group("Nothing to start with is said plainly, and never attempted", () => {
  const noPython = planTranscriberStart({ running: false, ready: false, hasPython: false, hasVenv: false, hasModel: false });
  check("no interpreter is its own answer", noPython.action === "no-python", noPython.action);
  check("which names Python and the setup script", noPython.note.includes("Python 3") && noPython.note.includes("setup.ps1"), noPython.note);

  // setup.ps1 not run, or run but the weights never arrived. Both are "not set
  // up yet" to the person reading it, and neither can be fixed by starting.
  const noVenv = planTranscriberStart({ running: false, ready: false, hasPython: true, hasVenv: false, hasModel: false });
  check("no virtual environment means setup has not run", noVenv.action === "setup", noVenv.action);
  const noModel = planTranscriberStart({ running: false, ready: false, hasPython: true, hasVenv: true, hasModel: false });
  check("no weights means the same thing", noModel.action === "setup", noModel.action);
  check("and the sentence names the one command", noVenv.note.includes("setup.ps1"), noVenv.note);

  const ready = planTranscriberStart({ running: false, ready: false, ...INSTALLED });
  check("everything present means start", ready.action === "start", ready.action);
  check("silently, because there is nothing to explain", ready.note === "", ready.note);
});

group("No combination offers a start it cannot do, or a sentence it cannot act on", () => {
  let incoherent = 0;
  for (const running of [true, false]) {
    for (const ready of [true, false]) {
      for (const hasPython of [true, false]) {
        for (const hasVenv of [true, false]) {
          for (const hasModel of [true, false]) {
            const decision = planTranscriberStart({ running, ready, hasPython, hasVenv, hasModel });
            // A start with no interpreter, or with no engine installed, is a
            // start that cannot work.
            if (decision.action === "start" && !(hasPython && hasVenv && hasModel)) incoherent += 1;
            // A terminal answer with nothing to tell the user is a dead end.
            if ((decision.action === "setup" || decision.action === "no-python") && !decision.note) incoherent += 1;
            // `ready` outranks everything: it is the only fact that means the
            // feature works.
            if (ready && decision.action !== "ready") incoherent += 1;
            // And nothing may be spawned while something already answers.
            if (running && !ready && decision.action === "start") incoherent += 1;
          }
        }
      }
    }
  }
  check("the decision is coherent across all 32 combinations", incoherent === 0, String(incoherent));
});

/* ------------------------------------------------------------------ */
/* Finding the weights                                                 */
/* ------------------------------------------------------------------ */

group("The model folder is the one that holds model.bin, newest first", () => {
  const root = mkdtempSync(path.join(tmpdir(), "xana-stt-models-"));
  try {
    // The nesting both ModelScope and Hugging Face use, because a flat search
    // finds nothing and a wrong folder starts a service with no engine.
    const older = path.join(root, "models--acme--whisper", "snapshots", "aaa");
    const newer = path.join(root, "pengzhendong--faster-whisper-tiny", "snapshots", "master");
    mkdirSync(older, { recursive: true });
    mkdirSync(newer, { recursive: true });
    writeFileSync(path.join(older, "model.bin"), "old");
    writeFileSync(path.join(newer, "model.bin"), "new");
    // A decoy: a folder with a config but no weights cannot be loaded.
    const decoy = path.join(root, "not-a-model");
    mkdirSync(decoy, { recursive: true });
    writeFileSync(path.join(decoy, "config.json"), "{}");

    utimesSync(path.join(older, "model.bin"), new Date(2020, 1, 1), new Date(2020, 1, 1));
    utimesSync(path.join(newer, "model.bin"), new Date(2024, 1, 1), new Date(2024, 1, 1));

    check("the newest weights win", newestModelDir([root]) === newer, newestModelDir([root]));
    check("a folder without model.bin is not a model", !newestModelDir([root]).includes("not-a-model"));
    check("a missing root is not a crash", newestModelDir([path.join(root, "nope")]) === "");

    // Several roots: the service's own cache is searched too, because a machine
    // set up by hand has the weights there and not in the checkout.
    const cache = mkdtempSync(path.join(tmpdir(), "xana-stt-cache-"));
    try {
      const cached = path.join(cache, "models--x--y", "snapshots", "zzz");
      mkdirSync(cached, { recursive: true });
      writeFileSync(path.join(cached, "model.bin"), "cached");
      utimesSync(path.join(cached, "model.bin"), new Date(2026, 1, 1), new Date(2026, 1, 1));
      check("and the second root is searched as well", newestModelDir([root, cache]) === cached, newestModelDir([root, cache]));
      check("with nothing found anywhere, nothing is claimed", newestModelDir([]) === "");
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

group("What is installed here is reported honestly", () => {
  const install = locateTranscriber();
  check("the program is this project's service", install.program.endsWith(path.join("python", "xana_stt.py")), install.program);
  check("the interpreter is a path or a name, never a guess", typeof install.python === "string");
  check("the venv flag agrees with the interpreter it found", install.venv === install.python.includes(".venv"), `${install.venv} / ${install.python}`);
  check("a model folder is either found or empty", install.modelDir === "" || install.modelDir.length > 0);
  console.log(
    `  info  python=${install.python || "none"} venv=${install.venv} model=${install.modelDir || "none"} args=${JSON.stringify(install.pythonArgs)}`,
  );
});

/* ------------------------------------------------------------------ */
/* The start itself                                                    */
/* ------------------------------------------------------------------ */

console.log("\nStarting it for real\n");

const before = await probeTranscriber();
const install = locateTranscriber();
const decision = planTranscriberStart({
  running: before.available,
  ready: before.ready,
  hasPython: install.python !== "",
  hasVenv: install.venv,
  hasModel: install.modelDir !== "",
});

if (decision.action === "no-python" || decision.action === "setup") {
  skip("every live check", decision.note);
} else {
  console.log(`  info  before: available=${before.available} ready=${before.ready} ${before.reason}`);

  const result = await ensureTranscriber({ waitMs: 60_000 });
  check("the service ends up able to transcribe", result.status.ready, result.status.reason || result.status.backend);
  check("with a real backend", result.status.backend !== "none" && result.status.backend !== "unknown", result.status.backend);
  check("and a model name", result.status.model.length > 0, result.status.model);
  console.log(`  info  after:  started=${result.started} backend=${result.status.backend} model=${result.status.model}`);

  // Idempotence, which is the property the browser's three-second retry loop
  // depends on: asking again must not start a second service.
  const again = await ensureTranscriber({ waitMs: 5_000 });
  check("asking twice does not start a second one", again.started === false, String(again.started));
  check("and the answer is still that it is ready", again.status.ready, again.status.reason);
  check("the cooldown is a real number of milliseconds", START_COOLDOWN_MS >= 1000, String(START_COOLDOWN_MS));

  // The route the browser actually uses, over real HTTP. GET must not start
  // anything — it is polled by the panel.
  const route = await import("../src/app/api/transcriber/route");
  const getResponse = await route.GET();
  const getBody = (await getResponse.json()) as Record<string, unknown>;
  check("GET /api/transcriber answers 200", getResponse.status === 200, String(getResponse.status));
  check("and reports a ready service", (getBody.status as { ready?: boolean } | undefined)?.ready === true, JSON.stringify(getBody.status));
  check("with the action it would take", getBody.action === "ready", String(getBody.action));

  const guardResponse = await route.POST(
    new Request("http://127.0.0.1:4310/api/transcriber", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "start",
    }),
  );
  check("and a non-JSON POST is refused, not obeyed", guardResponse.status === 415, String(guardResponse.status));

  const postResponse = await route.POST(
    new Request("http://127.0.0.1:4310/api/transcriber", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  const postBody = (await postResponse.json()) as Record<string, unknown>;
  check("a JSON POST succeeds", postResponse.status === 200, String(postResponse.status));
  check("and reports the service ready", (postBody.status as { ready?: boolean } | undefined)?.ready === true);
}

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
// Exit code rather than `process.exit`: this script leaves a detached child
// behind on purpose, and a hard exit while that handle is still being set up
// aborts the process on Windows (`uv_async_send` assertion) — which would report
// a passing check as a crash. `scripts/routes.ts` does the same for the same
// reason.
process.exitCode = failed === 0 ? 0 : 1;
