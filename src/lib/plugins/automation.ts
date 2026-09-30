/**
 * The plugin runtime: consent, configuration, and the gate.
 *
 * Everything in this file exists to make one sentence true:
 *
 *   A plugin with an ungranted capability is never called.
 *
 * Not "is called and checks", not "is called in a limited mode" — never
 * called. The check lives in `PluginEntry.fetch` and again in `runPlugin`, both
 * in front of the adapter, so there is no ordering inside a plugin that can
 * reach the network before consent is read.
 *
 * THREE DECISIONS WORTH KNOWING ABOUT
 *
 * 1. **Grants are read from settings on every use, never captured.**
 *    `setting()` and `grants()` both hit the memoised settings loader, so
 *    revoking a permission takes effect on the next poll rather than on the
 *    next restart. The failure this prevents — "I turned it off and it kept
 *    talking to Google" — is the one that makes people stop believing a
 *    permission screen.
 *
 * 2. **Adapters are rebuilt, not captured.** An adapter reads its own
 *    configuration once, at construction. Building them at import time would
 *    mean pasting a calendar URL into the panel did nothing until a restart —
 *    and would also bind a SQLite store that a test may not have installed
 *    yet. So a plugin owns a lazily-built adapter plus an epoch, and the epoch
 *    advances whenever a grant or a plugin setting changes.
 *
 * 3. **Missing configuration is not missing consent.** A plugin that is
 *    granted but not filled in reports `local` or `offline` from its own
 *    adapter. A plugin that is not granted reports `blocked`. Different rows,
 *    different words: one is a fault, the other is a button nobody pressed.
 */

import type { AdapterStatus, CalendarEvent } from "../core/types";
import {
  credential,
  loadSettings,
  mergePatch,
  savePluginSetting,
  saveSettings,
  type SettingCredential,
} from "../settings/store";
import type { SettingsPatch } from "../settings/types";
import type { LifeAdapter, LifeSnapshot } from "../adapters/types";
import {
  blockedDetail,
  canWrite,
  granted,
  missingCapabilities,
  permitted,
  type CapabilityKind,
  type PermissionGrants,
  type PluginDescriptor,
  type PluginProvenance,
  type PluginStatus,
  type RuntimeStatus,
} from "./types";

/* ------------------------------------------------------------------ */
/* Configuration                                                      */
/* ------------------------------------------------------------------ */

/**
 * Where the legacy source keys went.
 *
 * These connections used to write flat `XANA_CALENDAR_ICS_URLS`-style names
 * into the `sources` map. Those names still resolve — an environment variable a
 * user exported is not something an upgrade gets to ignore — but the plugin's
 * own qualified key is what the panel writes. `credential()` stops at the first
 * non-blank name, so the file beats the environment, as everywhere else.
 */
const LEGACY_ALIASES: Record<string, string[]> = {
  "calendar.icsUrls": ["XANA_CALENDAR_ICS_URLS", "XANA_CALENDAR_ICS_URL"],
  "weather.latitude": ["XANA_LAT"],
  "weather.longitude": ["XANA_LON"],
  "weather.place": ["XANA_LOCATION_LABEL"],
  "tasks.token": ["XANA_TODOIST_TOKEN"],
  "notes.vault": ["XANA_OBSIDIAN_VAULT"],
  "health.folder": ["XANA_HEALTH_DIR"],
  "media.url": ["XANA_NOWPLAYING_URL"],
  "media.file": ["XANA_NOWPLAYING_FILE"],
  "mail.url": ["XANA_MAIL_URL"],
  "mail.file": ["XANA_MAIL_FILE"],
  "markets.symbols": ["XANA_FINANCE_SYMBOLS"],
};

/** A plugin setting, resolved settings-file first then environment. */
export function setting(key: string, legacyNames: readonly string[] = []): string {
  return credential(key, ...(LEGACY_ALIASES[key] ?? []), ...legacyNames).value;
}

/** Presence and provenance of a plugin setting, never its value. */
export function settingView(
  key: string,
  legacyNames: readonly string[] = [],
): SettingCredential {
  return credential(key, ...(LEGACY_ALIASES[key] ?? []), ...legacyNames);
}

