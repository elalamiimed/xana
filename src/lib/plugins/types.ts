/**
 * The plugin vocabulary: what a feature is allowed to do, and who said so.
 *
 * WHY THIS FILE EXISTS
 *
 * Xana's adapters used to run unconditionally. Weather geolocated the machine
 * by IP on first paint; a calendar feed was fetched if a URL happened to be in
 * the environment; nothing anywhere recorded that the user had agreed to any
 * of it. The features were good and the consent was absent, which is the wrong
 * way round for a thing that lives in your home directory and reads your life.
 *
 * So a feature is now a plugin, and a plugin declares its capabilities up
 * front. Nothing a plugin wants to do happens until the matching capability
 * has been granted, and the grant is a value in the settings file the user can
 * see and revoke.
 *
 * WHAT A CAPABILITY IS NOT
 *
 * A capability is not access control between people. There is one user, the
 * server listens on loopback, and anything that can reach these routes could
 * read the SQLite file directly. A capability describes what Xana is permitted
 * to send **off this machine** and what she is permitted to change, and it
 * exists so that decision is explicit, visible, and reversible. Claiming more
 * than that would be security theatre, and this file would rather be honest.
 *
 * THE ONE RULE
 *
 *   No grant, no code path. A plugin whose capabilities are not all granted is
 *   never called, so it cannot make a request "and then check". `permitted()`
 *   below is the single place that decides, and the registry is the single
 *   caller, so there is exactly one gate to audit.
 */

import type { AdapterStatus } from "../core/types";
import type { CapabilityKey } from "../settings/types";

/**
 * The status vocabulary, borrowed from `AdapterStatus` rather than invented.
 * Deriving it with an index keeps the two from drifting: adding a state to the
 * contract makes it available here, and removes nothing.
 */
export type PluginState = AdapterStatus["state"] | "blocked";

/* ------------------------------------------------------------------ */
/* Capabilities                                                       */
/* ------------------------------------------------------------------ */

/**
 * The closed set of things a plugin may ask for.
 *
 * Closed on purpose: a plugin cannot invent a capability, so a new one is a
 * change here, to `CAPABILITY_INFO`, and to the settings coercion — three
 * places that all fail loudly if they disagree. An open string would let one
 * plugin ask for something the UI has no words for, which is exactly the case
 * where a user clicks Allow without knowing what they allowed.
 */
export type CapabilityKind = CapabilityKey;

/**
 * The two capability lists must stay identical.
 *
 * `CapabilityKey` is the settings layer's copy, which is the one the write path
 * validates against; this file's union is the one the plugins are typed by. If
 * they diverge, a plugin can require a capability that can never be stored, and
 * the failure is a plugin that is permanently blocked with no way to allow it.
 * This alias makes that a typecheck error instead, in both directions.
 */
type _CapabilityParity = CapabilityKind extends CapabilityKey
  ? CapabilityKey extends CapabilityKind
    ? true
    : never
  : never;
const _capabilityParity: _CapabilityParity = true;
void _capabilityParity;

export const CAPABILITY_KINDS: readonly CapabilityKind[] = [
  "local.read",
  "local.write",
  "net.read",
  "net.write",
  "location",
  "account",
  "remote.write",
] as const;

export interface CapabilitySpec {
  kind: CapabilityKind;
  /**
   * Why the plugin needs this, in the second person, as the user reads it in
   * a consent prompt. "Fetch the forecast for your coordinates." — not "needs
   * network access". The user is being asked to decide something; the reason
   * is the decision.
   */
  reason: string;
  /**
   * The hosts this capability reaches, for `net.read` and `net.write`.
   *
   * Shown verbatim in the prompt, because "the network" is not a thing anyone
   * can consent to and `api.open-meteo.com` is. Empty means the capability
   * does not leave the machine.
   */
  hosts?: string[];
}

export type PermissionGrants = Partial<Record<CapabilityKind, boolean>>;

/** Everything a capability implies about a plugin, for the UI to render. */
export interface CapabilityInfo {
  kind: CapabilityKind;
  /** "Reading files", as a heading. */
  label: string;
  /** One line on what granting this means, in general. */
  blurb: string;
  /** Does granting it let data leave this machine? */
  leaves: boolean;
  /** Does granting it let something change? */
  writes: boolean;
}

