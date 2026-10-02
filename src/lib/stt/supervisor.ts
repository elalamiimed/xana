/**
 * Starting the local transcriber, from the app rather than from the user.
 *
 * THE COMPLAINT THIS ANSWERS
 *
 * The app used to tell the user to run `python/serve.ps1` themselves — "Waiting
 * for the local transcriber. Start it with python/serve.ps1 — this reconnects on
 * its own." The second half was true and the first half was an abdication: the
 * user had already chosen "transcribe on this machine" in Settings, so the
 * service that choice depends on is the app's dependency, not the user's chore.
 * A feature that works only for someone who read the README is not finished.
 *
 * So the app starts it. Three things make that safe rather than clever:
 *
 *   - **It is idempotent.** Everything begins with a `/health` probe on loopback.
 *     A service that is up is never started twice, and one that is up but still
 *     loading its model is waited for, not duplicated.
 *   - **It is rate-limited.** A start is remembered for `START_COOLDOWN_MS`, so
 *     the browser — which retries every three seconds — cannot turn a broken
 *     install into a process storm.
 *   - **It never blocks the app.** Nothing here is on a request path the user
 *     is waiting on, and every failure is a sentence rather than a throw.
 *
 * WHY THE INTERPRETER AND THE MODEL ARE FOUND HERE TOO
 *
 * `serve.ps1` does the same two lookups for a human at a terminal: prefer
 * `python/.venv` (where `setup.ps1` put faster-whisper), and hand the service the
 * newest downloaded `model.bin` as `XANA_STT_MODEL`, because neither has a name
 * faster-whisper would guess. This is that logic in the language the app is
 * written in. Without it, a completely correct install starts a service that
 * reports "no engine installed", which reads as a broken install.
 *
 * SERVER ONLY. It spawns processes and reads the filesystem; it must never be
 * imported by a client component.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/* ================================================================== */
/* Where everything is                                                */
/* ================================================================== */

/** Where the service listens. Loopback only, like the service itself. */
export const TRANSCRIBER_PORT = Number(process.env.XANA_STT_PORT ?? 4319);
export const TRANSCRIBER_BASE = `http://127.0.0.1:${TRANSCRIBER_PORT}`;

const PYTHON_DIR = path.join(process.cwd(), "python");
const PROGRAM = path.join(PYTHON_DIR, "xana_stt.py");

/** A start is not attempted twice inside this window. See the module note. */
export const START_COOLDOWN_MS = 30_000;

/* ================================================================== */
/* Probing the service                                                */
/* ================================================================== */

export interface TranscriberStatus {
  /** True when something answered on the port. */
  readonly available: boolean;
  /** True when it can actually transcribe — the model is loaded. */
  readonly ready: boolean;
  readonly backend: string;
  readonly model: string;
  /** Why it is not ready, in the service's own words. */
  readonly reason: string;
}

const NOT_RUNNING: TranscriberStatus = {
  available: false,
  ready: false,
  backend: "none",
  model: "",
  reason: "The local transcriber is not running.",
};

/**
 * Ask the service how it is, without starting anything.
 *
 * A short timeout because this runs on paths where a user is waiting, and a hung
 * probe must not become a hung app. A service that is still loading its model
 * answers immediately with `ready:false` — that distinction is what stops this
 * module from starting a second copy of something that is already coming up.
 */