/** Whether a plugin setting has a value from any layer. */
export function hasSetting(key: string, legacyNames: readonly string[] = []): boolean {
  return settingView(key, legacyNames).present;
}

/** Every grant, as stored. */
export function grants(): PermissionGrants {
  return loadSettings().permissions;
}

/** Whether one capability is granted right now. */
export function isGranted(kind: CapabilityKind): boolean {
  return granted(grants(), kind);
}

/** Whether every capability in `needed` is granted right now. */
export function allGranted(needed: readonly CapabilityKind[]): boolean {
  return permitted(needed, grants()).ok;
}

/* ------------------------------------------------------------------ */
/* The epoch                                                          */
/* ------------------------------------------------------------------ */

/**
 * Bumped whenever consent or a plugin setting changes.
 *
 * One integer standing in for "rebuild anything that read configuration at
 * construction time". A plugin holds the epoch it was built at and rebuilds
 * when it moves, which is why pasting a calendar URL has an effect on the next
 * poll and why granting a permission cannot leave a half-configured adapter
 * behind.
 */
let epoch = 0;

export function configEpoch(): number {
  return epoch;
}

/** Force every plugin to rebuild on next use. */
export function bumpConfigEpoch(): void {
  epoch += 1;
}

/* ------------------------------------------------------------------ */
/* Plugin entries                                                     */
/* ------------------------------------------------------------------ */

export interface PluginEntry {
  descriptor: PluginDescriptor;
  /**
   * The data source, built on first use and rebuilt when configuration moves.
   * `undefined` when a required capability is not granted — which is the point:
   * there is no object to call.
   */
  adapter(): LifeAdapter | undefined;
  /**
   * The permission gates the live adapter was built with, or `undefined` when
   * no adapter has been built.
   */
  gates(): PluginGates | undefined;
  /** Capabilities not granted at this moment. */
  missing(): CapabilityKind[];
  /** Whether the write half is usable right now. */
  writable(): boolean;
  /** Read the plugin's slice, or report why it could not be read. */
  fetch(snapshot: LifeSnapshot): Promise<AdapterStatus>;
  /** Last-known adapter status without I/O, for the presence loop. */
  state(): AdapterStatus | undefined;
  /** Drop the cached slice after a write-back or a revocation. */
  invalidate(): void;
  /** The runtime half of the status row. The endpoint adds the descriptor. */
  status(): RuntimeStatus;
}

/** Map an adapter's own report onto the plugin's provenance vocabulary. */
function provenanceOf(status: AdapterStatus | undefined): PluginProvenance {
  if (!status) return "local";
  switch (status.mode) {
    case "live":
      return "live";
    case "synthetic":
      // The adapters say "synthetic" both for placeholder values (weather with
      // no location) and for a failed read that kept the last real value
      // (a calendar whose feed is down). Those are different promises, and the
      // snapshot itself carries the distinction: a `synthetic: true` payload
      // is invented, anything else is a real value we could not refresh.
      return status.synthetic ? "synthetic" : "cached";
    default:
      return "local";
  }
}

function statusRow(
  descriptor: PluginDescriptor,
  state: RuntimeStatus["state"],
  provenance: PluginProvenance,
  detail: string,
): RuntimeStatus {
  return {
    id: descriptor.id,
    state,
    provenance,
    detail,
    missing: [],
    waiting: [],
    canWrite: false,
  };
}

/**
 * A core plugin's required capabilities are, by construction, local only.
 *
 * The boot contract refuses `core: true` on a descriptor whose *required* list
 * leaves the machine, so this is not a second opinion about consent — it is the
 * same rule applied at runtime, for the case where the registry was never
 * constructed (a script importing one adapter directly). Belt and braces, and
 * cheap.
 */
function missingRequired(
  descriptor: PluginDescriptor,
  needed: readonly CapabilityKind[],
): CapabilityKind[] {
  if (descriptor.core) return [];
  return missingCapabilities(needed, grants());
}