/**
 * The descriptions, kept beside the union so adding a kind without describing
 * it is a typecheck failure rather than an unexplained row in the UI.
 */
export const CAPABILITY_INFO: Record<CapabilityKind, CapabilityInfo> = {
  "local.read": {
    kind: "local.read",
    label: "Read local files",
    blurb: "Read a folder or file on this machine. Nothing is uploaded.",
    leaves: false,
    writes: false,
  },
  "local.write": {
    kind: "local.write",
    label: "Write local files",
    blurb: "Write to a folder, or to Xana's own database.",
    leaves: false,
    writes: true,
  },
  "net.read": {
    kind: "net.read",
    label: "Read from the internet",
    blurb: "Request data from the listed hosts. They see your IP address.",
    leaves: true,
    writes: false,
  },
  "net.write": {
    kind: "net.write",
    label: "Send to the internet",
    blurb: "Send text you typed to the listed hosts.",
    leaves: true,
    writes: false,
  },
  location: {
    kind: "location",
    label: "Use your location",
    blurb: "Use the coordinates you set, or ask a service to guess them from your IP.",
    leaves: true,
    writes: false,
  },
  account: {
    kind: "account",
    label: "Use your account",
    blurb: "Hold a key or token for a service you own, and read it as you.",
    leaves: false,
    writes: false,
  },
  "remote.write": {
    kind: "remote.write",
    label: "Change things remotely",
    blurb: "Create or modify items in a service you own. This is the dangerous one.",
    leaves: true,
    writes: true,
  },
};

/** The order the UI lists capabilities in: danger last. */
export const CAPABILITY_ORDER: readonly CapabilityKind[] = [
  "local.read",
  "local.write",
  "account",
  "net.read",
  "net.write",
  "location",
  "remote.write",
] as const;

/* ------------------------------------------------------------------ */
/* Grant decisions                                                    */
/* ------------------------------------------------------------------ */

/**
 * Whether one capability has been granted.
 *
 * Strictly `=== true`. A grant that is absent, `undefined`, `"yes"` or `1` is
 * not a grant. The settings file is user-editable and hand-editing it is a
 * supported way to configure Xana, so this reads the file as hostile input:
 * anything that is not an explicit boolean true does not turn a plugin on.
 */
export function granted(grants: PermissionGrants | undefined, kind: CapabilityKind): boolean {
  return grants?.[kind] === true;
}

/** The capabilities in `needed` that are not yet granted, in display order. */
export function missingCapabilities(
  needed: readonly CapabilityKind[],
  grants: PermissionGrants | undefined,
): CapabilityKind[] {
  const set = new Set(needed);
  return CAPABILITY_ORDER.filter((kind) => set.has(kind) && !granted(grants, kind));
}

/**
 * The gate. Returns the plugin if it may run, or `undefined` with a reason.
 *
 * Returning the reason rather than a bare boolean is deliberate: the status
 * row the user sees on a blocked plugin has to name what is missing, or
 * "Weather: offline" becomes a bug report instead of a prompt to click Allow.
 */