export async function probeTranscriber(timeoutMs = 1500): Promise<TranscriberStatus> {
  try {
    const response = await fetch(`${TRANSCRIBER_BASE}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return NOT_RUNNING;
    const body = (await response.json()) as Partial<TranscriberStatus>;
    return {
      available: true,
      ready: body.ready === true,
      backend: typeof body.backend === "string" ? body.backend : "unknown",
      model: typeof body.model === "string" ? body.model : "",
      reason: typeof body.reason === "string" ? body.reason : "",
    };
  } catch {
    // Not running, not reachable, or too slow to answer. To a caller these are
    // one fact: nothing is transcribing right now.
    return NOT_RUNNING;
  }
}

/* ================================================================== */
/* Finding the pieces                                                 */
/* ================================================================== */

export interface TranscriberInstall {
  /** The interpreter to run, or "" when this machine has none. */
  readonly python: string;
  /** Arguments that come before the program, for the `py -3` launcher. */
  readonly pythonArgs: readonly string[];
  /** The service's own file. */
  readonly program: string;
  /** The folder holding `model.bin`, or "" when no weights are on disk. */
  readonly modelDir: string;
  /** True when `python/.venv` exists — i.e. `setup.ps1` has been run. */
  readonly venv: boolean;
}

/** The virtual environment's interpreter, wherever this platform puts it. */
function venvPython(): string {
  const candidates = [
    path.join(PYTHON_DIR, ".venv", "Scripts", "python.exe"),
    path.join(PYTHON_DIR, ".venv", "bin", "python"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? "";
}

/**
 * A `py`/`python`/`python3` on PATH.
 *
 * Returned as a name, not a resolved path: Windows' `py` launcher has to be run
 * as `py -3`, and both the launcher and the plain names are found by the OS at
 * spawn time. Only the venv is resolved here, because preferring it is the whole
 * point of looking.
 */
function pathPython(env: NodeJS.ProcessEnv = process.env): { python: string; args: readonly string[] } {
  const names = process.platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"];
  const dirs = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const name of names) {
    const suffixes = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
    for (const dir of dirs) {
      for (const suffix of suffixes) {
        if (existsSync(path.join(dir, `${name}${suffix}`))) {
          return { python: name, args: name === "py" ? ["-3"] : [] };
        }
      }
    }
  }
  return { python: "", args: [] };
}

/**
 * The newest downloaded model, by the same rule `serve.ps1` uses.
 *
 * A folder containing `model.bin` is the only thing faster-whisper can load, and
 * both ModelScope and Hugging Face nest it several levels down — so this walks,
 * rather than guessing a layout. Newest wins, because a user who has downloaded
 * a second model meant to use it.
 *
 * Both locations are searched: `python/models`, where `setup.ps1` puts them, and
 * the service's own cache directory, because `xana_stt.py` defaults there and a
 * machine set up by hand will have them in neither the same place nor the same
 * shape.
 */
export function newestModelDir(roots: readonly string[]): string {
  let newest = "";
  let newestAt = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let info;
      try {
        info = statSync(full);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (entry !== "model.bin") continue;
      if (info.mtimeMs >= newestAt) {
        newestAt = info.mtimeMs;
        newest = dir;
      }
    }
  };

  for (const root of roots) walk(root, 0);
  return newest;
}

/** The model cache `xana_stt.py` uses when `XANA_STT_MODEL_DIR` is unset. */
function serviceModelCache(): string {
  const override = process.env.XANA_STT_MODEL_DIR;
  if (override) return override;
  const local = process.env.LOCALAPPDATA;
  if (process.platform === "win32" && local) return path.join(local, "xana-stt", "models");
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return home ? path.join(home, ".cache", "xana-stt", "models") : "";
}

/**
 * Everything needed to start the service, or the absence that explains why not.
 *
 * Read-only and synchronous: it answers "is this installed", which is a fact
 * about the filesystem and not about the service.
 */
export function locateTranscriber(): TranscriberInstall {
  const venv = venvPython();
  const fallback = venv ? { python: "", args: [] } : pathPython();
  const cache = serviceModelCache();
  return {
    python: venv || fallback.python,
    pythonArgs: venv ? [] : fallback.args,
    program: PROGRAM,
    modelDir: newestModelDir([path.join(PYTHON_DIR, "models"), ...(cache ? [cache] : [])]),
    venv: venv !== "",
  };
}

/* ================================================================== */
/* What to do about it                                                */
/* ================================================================== */

export type StartAction =
  /** Nothing to do: it is up and usable. */
  | "ready"
  /** Nothing to do: it is up and still loading its model. */
  | "loading"
  /** Start it. */
  | "start"
  /** It has never been set up. `python\setup.ps1` is the fix. */
  | "setup"
  /** There is no Python on this machine at all. */
  | "no-python";

export interface StartDecision {
  readonly action: StartAction;
  /** What to tell the user. Empty when there is nothing worth saying. */
  readonly note: string;
}

/**
 * The decision, as a pure function of five facts.
 *
 * Pure because it is the part worth testing and the part that is easy to get
 * wrong in ways only a user would notice: starting a second copy of a service
 * that is loading, or telling someone to run a setup script they have already
 * run, or offering a start that cannot possibly work because there is no
 * interpreter to start it with.
 */
export function planTranscriberStart(facts: {
  /** Something answered on the port. */
  running: boolean;
  /** And it can transcribe. */
  ready: boolean;
  hasPython: boolean;
  hasVenv: boolean;
  hasModel: boolean;
}): StartDecision {
  if (facts.ready) return { action: "ready", note: "" };
  if (facts.running) {
    // Up and loading. Starting another would lose the port to whichever bound
    // first and leave the loser as a process nobody owns.
    return { action: "loading", note: "" };
  }
  if (!facts.hasPython) {
    return {
      action: "no-python",
      note: "The local transcriber needs Python 3, which is not installed on this machine. Install it from python.org, run python\\setup.ps1 once, then press the mic again — or switch transcription back to the browser in Settings → Voice.",
    };
  }
  if (!facts.hasVenv || !facts.hasModel) {
    return {
      action: "setup",
      note: "The local transcriber is not set up yet. Run python\\setup.ps1 once — it installs the engine and downloads the model — then press the mic again. Until then, the browser's own speech service works in Settings → Voice.",
    };
  }
  return { action: "start", note: "" };
}

/* ================================================================== */
/* Doing it                                                           */
/* ================================================================== */

export interface EnsureResult {
  readonly action: StartAction;
  /** True when this call is the one that spawned the service. */
  readonly started: boolean;
  readonly status: TranscriberStatus;
  /** What to tell the user, in words a person can act on. */
  readonly note: string;
}

/** Where the service's own output goes, so a failure is readable afterwards. */
const LOG_PATH = path.join(process.cwd(), "data", "stt.log");

/** The start already in flight, so two callers cannot spawn two services. */
let inFlight: Promise<EnsureResult> | null = null;
let lastAttemptAt = 0;

/**
 * Spawn the service and let go of it.
 *
 * Detached and unref'd, deliberately: the transcriber outlives the server that
 * started it. Restarting the app — which happens constantly while it is being
 * worked on — must not reload a 75 MB model, and the next boot's health probe
 * finds the running service and leaves it alone.
 *
 * The output goes to `data/stt.log` through an inherited file handle rather than
 * a pipe, because a pipe would have to be drained by this process for as long as
 * the service lives; a file is also the thing a user can read afterwards.
 */
function spawnTranscriber(install: TranscriberInstall): Promise<boolean> {
  let log: number;
  try {
    mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    log = openSync(LOG_PATH, "a");
  } catch {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    let child;
    try {
      child = spawn(install.python, [...install.pythonArgs, install.program, "--quiet"], {
        cwd: PYTHON_DIR,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log, log],
        env: {
          ...process.env,
          // The one thing the service cannot work out for itself. See the module
          // note, and `serve.ps1`, which does the same lookup for a human.
          ...(install.modelDir ? { XANA_STT_MODEL: install.modelDir } : {}),
          XANA_STT_PORT: String(TRANSCRIBER_PORT),
        },
      });
    } catch {
      // No interpreter, no permission, no disk.
      closeSync(log);
      resolve(false);
      return;
    }

    // The parent's copy of the log handle is not needed: the child has its own,
    // and keeping it open would leak a descriptor per start.
    closeSync(log);

    // `spawn` reports a missing interpreter asynchronously, so "started" has to
    // wait for the child to actually exist rather than for the call to return.
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
    child.once("error", () => resolve(false));
  });
}

/** Wait for the service to answer AND to be able to transcribe. */
async function waitForReady(waitMs: number): Promise<TranscriberStatus> {
  const deadline = Date.now() + waitMs;
  let status = await probeTranscriber();
  while (!status.ready && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    status = await probeTranscriber();
  }
  return status;
}

/**
 * Make sure the local transcriber is running, and report what happened.
 *
 * Idempotent, rate-limited and safe to call from anywhere on the server — the
 * app's boot, the API route, a test. Callers get a sentence rather than an
 * exception, because every failure here is something the user can act on.
 */
export async function ensureTranscriber(
  options: { waitMs?: number; now?: number } = {},
): Promise<EnsureResult> {
  if (inFlight) return inFlight;
  inFlight = (async (): Promise<EnsureResult> => {
    const now = options.now ?? Date.now();
    let status = await probeTranscriber();
    let install = locateTranscriber();
    let decision = planTranscriberStart({
      running: status.available,
      ready: status.ready,
      hasPython: install.python !== "",
      hasVenv: install.venv,
      hasModel: install.modelDir !== "",
    });

    // A service that is up and loading is waited for, not replaced.
    if (decision.action === "ready" || decision.action === "loading") {
      if (decision.action === "loading") status = await waitForReady(options.waitMs ?? 20_000);
      return { action: decision.action, started: false, status, note: "" };
    }

    if (decision.action !== "start") {
      return { action: decision.action, started: false, status, note: decision.note };
    }

    // Rate limit. The browser retries every three seconds; without this, an
    // install that cannot start would be spawned on every one of those retries.
    if (lastAttemptAt && now - lastAttemptAt < START_COOLDOWN_MS) {
      return {
        action: "start",
        started: false,
        status,
        note: "The local transcriber was started a moment ago and is still coming up. Give it a few seconds, or check it in Settings → Voice.",
      };
    }

    lastAttemptAt = now;
    const spawned = await spawnTranscriber(install);
    status = spawned ? await waitForReady(options.waitMs ?? 20_000) : status;
    install = locateTranscriber();

    if (status.ready) {
      return { action: "ready", started: spawned, status, note: "" };
    }

    // Started but not usable. The two causes worth naming are the service
    // failing to bind or load (readable in data/stt.log) and a start that never
    // happened at all.
    decision = planTranscriberStart({
      running: status.available,
      ready: status.ready,
      hasPython: install.python !== "",
      hasVenv: install.venv,
      hasModel: install.modelDir !== "",
    });
    return {
      action: decision.action === "start" ? "start" : decision.action,
      started: spawned,
      status,
      note: status.available
        ? `The local transcriber started but is not ready: ${status.reason} Its log is in data/stt.log.`
        : "The local transcriber did not start. Its log is in data/stt.log — and python\\setup.ps1 may need to be run once.",
    };
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}
