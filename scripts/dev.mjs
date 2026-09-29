/**
 * Dev server without the supervisor fork.
 *
 * Two problems this solves:
 *
 * 1. **The fork.** `next dev` is a thin supervisor: it parses CLI flags and
 *    then `child_process.fork()`s the real server. Sandboxes that deny process
 *    creation fail that fork with EPERM, so the app never starts even though
 *    nothing is wrong with it. Next exposes the server programmatically, so
 *    this file does the supervisor's job in-process. Same server, same HMR,
 *    same routes — one process.
 *
 * 2. **A taken port.** Something else on 4310 should not stop Xana starting.
 *    If the port is serving Xana already we say so; otherwise we move to the
 *    next free port rather than dying with EADDRINUSE.
 *
 *   npm run dev            # 4310, or the next free port
 *   PORT=4311 npm run dev  # a specific port
 *
 * To reach it from another device on the network:
 *   HOSTNAME=0.0.0.0 npm run dev
 */

import { createServer as createHttpServer } from "node:http";
import { createConnection } from "node:net";
import { createRequire } from "node:module";
import { watch } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const next = require("next");

const preferredPort = Number(process.env.PORT ?? 4310);
const hostname = process.env.HOSTNAME ?? "127.0.0.1";
const dev = process.env.NODE_ENV !== "production";

/** True when something is already accepting connections on this port. */
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: hostname });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(800, () => done(false));
  });
}

/** Is whatever holds this port an instance of Xana? */
async function isXana(port) {
  try {
    const res = await fetch(`http://${hostname}:${port}/api/state`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return typeof body?.partOfDay === "string" && typeof body?.energy?.band === "string";
  } catch {
    return false;
  }
}

async function choosePort() {
  if (!(await portInUse(preferredPort))) return preferredPort;

  if (await isXana(preferredPort)) {
    console.log(`\n  Xana is already running.\n`);
    console.log(`  Open     http://${hostname}:${preferredPort}`);
    console.log(`\n  Nothing to start. Ctrl+C here is safe.\n`);
    return null;
  }

  // Something else owns the port. Walk upward for a free one.
  for (let candidate = preferredPort + 1; candidate <= preferredPort + 20; candidate++) {
    if (!(await portInUse(candidate))) {
      console.log(`\n  Port ${preferredPort} is taken by another program.`);
      console.log(`  Starting Xana on ${candidate} instead.`);
      return candidate;
    }
  }

  console.error(`\n  Ports ${preferredPort}-${preferredPort + 20} are all in use.`);
  console.error(`  Free one, or pick a port:  PORT=5000 npm run dev\n`);
  process.exit(1);
}

const port = await choosePort();
if (port === null) process.exit(0);

const app = next({ dev, dir: process.cwd(), hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

const server = createHttpServer((req, res) => {
  // Two-argument form: Next builds the URL itself. Passing a parsed query
  // object instead routes through its legacy path and trips a deprecation
  // warning on `url.parse()`.
  handle(req, res);
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`\n  Port ${port} was taken while starting. Try:  PORT=${port + 1} npm run dev\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, hostname, () => {
  console.log(`\n  Xana is awake.\n`);
  console.log(`  Open     http://${hostname}:${port}`);
  console.log(`  Mode     ${dev ? "development" : "production"}`);
  console.log(`  Settings http://${hostname}:${port}  →  Settings button (or Ctrl+,)`);
  console.log(`\n  Ctrl+C to stop.\n`);
});

/* ------------------------------------------------------------------ */
/* .env reload                                                        */
/* ------------------------------------------------------------------ */

/**
 * Watch `.env*` and reload it, because Next does not.
 *
 * `next dev` normally watches these files and calls `loadEnvConfig` for
 * you — but that watcher lives in the dev bundler that the **CLI**
 * supervises. Running the server programmatically (which this file does,
 * to avoid the supervisor fork) leaves the project without it, so editing
 * `.env` would silently have no effect until a restart. That is a genuinely
 * confusing failure, so it is wired back up here.
 *
 * The ordering is the delicate part. `@next/env`'s forced reload calls
 * `replaceProcessEnv`, which **deletes** every variable that was not in the
 * snapshot taken at first load. Anything set at boot by this script or by
 * the shell would therefore be wiped by the very first file edit. So the
 * snapshot is refreshed with the live environment immediately before each
 * reload, and the boot-time values survive.
 */
const ENV_FILES = [
  `.env.${process.env.NODE_ENV ?? "development"}.local`,
  ".env.local",
  `.env.${process.env.NODE_ENV ?? "development"}`,
  ".env",
];

if (dev) {
  let loadEnvConfig = null;
  try {
    ({ loadEnvConfig } = require("@next/env"));
  } catch {
    // @next/env is a transitive dependency. If it ever stops being
    // resolvable, losing env hot-reload is not worth failing the boot.
  }

  if (loadEnvConfig) {
    const watched = new Set(ENV_FILES.map((file) => resolve(process.cwd(), file)));
    let pending = null;

    const reload = () => {
      pending = null;
      try {
        // Fold the live environment into the snapshot first, so the reload
        // cannot delete a variable that was set before the server started.
        const snapshot = { ...process.env };
        loadEnvConfig(process.cwd(), true, console, true);
        for (const [key, value] of Object.entries(snapshot)) {
          if (value !== undefined && process.env[key] === undefined) {
            process.env[key] = value;
          }
        }
        console.log("  Reloaded .env");
      } catch (err) {
        console.warn(`  Could not reload .env: ${err.message}`);
      }
    };

    try {
      const watcher = watch(process.cwd(), { persistent: false }, (_event, filename) => {
        if (!filename) return;
        if (!watched.has(resolve(process.cwd(), filename.toString()))) return;
        // Editors write in bursts (truncate, write, rename), so coalesce.
        if (pending) clearTimeout(pending);
        pending = setTimeout(reload, 120);
      });
      watcher.on("error", () => {
        /* Watching is a convenience; never let it take the server down. */
      });
    } catch {
      // Some filesystems cannot be watched. Not fatal.
    }
  }
}

/* Close the listener cleanly on interrupt rather than hanging on keep-alive. */
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
