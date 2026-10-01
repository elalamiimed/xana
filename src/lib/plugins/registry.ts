/**
 * The plugin register: every feature Xana can switch on, and the gate in front
 * of each one.
 *
 * WHAT CHANGED AND WHY
 *
 * This used to be `adapters/registry.ts`, and its job was to run eight data
 * sources unconditionally. Weather geolocated the machine by IP on the first
 * paint. A Google calendar was fetched if a URL happened to exist in the
 * environment. Nothing recorded that the user had agreed to any of it. The
 * features were good and the consent was absent.
 *
 * So each source is now a plugin: it declares what it needs, the user grants
 * it, and `runPlugin` refuses to call a plugin whose capabilities are not all
 * granted. The gate is one function, in one file, with one caller — which is
 * the only shape in which "no grant, no call" is checkable rather than
 * aspirational.
 *
 * THE THREE NAMESPACES
 *
 * A plugin touches three separate vocabularies, and each pair is checked here
 * at import time rather than trusted:
 *
 *   1. **Capabilities** (`PermissionKind`) — what the plugin needs.
 *      Checked against the settings layer's allowlist, so a capability that
 *      cannot be stored is a boot failure instead of a permanently blocked
 *      plugin with no way to allow it.
 *   2. **Setting keys** (`plugin.field`) — what the plugin reads.
 *      Checked against `PLUGIN_SETTING_KEYS`, so a typo in a config key is a
 *      boot failure instead of a form field that silently never saves.
 *   3. **Adapter ids** — what the rest of the app filters on.
 *      Checked to be unique, because two plugins sharing an id would make the
 *      life state's status rows ambiguous.
 *
 * Import-time throwing is deliberate. This module is loaded once, by the
 * server, at boot. A mistake in the list below is a programming error and the
 * right time to hear about it is now — not when a user notices that their
 * weather plugin has been "waiting for permission" for a week.
 */

import type { AdapterStatus, EnergyBand } from "../core/types";
import { CAPABILITY_KEYS, PLUGIN_SETTING_KEYS } from "../settings/types";
import { emptySnapshot, type LifeSnapshot } from "../adapters/types";

import { calendarAdapter } from "../adapters/calendar";
import { tasksAdapter } from "../adapters/tasks";
import { knowledgeAdapter } from "../adapters/knowledge";
import { healthAdapter } from "../adapters/health";
import { weatherAdapter } from "../adapters/weather";
import { mediaAdapter } from "../adapters/media";
import { financeAdapter } from "../adapters/finance";
import { mailAdapter } from "../adapters/mail";

import { googleCalendarPlugin } from "./google-calendar";
import {
  allPlugins,
  definePlugin,
  registerPlugin,
  runPlugin,
  setRegisterInstaller,
  type PluginEntry,
  type PluginGates,
} from "./automation";
import type { CapabilityKind, PluginDescriptor } from "./types";
import { blockedDetail } from "./types";

export interface PluginRegistryOptions {
  /** Current energy band, used by the now-playing plugin's focus suggestion. */
  band?: () => EnergyBand;
  /** Names Xana knows, used by the mail plugin's importance scoring. */
  knownPeople?: () => string[];
}

/* ------------------------------------------------------------------ */
/* Descriptors                                                        */
/* ------------------------------------------------------------------ */

/**
 * The built-in sources.
 *
 * Note how many are `core: true`. Tasks, events she booked herself, habits,
 * energy readings and memories all live in Xana's own SQLite store — asking a
 * user to grant access to their own task list before the assistant works would
 * be theatre, and it would mean a fresh install did nothing at all until
 * someone found the permissions screen. So a plugin whose ungated half reads
 * only her own database runs always.
 *
 * What that does NOT do is let anything reach the network. Weather, Todoist,
 * markets and Google Calendar all declare a capability that leaves the machine,
 * and the boot contract rejects `core: true` on any such descriptor — so the
 * flag cannot be used to skip consent for an integration.
 */
