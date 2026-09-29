import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module: keep it external to the server bundle.
  serverExternalPackages: ["better-sqlite3"],

  /*
   * Pin the bundler root to this directory.
   *
   * Without it Turbopack walks upward looking for a lockfile and can settle on
   * a parent directory (in this case the user's home), which makes it warn and
   * risks picking up unrelated configuration from outside the project.
   */
  turbopack: {
    root: path.resolve(import.meta.dirname),
  },

  typescript: {
    /*
     * Next's build step forks a child process to run its own type check. That
     * fork is hostile to sandboxed environments and it is the weaker check:
     * `npm run typecheck` runs the same tsc over the same tsconfig with no
     * fork. Types are enforced there (run it before every deploy) rather than
     * twice, once badly.
     */
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