/**
 * Optional capabilities not yet granted.
 *
 * Separate from `missing` because it means something different and the UI says
 * something different about it: a plugin with an ungranted optional capability
 * still runs, it just does less. Reporting these as `missing` would mark a
 * perfectly working calendar as "blocked", which is the fastest way to teach
 * someone that the permission screen lies.
 */
function waitingOptional(
  descriptor: PluginDescriptor,
  optional: readonly CapabilityKind[],
): CapabilityKind[] {
  return missingCapabilities(optional, grants());
}

/**
 * What a plugin is allowed to do, decided by the plugin layer and handed to the
 * adapter factory.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT INSIDE THE ADAPTERS
 *
 * A core plugin is never gated: its required capabilities are local, so it runs
 * always. But a core plugin can still have an optional network half — calendar
 * reading an ICS feed, tasks reading Todoist — and that half must not run
 * without consent. An adapter cannot work this out for itself: it knows it has
 * a URL configured, not whether the user granted `net.read`.
 *
 * The first attempt at this let the adapter keep calling `httpText()` whenever
 * a URL was present, on the assumption that the plugin layer had already
 * refused. For a non-core plugin that was true. For a core plugin it was not,
 * because the gate only ever looked at the required list — so a configured ICS
 * URL would have been fetched with `permissions: {}`. That is the bug this type
 * closes.
 *
 * The fix is that the decision is made once, in `definePlugin`, and passed in.
 * An adapter does not ask whether it may fetch; it is told, and there is no
 * code path that reaches the network when the answer is no. `remote` is
 * deliberately separate from `network`: Todoist and mail read from a URL
 * *because the user pointed at one*, so they follow `network`, while a Google
 * Calendar write follows `remote` — a user can reasonably allow Google reads
 * and refuse Google writes.
 */
export interface PluginGates {
  /** May this plugin reach the network at all, for any of its optional hosts? */
  network: boolean;
  /** May this plugin change something in a remote service? */
  remote: boolean;
  /** May this plugin write to a local file or folder? */
  localWrite: boolean;
  /**
   * The epoch this decision was made at.
   *
   * Carried so a stale gate is detectable rather than merely unlikely. The
   * adapter is rebuilt whenever the epoch moves, so a gate that is behind is a
   * bug in the rebuild, not a race — and this field is what a test can assert
   * on to catch it.
   */
  epoch: number;
}

/** Compute the gates for a descriptor from the current grants. */
export function gatesFor(descriptor: PluginDescriptor, currentEpoch = epoch): PluginGates {
  const optional = descriptor.optional ?? [];
  const grantedOptional = optional.filter((spec) => granted(grants(), spec.kind));
  // `needsAll: false` means any one of them unlocks the whole optional half.
  const anyOptional =
    descriptor.needsAll === false
      ? grantedOptional.length > 0
      : grantedOptional.length === optional.length;

  const networkOffered = optional.some((spec) => spec.kind === "net.read" || spec.kind === "net.write");
  const remoteOffered = optional.some((spec) => spec.kind === "remote.write");

  return {
    // A plugin that offers no network capability at all is not "allowed to
    // reach the network" — it simply never does.
    network:
      networkOffered &&
      optional.some(
        (spec) =>
          (spec.kind === "net.read" || spec.kind === "net.write") && granted(grants(), spec.kind),
      ) &&
      anyOptional,
    remote:
      remoteOffered &&
      optional.some((spec) => spec.kind === "remote.write" && granted(grants(), spec.kind)) &&
      anyOptional,
    localWrite: optional.some((spec) => spec.kind === "local.write" && granted(grants(), spec.kind)),
    epoch: currentEpoch,
  };
}
/**
 * Wrap a real adapter as a plugin.
 *
 * The adapter factory receives `PluginGates`, so an adapter is *told* what it
 * may do rather than having to work it out. It is built at most once per epoch,
 * and never at all while a required capability is missing — so a plugin the
 * user has not allowed has no adapter instance, no fetch function, and nothing
 * to call by accident.
 */