export function permitted(
  needed: readonly CapabilityKind[],
  grants: PermissionGrants | undefined,
): { ok: true } | { ok: false; missing: CapabilityKind[] } {
  const missing = missingCapabilities(needed, grants);
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/** Human sentence for a blocked status row. */
export function blockedDetail(missing: readonly CapabilityKind[]): string {
  if (missing.length === 0) return "";
  const names = missing.map((kind) => CAPABILITY_INFO[kind].label.toLowerCase());
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Waiting for permission — ${list}`;
}

/** Does this set of capabilities let data leave the machine? */
export function leavesMachine(needed: readonly CapabilityKind[]): boolean {
  return needed.some((kind) => CAPABILITY_INFO[kind].leaves);
}

/** Does this set of capabilities let something change? */
export function canWrite(needed: readonly CapabilityKind[]): boolean {
  return needed.some((kind) => CAPABILITY_INFO[kind].writes);
}

/* ------------------------------------------------------------------ */
/* The plugin shape                                                   */
/* ------------------------------------------------------------------ */

/** What a plugin is for, so the UI can group and label it. */
export type PluginCategory = "life" | "environment" | "knowledge" | "signal" | "model";

export const CATEGORY_LABEL: Record<PluginCategory, string> = {
  life: "Your life",
  environment: "The world",
  knowledge: "What you know",
  signal: "Signals",
  model: "Her mind",
};

/**
 * How a connection reaches the world. The one axis the Connections screen
 * groups by.
 *
 * WHY THIS EXISTS BESIDE `category`
 *
 * `category` says what a feature is *about* — your life, the world, what you
 * know. That is the right axis for the briefing and for reading the list top to
 * bottom. It is the wrong axis for a settings screen, where the user's actual
 * question is "what has to be switched on, and what does it need from me":
 * an API key, a folder on this machine, a phone, or nothing at all.
 *
 * The four answers to that question are the four kinds. A screen grouped this
 * way can say, honestly and once, what each group costs you in configuration —
 * "these need a key", "these read a folder you name", "this one is a device you
 * own" — instead of repeating it inside every card.
 *
 * It is also the answer to the join the app used to have: keys, folders and
 * sign-ins lived on three different screens under three different names, and
 * none of them was the place you looked for "everything Xana can reach". One
 * list, grouped by what it takes to connect, is that place.
 */
export type ConnectionKind =
  /** Reads something that is already yours. Usually no key, sometimes a folder. */
  | "source"
  /** A third-party API, reached with a key or with no key at all. */
  | "service"
  /** Something you carry that reports to her: a phone, a bridge, a player. */
  | "device"
  /** On your machine already. Part of Xana rather than a subscription. */
  | "library";

export const CONNECTION_KIND_ORDER: readonly ConnectionKind[] = [
  "source",
  "service",
  "device",
  "library",
] as const;

export const CONNECTION_KIND_LABEL: Record<ConnectionKind, string> = {
  source: "Your data",
  service: "Services",
  device: "Devices",
  library: "Bundled",
};

/**
 * What each group costs in configuration, as one sentence.
 *
 * Written per group rather than per card on purpose: the sentence is about the
 * *kind* of thing being connected, and repeating it sixteen times would turn
 * the one line a user actually reads into noise.
 */
export const CONNECTION_KIND_BLURB: Record<ConnectionKind, string> = {
  source: "Things you already have. Most need no key at all.",
  service: "Reached over the internet. Some need a key, some do not.",
  device: "Something you carry, posting to her on your own network.",
  library: "Already part of Xana. Nothing to connect, nothing to pay.",
};

/**
 * What the whole screen is called, in one place.
 *
 * The user asked for one thing rather than two — keys, folders, sign-ins and
 * bundled sources under a single name — so the name appears in the tab, the
 * panel heading and the API route. Kept as a constant because three copies of
 * a title that must agree is three chances for them not to.
 */
export const CONNECTIONS_LABEL = "Connections";

/** How to read the list, once, above the groups. */
export const CONNECTIONS_BLURB =
  "Everything Xana can reach, in one place: public APIs, keys, folders on this machine, and devices that report to her. Nothing here is required — her own engine covers the day without any of it.";

/**
 * Where the data physically comes from. This is the distinction the UI needs
 * to be honest about, because "local" and "live" are not the same promise as
 * "synthetic" and users cannot tell them apart from a green dot.
 */
export type PluginProvenance =
  /** Answered entirely on this machine. */
  | "local"
  /** Answered by a service, right now. */
  | "live"
  /** Answered by a service earlier; the value is cached and age is shown. */
  | "cached"
  /** No source configured. Xana is using placeholder values, and says so. */
  | "synthetic";

export interface PluginDescriptor {
  /** Stable id. Used in the settings file, the URL, and the status row. */
  id: string;
  /** What the user sees. */
  name: string;
  category: PluginCategory;
  /**
   * How this connection is reached, and therefore which group it sits in.
   *
   * Required rather than defaulted. A default would be wrong for at least one
   * plugin and nothing would catch it — the value decides where a card appears
   * on the only screen that can grant it, so "I forgot to set it" has to be a
   * typecheck error rather than a card filed under the wrong heading.
   */
  kind: ConnectionKind;
  /** One line, no full stop needed, describing what it gives Xana. */
  tagline: string;
  /**
   * What actually leaves this machine when the plugin runs, in plain words.
   * This is the sentence the user is really consenting to, so it is required
   * even for a plugin that sends nothing — in which case it says so.
   */
  dataNote: string;
  /** Everything the plugin needs. Write-only capabilities are optional. */
  needs: readonly CapabilitySpec[];
  /**
   * Write capabilities. Missing these degrades the plugin, never blocks it.
   */
  optional?: readonly CapabilitySpec[];
  /**
   * Whether the optional capabilities are all-or-nothing, or any one is enough.
   *
   * Gets this wrong in either direction and a feature is either silently
   * unavailable or unavailable for a reason the user cannot see. The two real
   * cases:
   *
   *  - **Todoist.** `account` (the token) and `net.read` (reaching the API) are
   *    both needed. Granting only one gives you nothing, so the default is
   *    "all". The status line says which one is missing.
   *  - **Calendar.** Either an ICS feed (a network read) or Google Calendar (an
   *    account, and a network read) is enough — they are two ways to get the
   *    same events. Requiring both would make each look broken on its own.
   *
   * Defaults to `true`, because "every requirement met" is the meaning a reader
   * will assume, and a capability list that is silently an OR is the kind of
   * thing that produces a status row nobody can explain.
   */
  needsAll?: boolean;
  /**
   * Always runs, and is never gated.
   *
   * THE RULE
   *
   *   Her own store is not a permission boundary; everything else is.
   *
   * Tasks, events she booked herself, habits, energy readings and memories live
   * in `data/xana.db`, which she wrote. Asking a user to grant access to their
   * own task list before the assistant works would be theatre, and it would mean
   * a fresh install did nothing at all — no tasks, no schedule, no briefing —
   * until someone found the permissions screen. Those plugins are core.
   *
   * WHAT `core` DOES NOT MEAN
   *
   * It does not mean "this plugin may read your disk". A core plugin's `needs`
   * list must be EMPTY, because `core` skips the gate entirely and any
   * capability listed there would be decorative — never checked, never
   * reported, never revocable. `assertBootContract` enforces that.
   *
   * That distinction was learned the hard way. The first version of this flag
   * let a core plugin declare `local.read` and still run ungated, which meant
   * six plugins read arbitrary user-chosen folders — a Markdown vault, a health
   * export directory, any file for now-playing and mail — on a fresh install
   * with nothing granted. The capability was named in the descriptor, shown in
   * no UI, and enforced nowhere.
   *
   * So a plugin that touches anything outside `xana.db` is NOT core and must
   * declare the capability that covers it.
   */
  core?: boolean;
  /**
   * Settings this plugin owns, declared so the form is generated rather than
   * hand-built. Keys are `plugin.field`, and `registry.ts` refuses to boot if
   * one is not in the settings layer's `PLUGIN_SETTING_KEYS` allowlist.
   */
  config?: readonly PluginConfigItem[];
  /** One line on what she can do once it is working, shown after consent. */
  provides: string;
  /** Whether Xana can change things here once `remote.write` is granted. */
  writesBack?: boolean;
}

export interface PluginConfigItem {
  key: string;
  label: string;
  hint: string;
  kind: "text" | "url" | "path" | "number" | "secret";
  /** An example value, shown as the placeholder. */
  example?: string;
  /**
   * Where the user goes to get it. Shown for secrets, because "paste your API
   * token" without saying where the token lives is the reason people give up
   * on an integration.
   */
  where?: string;
  /**
   * Required for the plugin to do anything useful. A plugin with a missing
   * required setting is not blocked — the permission can still be granted,
   * because consent and configuration are different questions — but the card
   * says what is missing and the status row repeats it.
   */
  required?: boolean;
}

/* ------------------------------------------------------------------ */
/* Runtime status                                                     */
/* ------------------------------------------------------------------ */

/** One capability, as the consent card renders it. */
export interface CapabilityView extends CapabilityInfo {
  granted: boolean;
  /** Why this plugin needs it, in the second person. */
  reason: string;
  hosts?: string[];
  /** True when the plugin works without it. */
  optional: boolean;
}

/** One setting, as the form renders it: presence, never a secret's value. */
export interface PluginConfigView {
  key: string;
  label: string;
  hint: string;
  kind: "text" | "url" | "path" | "number" | "secret";
  example?: string;
  where?: string;
  required: boolean;
  /** Whether a value exists in any layer. */
  present: boolean;
  /** Which layer answered, so "clear" can be explained honestly. */
  from: "settings" | "env" | "none";
  /**
   * Non-secrets only.
   *
   * A secret's value never travels toward the browser from here, not even
   * masked — the mask for the model key exists because the user needs to tell
   * two keys apart, and for these the presence flag is enough. One fewer
   * shape that could leak.
   */
  value?: string;
}

/**
 * What the runtime can report on its own, with no descriptor and no I/O.
 *
 * Split out from `PluginStatus` so the boundary is enforced by types: this
 * layer knows what a plugin last managed to read and whether it is allowed to
 * run; it does not know the tagline, the reasons, or what the fields are
 * called. The endpoint joins the two, which is why there is exactly one place
 * that can be wrong about "is this plugin ready".
 */
export interface RuntimeStatus {
  id: string;
  state: PluginState;
  provenance: PluginProvenance;
  /** One line on how the last read went. */
  detail: string;
  /** Capabilities not yet granted. Empty when the plugin may run. */
  missing: CapabilityKind[];
  /**
   * Optional capabilities not yet granted.
   *
   * The plugin runs without these; granting one does more. Kept apart from
   * `missing` because the two produce different sentences: "waiting for
   * permission" against "works, and would do more with…".
   */
  waiting: CapabilityKind[];
  /** How long the last read took. */
  durationMs?: number;
  /** True when the write half is granted and usable. */
  canWrite: boolean;
}

/** A plugin's status, as the UI reads it. */
export interface PluginStatus extends RuntimeStatus {
  name: string;
  category: PluginCategory;
  /**
   * How it is reached: your data, a service, a device, or bundled.
   *
   * Carried on the wire rather than left to the client to look up, so the one
   * screen that groups connections cannot file a card under a heading the
   * descriptor never agreed to. The label and order travel with the response
   * for the same reason.
   */
  kind: ConnectionKind;
  tagline: string;
  /** What leaves this machine, in plain words. The sentence being consented to. */
  dataNote: string;
  /** What she gains once it is working. */
  provides: string;
  /** Every capability with its reason, in danger order. */
  capabilities: CapabilityView[];
  /** Required settings that have no value yet. */
  missingConfig: string[];
  config: PluginConfigView[];
  /** Whether this plugin can change things remotely at all. */
  writesBack: boolean;
  /** Running, with every capability granted and every required setting filled. */
  ready: boolean;
}

/**
 * One group on the connections screen, with its counts already worked out.
 *
 * The counts are computed server-side because "3 of 4 connected" has to agree
 * with the rows rendered underneath it, and a client-side recomputation is a
 * second opinion waiting to disagree. The blurb is the server's too: it is a
 * sentence about the *kind*, and it stays true as cards are added to the group.
 */
export interface ConnectionGroup {
  kind: ConnectionKind;
  label: string;
  blurb: string;
  /** Every connection in this group, in descriptor order. */
  plugins: PluginStatus[];
  /** How many of them can run right now. */
  ready: number;
  /** How many are waiting on a permission, a setting, or a key. */
  pending: number;
}

/** The wire shape `GET /api/connections` returns. */
export interface ConnectionsResponse {
  plugins: PluginStatus[];
  /** The same rows, grouped by what it takes to connect them. */
  groups: ConnectionGroup[];
  /** Every kind in display order, including groups with nothing in them yet. */
  kinds: { kind: ConnectionKind; label: string; blurb: string }[];
  grants: PermissionGrants;
  /** How many connections are blocked purely on consent. */
  awaitingConsent: number;
  /** How many are allowed but still missing a setting. */
  unconfigured: number;
}

/**
 * The old name for the same response.
 *
 * Kept as an alias rather than deleted: the wire shape did not change when the
 * screen was renamed, and a bundle or a script built against `/api/plugins`
 * should keep typechecking. New code uses `ConnectionsResponse`.
 */
export type PluginsResponse = ConnectionsResponse;

/** A connection's status row. Same shape; the new name for new code. */
export type ConnectionStatus = PluginStatus;

/** The body `POST /api/connections` accepts. */
export interface PluginAction {
  id: string;
  action: "grant" | "revoke" | "connect" | "disconnect";
  /** For `grant`: also grant the write capability where a plugin offers one. */
  includeWrite?: boolean;
}

export interface PluginActionResponse {
  ok: boolean;
  message: string;
  /** An authorization URL for the caller to open, on `connect`. */
  authUrl?: string;
  plugins: PluginStatus[];
  grants: PermissionGrants;
}