const DESCRIPTORS: PluginDescriptor[] = [
  {
    id: "calendar",
    name: "Calendar",
    category: "life",
    // Core: her own events are always in the schedule. The ICS feed is the
    // ungated-exempt half's opposite — it needs `net.read` and an optional
    // account, so it lives under `optional` and cannot run without consent.
    core: true,
    // Either feed is enough. `needsAll: false` says so; see the field's note.
    needsAll: false,
    tagline: "Any published ICS feed, read into today's schedule.",
    dataNote:
      "Fetches the feed URLs you provide. Google, Outlook and Fastmail all publish a private address under their calendar settings. Nothing is uploaded. Her own events stay on this machine and are always read.",
    provides: "Today's events, the next thing, and how much of the day is free.",
    needs: [
      { kind: "local.read", reason: "Read the events Xana booked herself." },
    ],
    optional: [
      {
        kind: "net.read",
        reason: "Fetch the ICS feeds you paste in.",
        // Not a host list: the user supplies the address, which is the honest
        // answer. Naming google.com here would be a guess that excludes
        // Outlook and Fastmail.
        hosts: ["whatever feed URLs you provide"],
      },
      {
        kind: "local.write",
        reason: "Save events she books into her own database.",
      },
    ],
    config: [
      {
        key: "calendar.icsUrls",
        label: "ICS feed URLs",
        hint: "Comma separated. A webcal:// address works too.",
        kind: "url",
        example: "https://calendar.google.com/calendar/ical/…/basic.ics",
      },
    ],
  },
  {
    id: "weather",
    name: "Weather",
    category: "environment",
    tagline: "The forecast for where you actually are.",
    dataNote:
      "Sends your coordinates to api.open-meteo.com, or your city name to its geocoder. If neither is set, it asks ipapi.co to guess from your IP address — that is the one that reveals roughly where you are to a third party.",
    provides: "Temperature, conditions, sunrise and sunset, and rain warnings.",
    needs: [
      {
        kind: "net.read",
        reason: "Look up the forecast.",
        hosts: ["api.open-meteo.com", "geocoding-api.open-meteo.com", "ipapi.co"],
      },
      {
        kind: "location",
        reason: "Use the coordinates you set, or guess them from your IP.",
      },
    ],
    config: [
      {
        key: "weather.latitude",
        label: "Latitude",
        hint: "Decimal degrees. Set this and your IP is never used.",
        kind: "number",
        example: "22.5431",
      },
      {
        key: "weather.longitude",
        label: "Longitude",
        hint: "Decimal degrees.",
        kind: "number",
        example: "114.0579",
      },
      {
        key: "weather.place",
        label: "Place name",
        hint: "Shown on the card. Cosmetic only.",
        kind: "text",
        example: "Shenzhen",
      },
    ],
  },
  {
    id: "tasks",
    name: "Todoist",
    category: "life",
    // Core: the local task list always works. The hosted list is the optional
    // half, and it is where the network read lives.
    core: true,
    tagline: "Your hosted task list, read alongside the local one.",
    dataNote:
      "Sends your Todoist token to api.todoist.com, and nothing else. Tasks Xana creates stay local. Your own tasks need none of this.",
    provides: "Hosted tasks in the same triage as local ones.",
    needs: [
      { kind: "local.read", reason: "Read your own task list." },
    ],
    // Both are needed: a token with no network read fetches nothing, and a
    // network read with no token has nothing to authenticate with. `needsAll`
    // defaults to true, and this entry is why the default is what it is.
    optional: [
      { kind: "account", reason: "Hold your Todoist API token." },
      {
        kind: "net.read",
        reason: "Read your task list.",
        hosts: ["api.todoist.com"],
      },
    ],
    config: [
      {
        key: "tasks.token",
        label: "Todoist API token",
        hint: "Todoist, then Settings, then Integrations, then API token.",
        kind: "secret",
        where: "https://todoist.com/app/settings/integrations",
      },
    ],
  },
  {
    id: "notes",
    name: "Notes folder",
    category: "knowledge",
    core: true,
    tagline: "A folder of Markdown she can read, and write to.",
    dataNote:
      "Reads .md files from a folder on this machine. Nothing leaves it. Her own notes in the database are always read.",
    provides: "Your notes as recall, and somewhere to write when you ask her to remember.",
    needs: [
      { kind: "local.read", reason: "Read the Markdown files in your vault." },
    ],
    optional: [
      { kind: "local.write", reason: "Append to a note when you ask her to remember something." },
    ],
    config: [
      {
        key: "notes.vault",
        label: "Vault folder",
        hint: "An absolute path to a folder of .md files.",
        kind: "path",
        example: "C:\\Users\\you\\Documents\\Vault",
      },
    ],
    writesBack: true,
  },
  {
    id: "health",
    name: "Health export",
    category: "life",
    core: true,
    tagline: "Sleep and activity from a folder of exports.",
    dataNote:
      "Reads JSON and CSV exports from a folder on this machine. Nothing leaves it. Readings you log by hand are always kept.",
    provides: "Sleep average, sleep debt and mood trend, which feed the energy forecast.",
    needs: [
      { kind: "local.read", reason: "Read your Apple Health or Google Fit export." },
    ],
    config: [
      {
        key: "health.folder",
        label: "Export folder",
        hint: "Where the JSON and CSV exports live.",
        kind: "path",
        example: "C:\\Users\\you\\Health",
      },
    ],
  },
  {
    id: "media",
    name: "Now playing",
    category: "signal",
    core: true,
    tagline: "What is playing, from a local player bridge.",
    dataNote:
      "Reads a local file you point at, or asks a local endpoint. Nothing leaves this machine unless the endpoint is remote, which is why the endpoint needs permission and the file does not. The focus suggestion works with no bridge at all.",
    provides: "The current track, and a focus suggestion matched to your energy.",
    needs: [
      { kind: "local.read", reason: "Read the now-playing file." },
    ],
    optional: [
      {
        kind: "net.read",
        reason: "Ask the now-playing endpoint.",
        hosts: ["the endpoint URL you provide"],
      },
      { kind: "local.write", reason: "Keep the focus suggestion in her own store." },
    ],
    config: [
      {
        key: "media.url",
        label: "Endpoint URL",
        hint: "Returns a title and an artist. Needs network permission.",
        kind: "url",
        example: "http://127.0.0.1:9863/now",
      },
      {
        key: "media.file",
        label: "or a file",
        hint: "The same JSON, read from disk. Needs no permission.",
        kind: "path",
      },
    ],
  },
  {
    id: "mail",
    name: "Mail",
    category: "signal",
    core: true,
    tagline: "Recent message subjects, from a bridge you run.",
    dataNote:
      "Reads a local JSON file you point at, or asks a local endpoint. Subject lines only — Xana never reads bodies. The file stays on this machine; the endpoint needs permission because it is a request, not a file.",
    provides: "Urgent messages worth raising before you ask.",
    needs: [
      { kind: "local.read", reason: "Read the mail file." },
    ],
    optional: [
      {
        kind: "net.read",
        reason: "Ask the mail endpoint.",
        hosts: ["the endpoint URL you provide"],
      },
    ],
    config: [
      {
        key: "mail.url",
        label: "Endpoint URL",
        hint: "Returns a list of messages. Needs network permission.",
        kind: "url",
      },
      {
        key: "mail.file",
        label: "or a file",
        hint: "The same JSON, read from disk. Needs no permission.",
        kind: "path",
      },
    ],
  },
  {
    id: "markets",
    name: "Markets",
    category: "signal",
    tagline: "Quotes for the symbols you follow.",
    dataNote:
      "Requests the symbols you list from stooq.com. The list is visible to them; nothing else is sent.",
    provides: "A line on the symbols you follow, when something moves.",
    needs: [
      {
        kind: "net.read",
        reason: "Fetch quotes.",
        hosts: ["stooq.com"],
      },
    ],
    config: [
      {
        key: "markets.symbols",
        label: "Symbols",
        hint: "Stooq tickers, comma separated.",
        kind: "text",
        example: "aapl.us, msft.us, btcusd",
        required: true,
      },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Boot contract                                                      */
/* ------------------------------------------------------------------ */

/**
 * Refuse to start if a plugin declares something the app cannot store, or
 * claims an exemption it is not entitled to.
 *
 * Four checks, all of them about a mismatch that would otherwise be silent:
 *
 *  - a capability with no entry in the settings allowlist, which makes the
 *    plugin impossible to allow — it would sit at "waiting for permission"
 *    forever and look like a bug in the permission screen;
 *  - a config key outside `PLUGIN_SETTING_KEYS`, which the save path rejects,
 *    so the field would appear, accept typing, and never persist;
 *  - a duplicate id, which makes the life state's status rows ambiguous;
 *  - **`core: true` on a plugin that leaves the machine.** This is the one that
 *    matters most. `core` is how a plugin skips the gate entirely, so it is
 *    exactly the flag someone would reach for when a plugin "does not work
 *    until you allow it" — and using it on an integration would silently
 *    delete the consent requirement that the whole system exists to enforce.
 *    A core plugin may read Xana's own database and nothing else.
 */
function assertBootContract(entries: readonly PluginEntry[]): void {
  const knownCaps = new Set<string>(CAPABILITY_KEYS);
  const knownKeys = new Set<string>(PLUGIN_SETTING_KEYS);
  const seen = new Set<string>();
  const problems: string[] = [];

  for (const entry of entries) {
    const d = entry.descriptor;
    if (seen.has(d.id)) problems.push(`duplicate plugin id "${d.id}"`);
    seen.add(d.id);

    /**
     * The required list: allowlist, hosts, and the core rule.
     *
     * The core check walks *only* this list. `core` is what exempts a plugin
     * from the gate, and the exemption is only sound because a core plugin's
     * required capabilities are local by construction — so `needs` is exactly
     * the list that must not leave the machine. Everything optional (an ICS
     * feed, a Todoist token) is gated like any other plugin's, which is why
     * declaring it under `optional` is correct and declaring it under `needs`
     * is the mistake this catches.
     */
    for (const spec of d.needs) {
      if (!knownCaps.has(spec.kind)) {
        problems.push(`${d.id} needs capability "${spec.kind}", which is not storable`);
      }
      if (spec.kind === "net.read" || spec.kind === "net.write") {
        if (!spec.hosts || spec.hosts.length === 0) {
          problems.push(`${d.id} asks for ${spec.kind} without naming a host`);
        }
      }
      if (d.core && capabilityLeaves(spec.kind)) {
        problems.push(
          `${d.id} is marked core but requires "${spec.kind}", which leaves the machine. ` +
            `Core means "reads Xana's own store". Move it to \`optional\` so it is gated.`,
        );
      }
    }

    /**
     * The optional list: allowlist and hosts only.
     *
     * A host is required for anything optional that reaches the network, for
     * the same reason as above: the user is being asked to allow a specific
     * address, and "the internet" is not something anyone can consent to.
     */
    for (const spec of d.optional ?? []) {
      if (!knownCaps.has(spec.kind)) {
        problems.push(`${d.id} needs capability "${spec.kind}", which is not storable`);
      }
      if (spec.kind === "net.read" || spec.kind === "net.write") {
        if (!spec.hosts || spec.hosts.length === 0) {
          problems.push(`${d.id} asks for ${spec.kind} without naming a host`);
        }
      }
    }

    for (const item of d.config ?? []) {
      if (!knownKeys.has(item.key)) {
        problems.push(`${d.id} declares setting "${item.key}", which is not in PLUGIN_SETTING_KEYS`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Plugin register is inconsistent:\n  - ${problems.join("\n  - ")}\n` +
        `Fix the descriptor, or add the missing name to settings/types.ts.`,
    );
  }
}

/**
 * Does this capability send data off the machine?
 *
 * Duplicated from `CAPABILITY_INFO[kind].leaves` rather than imported, because
 * this is a *guard*: if the two ever disagree the safe answer is the stricter
 * one, and a guard that reads its own rules from the thing it is guarding is
 * not a guard. A new capability defaults to `true` here — see the `default`
 * branch — so forgetting to classify one blocks `core` rather than permitting
 * it.
 */
function capabilityLeaves(kind: CapabilityKind): boolean {
  switch (kind) {
    case "local.read":
    case "local.write":
    case "account":
      return false;
    case "net.read":
    case "net.write":
    case "location":
    case "remote.write":
      return true;
    default:
      return true;
  }
}

/* ------------------------------------------------------------------ */
/* The registry                                                       */
/* ------------------------------------------------------------------ */

export class PluginRegistry {
  private plugins: PluginEntry[];
  private opts: PluginRegistryOptions;

  constructor(opts: PluginRegistryOptions = {}) {
    this.opts = opts;
    this.plugins = buildPlugins(opts);
    assertBootContract(this.plugins);
  }

  /** Every plugin, for the settings list. */
  list(): PluginEntry[] {
    return this.plugins;
  }

  /**
   * Last-known status for every plugin, with no I/O.
   *
   * This is what the cheap presence loop reports. A plugin that has never run
   * reads as `offline` — or `blocked`, which is the more useful answer and the
   * reason this method consults consent rather than only the adapter.
   */
  statuses(): AdapterStatus[] {
    return this.plugins.map((plugin) => {
      const st = plugin.state();
      if (st) return st;
      const verdict = plugin.missing();
      const { id, name } = plugin.descriptor;
      // A plugin that has never run but is allowed reads as `offline`; one that
      // is not allowed reads as `blocked`. Same vocabulary as the plugin list,
      // so the header dots and the Settings panel cannot disagree.
      if (verdict.length > 0) {
        return {
          id,
          label: name,
          state: "blocked" as const,
          mode: "local" as const,
          detail: blockedDetail(verdict),
        };
      }
      return {
        id,
        label: name,
        state: "offline" as const,
        mode: "local" as const,
        detail: "not yet read",
      };
    });
  }

  /**
   * Run every permitted plugin into one freshly merged snapshot.
   *
   * `runPlugin` is what enforces consent, so this loop does not need to know
   * about permissions at all: a blocked plugin returns a status row and writes
   * nothing into the snapshot. Two properties follow, and both matter:
   * the status array always has one row per plugin, so the UI cannot lose a
   * row when something is switched off, and a plugin that is off contributes
   * no data rather than stale data.
   */
  async collect(): Promise<LifeSnapshot> {
    const snapshot = emptySnapshot();

    const results = await Promise.allSettled(
      this.plugins.map((plugin) => runPlugin(plugin, snapshot)),
    );

    const statuses: AdapterStatus[] = results.map((r, i) => {
      if (r.status === "fulfilled") return r.value.status;
      // A rejected promise means the policy layer itself threw, which no
      // plugin can cause. Substitute a row so the counts still line up.
      const { id, name } = this.plugins[i].descriptor;
      return {
        id,
        label: name,
        state: "error" as const,
        mode: "local" as const,
        detail: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    });

    snapshot.statuses = statuses;
    return snapshot;
  }

  /** Status rows for the plugin panel, with real provenance and no I/O. */
  pluginStatuses() {
    return this.plugins.map((plugin) => plugin.status());
  }

  /**
   * Drop every plugin's cached slice.
   *
   * This is what makes a write-back visible immediately: after Xana creates a
   * task, the tasks plugin's cache is stale by definition, and waiting for its
   * TTL would show the user a list that contradicts what she just said.
   */
  invalidate(): void {
    for (const plugin of this.plugins) plugin.invalidate();
  }

  /** Run one plugin by id, freshly. Used by the connect flow and tests. */
  async refresh(id: string): Promise<AdapterStatus | undefined> {
    const plugin = this.plugins.find((p) => p.descriptor.id === id);
    if (!plugin) return undefined;
    plugin.invalidate();
    const snapshot = emptySnapshot();
    const result = await runPlugin(plugin, snapshot);
    return result.status;
  }
}

/**
 * Build the plugin set, and publish it to the register.
 *
 * The register is a module-level map in `automation.ts` rather than a field on
 * this class, because `mayWriteRemotely` and the permission writes need to find
 * a plugin by id and cannot import this module without a cycle. So building the
 * set and publishing it are two steps, and this function does both — a plugin
 * that exists but is not registered would be invisible to the write gate, which
 * is the kind of half-wired state that shows up as "write refused, no reason
 * given" much later.
 */
function buildPlugins(opts: PluginRegistryOptions): PluginEntry[] {
  const band = opts.band ?? (() => "steady");
  const people = opts.knownPeople ?? (() => []);

  const entries: PluginEntry[] = [];

  for (const descriptor of DESCRIPTORS) {
    entries.push(
      registerPlugin(
        definePlugin({
          descriptor,
          adapter: (gates) => adapterFor(descriptor.id, gates, band, people),
        }),
      ),
    );
  }

  entries.push(registerPlugin(googleCalendarPlugin()));
  return entries;
}

/**
 * The adapter behind each descriptor, by id.
 *
 * `gates` is what the plugin layer decided this plugin may do. Each adapter is
 * handed the part that concerns it, and nothing else: the ICS feed reads
 * `gates.network`, Todoist reads it too, and a write path reads `gates.remote`.
 * An adapter never consults the settings file to find out whether it is
 * allowed — it is told, once, at construction, by the code whose job that is.
 */
function adapterFor(
  id: string,
  gates: PluginGates,
  band: () => EnergyBand,
  people: () => string[],
) {
  switch (id) {
    case "calendar":
      return calendarAdapter({ mayFetch: gates.network });
    case "weather":
      return weatherAdapter();
    case "tasks":
      return tasksAdapter({ mayFetch: gates.network });
    case "notes":
      // No gate passed, and that is correct: this adapter only reads. The
      // vault write-back lives in the knowledge module's own function, reached
      // from the action executor, and is gated there.
      return knowledgeAdapter();
    case "health":
      return healthAdapter();
    case "media":
      return mediaAdapter({ band, mayFetch: gates.network });
    case "mail":
      return mailAdapter({ knownPeople: people, mayFetch: gates.network });
    case "markets":
      return financeAdapter();
    default:
      throw new Error(`No adapter for plugin "${id}"`);
  }
}

let singleton: PluginRegistry | undefined;

/**
 * Process-wide registry. `band` and `knownPeople` are read lazily through the
 * accessors passed in, so the registry never has to import the derived layer
 * that imports it.
 */
export function getRegistry(opts: PluginRegistryOptions = {}): PluginRegistry {
  if (!singleton) singleton = new PluginRegistry(opts);
  return singleton;
}

/**
 * Let `automation.ts` build the register without importing this module.
 *
 * Called at import time, below. Registering the installer immediately rather
 * than on first use is deliberate: it means `GET /api/plugins` gets a real list
 * on its very first request, without having to know that the life-state
 * gateway is what usually warms this.
 */
setRegisterInstaller(() => {
  getRegistry();
});

/** Drop the singleton. Tests use this to rebuild with a fresh store. */
export function resetRegistry(): void {
  singleton = undefined;
}

export type { LifeSnapshot, PluginEntry, CapabilityKind };
export { allPlugins };