export function definePlugin(config: {
  descriptor: PluginDescriptor;
  adapter: (gates: PluginGates) => LifeAdapter;
}): PluginEntry {
  const { descriptor } = config;
  const needed = descriptor.needs.map((n) => n.kind);
  const optional = (descriptor.optional ?? []).map((o) => o.kind);

  let built: LifeAdapter | undefined;
  let builtAt = -1;
  let builtGates: PluginGates | undefined;

  const allowed = (): boolean => {
    // A core plugin runs always. The boot contract refuses `core: true` on any
    // descriptor whose required capabilities leave the machine, so this is only
    // ever reached for a plugin whose ungated half reads Xana's own store.
    if (descriptor.core) return true;
    return permitted(needed, grants()).ok;
  };

  /** The adapter if it exists and is current; builds it when permitted. */
  const current = (): LifeAdapter | undefined => {
    if (!allowed()) {
      // Drop a previously-built adapter rather than keep it warm. If the
      // permission comes back, the next call rebuilds it with fresh config —
      // and, more importantly, with fresh gates. A warm adapter built while
      // `net.read` was granted would otherwise keep fetching after a revoke,
      // which is the one thing revoking is supposed to stop.
      built = undefined;
      builtAt = -1;
      builtGates = undefined;
      return undefined;
    }
    if (built && builtAt === epoch) return built;
    const next = gatesFor(descriptor, epoch);
    built = config.adapter(next);
    builtAt = epoch;
    builtGates = next;
    return built;
  };

  return {
    descriptor,
    adapter: () => current(),
    /**
     * The gates the live adapter was built with.
     *
     * Exposed so the decision is auditable: a test can assert that an adapter
     * configured with an ICS URL but no `net.read` was built with
     * `network: false`, which is the assertion that would have caught the bug
     * this whole mechanism exists to fix.
     */
    gates: () => builtGates,
    missing: () => missingRequired(descriptor, needed),
    writable() {
      const optional = (descriptor.optional ?? []).map((o) => o.kind);
      // A plugin with no optional capabilities is not writable. The empty
      // conjunction must not read as permission to change things it never
      // asked for.
      if (optional.length === 0) return false;
      // `needsAll: false` means any one optional capability is enough — the two
      // ways to reach a calendar, for instance. Everything else wants the lot.
      const grantedOptional = optional.filter((kind) => granted(grants(), kind));
      return descriptor.needsAll === false
        ? grantedOptional.length > 0
        : grantedOptional.length === optional.length;
    },
    async fetch(snapshot: LifeSnapshot): Promise<AdapterStatus> {
      const verdict = descriptor.core ? ({ ok: true } as const) : permitted(needed, grants());
      if (!verdict.ok) {
        // Re-checked here rather than trusted from `current()`, so a caller
        // holding an entry from before a revocation still cannot slip past.
        built = undefined;
        builtAt = -1;
        // `blocked`, not `offline`. These rows are what a user sees in the
        // header dots and on the briefing card, and "offline" reads as a fault
        // — something broken, nothing they can do. "Blocked" reads as a
        // permission they have not given, which is what it is, and it is what
        // makes AdapterDots' "waiting for permission" counter mean anything.
        return {
          id: descriptor.id,
          label: descriptor.name,
          state: "blocked",
          mode: "local",
          detail: blockedDetail(verdict.missing),
        };
      }
      const adapter = current();
      if (!adapter) {
        return {
          id: descriptor.id,
          label: descriptor.name,
          state: "offline",
          mode: "local",
          detail: "Not available in this build",
        };
      }
      return adapter.fetch(snapshot);
    },
    // Deliberately does not build. Reporting "not read yet" is the right
    // answer for a plugin that has never run, and constructing an adapter to
    // ask would mean a cheap presence poll could open a SQLite handle.
    state: () => (built && builtAt === epoch ? built.state() : undefined),
    invalidate() {
      if (built) built.invalidate();
    },
    status() {
      const verdict = descriptor.core ? ({ ok: true } as const) : permitted(needed, grants());
      const waiting = waitingOptional(descriptor, optional);
      if (!verdict.ok) {
        const row = statusRow(
          descriptor,
          "blocked",
          "local",
          blockedDetail(verdict.missing),
        );
        row.missing = verdict.missing;
        // Reported on a blocked row too: a user looking at a blocked Todoist
        // should see everything it wants, not just the first thing it lacks.
        row.waiting = waiting;
        return row;
      }
      const live = built && builtAt === epoch ? built.state() : undefined;
      const entry: RuntimeStatus = {
        id: descriptor.id,
        state: live?.state ?? "offline",
        provenance: provenanceOf(live),
        detail: live?.detail ?? "not read yet",
        missing: [],
        waiting,
        durationMs: live?.durationMs,
        canWrite: writeUsable(descriptor),
      };
      return entry;
    },
  };
}

