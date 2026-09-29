/**
 * Registers the TypeScript resolve hooks. Used via `node --import`.
 *
 * Combined with Node 24's native type stripping, this lets the seed and demo
 * scripts run the real library sources with no build step.
 */

import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./ts-resolve.mjs", pathToFileURL(import.meta.filename));
