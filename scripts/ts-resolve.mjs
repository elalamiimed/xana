/**
 * Resolve hooks for running the real sources directly under Node.
 *
 * Three gaps between Node's ESM resolver and what this project (correctly)
 * writes for its bundler:
 *
 *   1. Extension-less relative imports — `./types` must find `./types.ts`.
 *   2. Extension-less package subpaths — `next/server` must find
 *      `next/server.js`. The bundler resolves this via the package's exports
 *      map; Node's ESM resolver does not apply the CJS extension fallback.
 *   3. The `@/*` tsconfig path alias, which maps to `src/*`.
 *
 * Combined with Node 24's native type stripping, this lets the seed, demo and
 * route smoke scripts run the real library with no build step and no extra
 * dependency. tsx would also work but spawns an esbuild service subprocess.
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Candidate file paths for a base path that lacks an extension. */
function candidatesFor(basePath) {
  return [
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.mjs`,
    `${basePath}.js`,
    `${basePath}.json`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
    path.join(basePath, "index.js"),
  ];
}

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

export function resolve(specifier, context, nextResolve) {
  const hasExtension = /\.[a-z0-9]+$/i.test(specifier);

  /* --- `@/...` tsconfig path alias -> <root>/src/... --- */
  if (specifier.startsWith("@/")) {
    const target = firstExisting(candidatesFor(path.join(PROJECT_ROOT, "src", specifier.slice(2))));
    if (target) return { url: pathToFileURL(target).href, shortCircuit: true };
  }

  /* --- Extension-less relative specifiers --- */
  if ((specifier.startsWith(".") || specifier.startsWith("/")) && !hasExtension && context.parentURL) {
    const basePath = fileURLToPath(new URL(specifier, context.parentURL));
    const target = firstExisting(candidatesFor(basePath));
    if (target) return { url: pathToFileURL(target).href, shortCircuit: true };
  }

  /*
   * --- Extension-less package subpaths: `next/server`, `next/headers` ---
   *
   * Only single-segment bare specifiers are touched, so scoped packages and
   * deep paths are left to Node.
   */
  if (!specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("node:") && !hasExtension) {
    const segments = specifier.split("/");
    if (segments.length === 2 && !specifier.startsWith("@")) {
      const basePath = path.join(PROJECT_ROOT, "node_modules", segments[0], segments[1]);
      const target = firstExisting(candidatesFor(basePath));
      if (target) return { url: pathToFileURL(target).href, shortCircuit: true };
    }
  }

  return nextResolve(specifier, context);
}