/**
 * Whether a built plugin's write half is usable, from its descriptor.
 *
 * Exported because `status()` needs the same answer as `writable()`, and the
 * two used to compute it separately — which is how a status row ends up saying
 * `canWrite: false` next to a working write. One function, two callers.
 */
export function writeUsable(descriptor: PluginDescriptor): boolean {
  const optional = (descriptor.optional ?? []).map((o) => o.kind);
  if (optional.length === 0) return false;
  const grantedKinds = optional.filter((kind) => granted(grants(), kind));
  return descriptor.needsAll === false
    ? grantedKinds.length > 0
    : grantedKinds.length === optional.length;
}

/* ------------------------------------------------------------------ */
/* Running                                                            */
/* ------------------------------------------------------------------ */

export interface RunResult {
  status: AdapterStatus;
  /** True when the plugin was actually called. */
  ran: boolean;
}

/** Run one plugin into a snapshot, or refuse. */
export async function runPlugin(entry: PluginEntry, snapshot: LifeSnapshot): Promise<RunResult> {
  const needed = entry.descriptor.needs.map((n) => n.kind);
  const verdict = entry.descriptor.core
    ? ({ ok: true } as const)
    : permitted(needed, grants());
  if (!verdict.ok) {
    return {
      ran: false,
      status: {
        id: entry.descriptor.id,
        label: entry.descriptor.name,
        // Matches the row `fetch` builds above. The two must agree: this one
        // reaches the life state, that one the plugin list, and a user reading
        // both would otherwise see "blocked" in Settings and "offline" in the
        // header for the same plugin.
        state: "blocked",
        mode: "local",
        detail: blockedDetail(verdict.missing),
      },
    };
  }
  const status = await entry.fetch(snapshot);
  return { ran: true, status };
}

/* ------------------------------------------------------------------ */
/* Writes that leave the machine                                      */
/* ------------------------------------------------------------------ */

/**
 * The gate for a write that would change something the user owns elsewhere.
 *
 * Separate from `runPlugin` because the answer is used differently: a blocked
 * read degrades to local data, while a blocked write has to *not happen* and
 * has to say so. Returns the sentence to hand the user when it refuses.
 */
export interface WriteVerdict {
  allowed: boolean;
  /** Present when refused: what to tell the user. */
  reason?: string;
  /** Present when refused: the capability to offer to grant. */
  needs?: CapabilityKind;
}

export function mayWriteRemotely(pluginId: string): WriteVerdict {
  const entry = findPlugin(pluginId);
  if (!entry) {
    return {
      allowed: false,
      needs: "remote.write",
      reason: `There is no ${pluginId} plugin to write to.`,
    };
  }
  const writeSpec = (entry.descriptor.optional ?? []).find((o) => o.kind === "remote.write");
  if (!writeSpec) {
    return { allowed: false, reason: `${entry.descriptor.name} cannot be written to.` };
  }
  if (!granted(grants(), "remote.write")) {
    return {
      allowed: false,
      needs: "remote.write",
      reason: `Not without permission to change things in ${entry.descriptor.name}.`,
    };
  }
  return { allowed: true };
}

/* ------------------------------------------------------------------ */
/* The register                                                       */
/* ------------------------------------------------------------------ */

/**
 * Every plugin in the build.
 *
 * Populated by `registry.ts` at import time. The collection lives here rather
 * than in the registry because `mayWriteRemotely` and the permission writes
 * need to find a plugin, and the registry imports the adapters, which import
 * this file — a cycle Node would resolve into an undefined binding.
 */
