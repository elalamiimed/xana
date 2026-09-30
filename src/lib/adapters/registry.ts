/**
 * Adapter registry — the historical name for what is now the plugin register.
 *
 * This file used to hold the list of data sources and the loop that ran them.
 * Both moved to `lib/plugins/registry.ts`, because a source that runs
 * unconditionally is no longer a thing this app does: every one of them now
 * declares what it needs and is gated on the user having granted it.
 *
 * What is left is a re-export, kept for one reason: `lib/context/gateway.ts`
 * and the adapter tests import `AdapterRegistry` from here, and a rename that
 * touches four files to say the same thing is churn rather than progress. New
 * code should import from `lib/plugins/registry`.
 */

export {
  PluginRegistry as AdapterRegistry,
  PluginRegistry,
  getRegistry,
  resetRegistry,
} from "../plugins/registry";

export type { PluginRegistryOptions as RegistryOptions } from "../plugins/registry";
export type { LifeSnapshot } from "../adapters/types";