const entries = new Map<string, PluginEntry>();

/**
 * How to build the register, installed by `registry.ts` at import time.
 *
 * A callback rather than a direct import because the dependency runs the other
 * way: the registry imports the adapters and this file, so importing it back
 * here would be a cycle Node resolves into an undefined binding. The registry
 * sets this as its first act, which is why `allPlugins()` can promise that
 * asking about plugins always works — an empty answer means "there are none",
 * never "nobody has built them yet".
 */
let installer: (() => void) | undefined;

export function setRegisterInstaller(fn: () => void): void {
  installer = fn;
  fn();
}

export function registerPlugin(entry: PluginEntry): PluginEntry {
  entries.set(entry.descriptor.id, entry);
  return entry;
}

export function findPlugin(id: string): PluginEntry | undefined {
  if (entries.size === 0) installer?.();
  return entries.get(id);
}

export function allPlugins(): PluginEntry[] {
  // Lazy on purpose. The plugin list is served by its own route, which has no
  // reason to warm the whole adapter graph — but the first caller to ask must
  // get a real answer, not an empty array that looks like a build with no
  // plugins in it.
  if (entries.size === 0) installer?.();
  return [...entries.values()];
}

/** Every plugin id currently in the register. Used by the boot contract. */
export function pluginIds(): string[] {
  return [...entries.keys()];
}

/* ------------------------------------------------------------------ */
/* Permission writes                                                  */
/* ------------------------------------------------------------------ */

export interface GrantResult {
  ok: boolean;
  error?: string;
  grants: PermissionGrants;
}

/**
 * Grant or revoke capabilities.
 *
 * Goes through `mergePatch` like every other settings write, so one function
 * still owns the file and a grant cannot smuggle in an unrelated change. Saves
 * the merged document rather than the patch, so there is no read-modify-write
 * window between the merge and the write.
 */
export function setGrants(changes: PermissionGrants): GrantResult {
  const patch: SettingsPatch = { permissions: changes };
  const next = mergePatch(loadSettings(), patch);
  const result = saveSettings(next);
  afterConfigChange();
  return { ok: result.ok, error: result.error, grants: next.permissions };
}

/** Grant every capability a plugin needs, and only those. */
export function grantPlugin(id: string, includeOptional = false): GrantResult {
  const entry = findPlugin(id);
  if (!entry) return { ok: false, error: `Unknown plugin: ${id}`, grants: grants() };
  const kinds = [
    ...entry.descriptor.needs.map((n) => n.kind),
    ...(includeOptional ? (entry.descriptor.optional ?? []).map((o) => o.kind) : []),
  ];
  const changes: PermissionGrants = {};
  for (const kind of kinds) changes[kind] = true;
  return setGrants(changes);
}

/** Revoke everything for one plugin: required and optional alike. */
export function revokePlugin(id: string): GrantResult {
  const entry = findPlugin(id);
  if (!entry) return { ok: false, error: `Unknown plugin: ${id}`, grants: grants() };
  const kinds = [
    ...entry.descriptor.needs.map((n) => n.kind),
    ...(entry.descriptor.optional ?? []).map((o) => o.kind),
  ];
  const changes: PermissionGrants = {};
  for (const kind of kinds) changes[kind] = false;
  return setGrants(changes);
}

/**
 * Write plugin settings, then rebuild anything that read them.
 *
 * The rebuild is not a nicety: several adapters resolve their configuration
 * once, so without it the panel would accept a new calendar URL and the next
 * poll would still be reading the old one. That is the exact failure the
 * settings surface exists to prevent.
 */
export function writePluginSettings(values: Record<string, string>): { ok: boolean; error?: string } {
  const result = savePluginSetting(values);
  afterConfigChange();
  return result;
}

/** Drop cached data and force a rebuild after any configuration change. */
function afterConfigChange(): void {
  epoch += 1;
  for (const entry of entries.values()) entry.invalidate();
}

/** A snapshot containing nothing. Re-exported so callers need one import. */
export { emptySnapshot } from "../adapters/types";
export type { LifeAdapter, LifeSnapshot, CalendarEvent, PluginStatus };
