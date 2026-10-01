/**
 * Xana's settings.
 *
 * Three sources, in strict precedence, resolved in exactly one place:
 *
 *   1. **The settings file** (`.xana/settings.json`) —what the user chose
 *      in the UI. Highest precedence, because an explicit choice must beat
 *      whatever happens to be in the shell.
 *   2. **The process environment** —`.env`, exported variables, a
 *      container's secret store. This is how a key gets in without ever
 *      being written to disk.
 *   3. **Defaults** —always something sensible.
 *
 * WHY A FILE AND NOT JUST `.env`
 *
 * The whole point of the settings surface is that the user never has to
 * hand-edit a dotfile or restart a server. A `.env` file cannot be written
 * from the running app, is not reloaded by the dev server mid-session, and
 * is the wrong shape for a stored preference like "speed the motion up".
 * So: secrets and preferences both land in one JSON file that the app owns.
 *
 * The file is written `0600` where the platform supports it (it holds API
 * keys), atomically via a temp file and a rename (so a crash mid-write
 * cannot leave a truncated JSON document that bricks the app on boot), and
 * it is gitignored.
 *
 * NOTHING HERE IS CACHED ACROSS A WRITE. `loadSettings()` reads the file
 * and memoises on mtime, so a change made by an external editor is picked
 * up on the next read, and a change made through the API is visible to the
 * very next `cred()` call.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_THEME_ID, findTheme, findThemeByAccents, safeAccent } from "./themes";
import { normaliseEndpoint } from "./endpoints";
import {
  canonicalBaseUrl,
  findProvider,
  inferShape,
  matchProvider,
  shapeFromPath,
} from "./providers";
import {
  CAPABILITY_KEYS,
  KEEP_KEY,
  PLUGIN_SETTING_KEYS,
  SOURCE_GROUPS,
  type ModelSettings,
  type PermissionSettings,
  type SecretView,
  type SettingsPatch,
  type SettingsView,
  type SourceSettings,
  type XanaSettings,
} from "./types";

/**
 * Maps an environment variable name to the provider preset it implies.
 *
 * One table, consulted once. Its job is to stop the most confusing possible
 * failure: a user exports `DEEPSEEK_API_KEY`, Xana sees a key, sends it to
 * the default OpenAI endpoint, and the provider answers 401. Naming the
 * provider from the variable means the key and the endpoint always agree.
 */
const ENV_KEY_PRESETS: Record<string, string> = {
  DEEPSEEK_API_KEY: "deepseek",
  OPENAI_API_KEY: "openai",
  ANTHROPIC_API_KEY: "anthropic",
  GROQ_API_KEY: "groq",
  OPENROUTER_API_KEY: "openrouter",
  TOGETHER_API_KEY: "together",
};

/** The base URL for a wire format, when nothing else has decided one. */
function defaultBaseUrl(shape: ModelSettings["provider"]): string {
  return shape === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
}

/** The model for a wire format, when nothing else has decided one. */
function defaultModelFor(shape: ModelSettings["provider"]): string {
  return shape === "anthropic" ? "claude-3-5-haiku-latest" : "gpt-4o-mini";
}

export type {
  AccentChannels,
  AppearanceSettings,
  CapabilityKey,
  IdentitySettings,
  ModelProvider,
  ModelSettings,
  PermissionSettings,
  SettingsPatch,
  SettingsView,
  SourceField,
  SourceGroup,
  SourceSettings,
  VoiceSettings,
  XanaSettings,
} from "./types";

/**
 * Re-exported so server code has one import for everything settings-shaped.
 *
 * The split is not cosmetic. `types.ts` and `providers.ts` are free of
 * `node:fs`, which is what lets the settings screen be a client component:
 * importing these constants from this file would pull the filesystem into
 * the browser bundle through the back door.
 *
 * The provider registry used to live in `types.ts` as a list of presets
 * with a parallel pair of `Record<provider, string>` maps beside it. The
 * presets and the maps could disagree, and the request builder had its own
 * third copy of the fallbacks. `providers.ts` is now the single source.
 */
export { DEFAULT_PERSONA, KEEP_KEY, SOURCE_GROUPS } from "./types";
export { PROVIDERS } from "./providers";
export type { ProviderPreset } from "./providers";
export { CAPABILITY_KEYS } from "./types";

export const DEFAULT_SETTINGS: XanaSettings = {
  identity: { name: "", location: "", latitude: "", longitude: "" },
  appearance: {
    theme: DEFAULT_THEME_ID,
    accent: (findTheme(DEFAULT_THEME_ID) as { accent: string }).accent,
    accent2: (findTheme(DEFAULT_THEME_ID) as { accent2: string }).accent2,
    ambient: 0.13,
    motionSpeed: 1,
  },
  voice: {
    speakReplies: false,
    voiceName: "",
    rate: 1,
    pitch: 1,
    persona: "",
    // Off, because it holds the microphone open. See `VoiceSettings`.
    wakeEnabled: false,
    // Empty means the built-in phrase list in `wake-word.ts`.
    wakePhrases: "",
  },
  /**
   * The model defaults to DeepSeek, and to *switched off*.
   *
   * DeepSeek because it is the cheapest credible hosted option and the one
   * this project was asked for by name; a fresh install that the user
   * decides to give a key to should not also require them to change the
   * provider. Switched off because a key in the environment is not consent
   * to spend it —see `modelActive()`.
   *
   * The base URL is left empty so `resolveModel` can tell "not chosen" from
   * "chosen", which is what lets a `DEEPSEEK_API_KEY` in the environment
   * select the endpoint without fighting a stored default.
   */
  model: {
    enabled: false,
    provider: "openai",
    model: (findProvider("deepseek") as { defaultModel: string }).defaultModel,
    apiKey: "",
    baseUrl: "",
    temperature: 0.7,
  },
  sources: {},
  /**
   * Nothing is granted on a fresh install.
   *
   * The empty object is the whole consent model in one line: no plugin reaches
   * the network, no plugin reads a folder, until the user opens the Plugins
   * panel and allows it. Contrast the model key, which is merely disabled —
   * this one is structurally absent, so a bug in a plugin cannot read a
   * default that happens to be permissive.
   */
  permissions: {},
};

/* ------------------------------------------------------------------ */
/* Loading and saving                                                 */
/* ------------------------------------------------------------------ */

/**
 * Where the settings file lives.
 *
 * Alongside the SQLite store in `<project>/data`, rather than in a
 * directory of its own: both are Xana's own state, both are safe to
 * delete, and one place to look is one place to back up or to explain.
 *
 * `XANA_DATA_DIR` moves both, which is what a read-only install or a
 * container with a mounted volume needs.
 */
const DATA_DIR = process.env.XANA_DATA_DIR?.trim() || join(process.cwd(), "data");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");

/** Written briefly by an earlier build. Moved on first read. */
const LEGACY_SETTINGS_FILE = join(process.cwd(), ".xana", "settings.json");

/**
 * Move a settings file left by an earlier version into place.
 *
 * One `rename` on first read, and the failure mode if it does not happen
 * is that the user's API key silently disappears —which is exactly the
 * kind of thing that is worth ten lines to prevent. A no-op on every
 * subsequent boot.
 */
function migrateLegacySettings(): void {
  try {
    if (existsSync(SETTINGS_FILE) || !existsSync(LEGACY_SETTINGS_FILE)) return;
    mkdirSync(DATA_DIR, { recursive: true });
    renameSync(LEGACY_SETTINGS_FILE, SETTINGS_FILE);
  } catch {
    // If the move fails, `loadSettings` simply falls back to defaults. It
    // must never be the reason the app does not start.
  }
}

let cached: XanaSettings = DEFAULT_SETTINGS;
let cachedMtime = -1;
let loaded = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return value < min ? min : value > max ? max : value;
}

/**
 * Coerce anything into valid settings.
 *
 * Every field is clamped or defaulted rather than validated-and-rejected,
 * because the input could come from a hand-edited file, an older version
 * of the app, or an HTTP body. A rejected load would leave the user with
 * no settings at all; a coerced load leaves them with a working app and
 * one field reset.
 */
export function coerceSettings(raw: unknown): XanaSettings {
  const root = isRecord(raw) ? raw : {};
  const identity = isRecord(root.identity) ? root.identity : {};
  const appearance = isRecord(root.appearance) ? root.appearance : {};
  const voice = isRecord(root.voice) ? root.voice : {};
  const model = isRecord(root.model) ? root.model : {};
  const sources = isRecord(root.sources) ? root.sources : {};

  const themeId = str(appearance.theme, DEFAULT_SETTINGS.appearance.theme);
  const preset = findTheme(themeId);

  const providerRaw = str(model.provider, DEFAULT_SETTINGS.model.provider);
  const provider: ModelSettings["provider"] =
    providerRaw === "anthropic" ? "anthropic" : "openai";

  const cleanSources: SourceSettings = {};
  for (const [key, value] of Object.entries(sources)) {
    if (typeof value === "string") cleanSources[key] = value;
  }

  /**
   * Grants, coerced the same way as everything else.
   *
   * Only the known capabilities survive, and only as booleans. The settings
   * file is hand-editable by design, so this reads it as hostile input: a
   * `"net.read": "yes"` from a user who assumed YAML-ish truthiness must not
   * be a grant, because the grant check is `=== true` and a value that looks
   * on in the editor but reads off in the code is the worst of both.
   */
  const permissions: PermissionSettings = {};
  const rawPermissions = isRecord(root.permissions) ? root.permissions : {};
  for (const key of CAPABILITY_KEYS) {
    if (rawPermissions[key] === true) permissions[key] = true;
  }

  return {
    identity: {
      name: str(identity.name, "").slice(0, 60),
      location: str(identity.location, "").slice(0, 80),
      latitude: str(identity.latitude, "").slice(0, 24),
      longitude: str(identity.longitude, "").slice(0, 24),
    },
    appearance: {
      theme: themeId,
      // A preset id always wins, so switching presets cannot leave a stale
      // custom accent behind. "custom" keeps whatever channels are stored.
      accent: preset
        ? preset.accent
        : safeAccent(str(appearance.accent, ""), 0),
      accent2: preset
        ? preset.accent2
        : safeAccent(str(appearance.accent2, ""), 1),
      ambient: num(appearance.ambient, DEFAULT_SETTINGS.appearance.ambient, 0, 0.3),
      motionSpeed: num(appearance.motionSpeed, 1, 0.25, 2),
    },
    voice: {
      speakReplies: bool(voice.speakReplies, false),
      voiceName: str(voice.voiceName, "").slice(0, 120),
      rate: num(voice.rate, 1, 0.5, 1.5),
      pitch: num(voice.pitch, 1, 0, 2),
      persona: str(voice.persona, "").slice(0, 8000),
      wakeEnabled: bool(voice.wakeEnabled, false),
      // Capped well below the field limit: this is a handful of words, and a
      // megabyte of phrase list would be fed to the matcher on every interim
      // transcript.
      wakePhrases: str(voice.wakePhrases, "").slice(0, 300),
    },
    model: {
      enabled: bool(model.enabled, false),
      provider,
      model: str(model.model, defaultModelFor(provider)).slice(0, 120),
      apiKey: str(model.apiKey, "").slice(0, 400),
      baseUrl: str(model.baseUrl, "").slice(0, 400),
      temperature: num(model.temperature, 0.7, 0, 2),
    },
    sources: cleanSources,
    permissions,
  };
}

/** Read the file, memoised on mtime so an external edit is still seen. */
export function loadSettings(): XanaSettings {
  try {
    migrateLegacySettings();
    if (!existsSync(SETTINGS_FILE)) {
      if (!loaded) {
        loaded = true;
        cached = DEFAULT_SETTINGS;
      }
      return cached;
    }
    const mtime = statSync(SETTINGS_FILE).mtimeMs;
    if (loaded && mtime === cachedMtime) return cached;

    const text = readFileSync(SETTINGS_FILE, "utf8");
    cached = coerceSettings(JSON.parse(text) as unknown);
    cachedMtime = mtime;
    loaded = true;
    return cached;
  } catch {
    // A corrupt or unreadable file must not take the app down. Defaults
    // are always a working configuration.
    return loaded ? cached : DEFAULT_SETTINGS;
  }
}

export interface SaveResult {
  ok: boolean;
  /** Why it failed, in a sentence the UI can show. */
  error?: string;
}

/** Write settings to disk, atomically. */
export function saveSettings(next: XanaSettings): SaveResult {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const temp = `${SETTINGS_FILE}.${process.pid}.tmp`;
    // `mode: 0o600` is honoured on POSIX and ignored on Windows; the file
    // holds API keys, so it is worth asking even where it does nothing.
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    // Rename is atomic within a filesystem, so a reader never observes a
    // half-written document.
    renameSync(temp, SETTINGS_FILE);
    cached = next;
    try {
      cachedMtime = statSync(SETTINGS_FILE).mtimeMs;
    } catch {
      cachedMtime = Date.now();
    }
    loaded = true;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Where the file lives, for the UI to show and for error messages. */
export function settingsPath(): string {
  return SETTINGS_FILE;
}

/** Force the next read to hit the disk. Used by tests. */
export function invalidateSettingsCache(): void {
  cachedMtime = -1;
  loaded = false;
}

/* ------------------------------------------------------------------ */
/* Credentials                                                        */
/* ------------------------------------------------------------------ */

export interface SettingCredential {
  value: string;
  present: boolean;
  /** Which layer answered. Adapters report this so the UI can be honest. */
  from: "settings" | "env" | "none";
}

const ABSENT: SettingCredential = { value: "", present: false, from: "none" };

/**
 * Look up a credential.
 *
 * Order is settings, then environment. A blank entry in either layer is
 * treated as absent rather than as an intentional empty string: "unset"
 * and "set to nothing" mean the same thing to an API client, and treating
 * a blank as authoritative would silently break an env-var fallback.
 */
export function credential(...names: string[]): SettingCredential {
  const settings = loadSettings();

  for (const name of names) {
    const stored = settings.sources[name];
    if (typeof stored === "string" && stored.trim().length > 0) {
      return { value: stored.trim(), present: true, from: "settings" };
    }
  }

  for (const name of names) {
    const raw = process.env[name];
    if (typeof raw === "string" && raw.trim().length > 0) {
      return { value: raw.trim(), present: true, from: "env" };
    }
  }

  return ABSENT;
}

/* ------------------------------------------------------------------ */
/* The client view                                                    */
/* ------------------------------------------------------------------ */

/**
 * `SettingCredential` is the internal shape; `SecretView` (imported from
 * types.ts, and therefore safe to hand to the browser) carries only the
 * mask. The split is the whole point: `maskSecret` is applied here, once,
 * and no path exists that puts a raw key into a response body.
 */
export function maskSecret(value: string): string {
  if (value.length === 0) return "";
  const tail = value.slice(-4);
  const dots = "\u2022".repeat(Math.max(4, Math.min(12, value.length - 4)));
  return `${dots}${tail}`;
}

/**
 * The settings as the browser should see them.
 *
 * The API key is replaced by a presence flag and a mask. The key itself is
 * never sent to the client, which is the only way to be sure it cannot
 * leak into a screenshot, a browser cache, or a devtools session.
 */
export function settingsView(): SettingsView {
  const settings = loadSettings();
  const resolved = resolveModel();

  const sourceSecrets: Record<string, SecretView> = {};
  const sourceValues: SourceSettings = {};
  for (const group of SOURCE_GROUPS) {
    for (const field of group.fields) {
      const found = credential(field.key);
      if (field.kind === "secret") {
        sourceSecrets[field.key] = {
          present: found.present,
          masked: found.present ? maskSecret(found.value) : "",
          from: found.from,
        };
      } else {
        // Only the stored value is echoed, never an environment value: the
        // form must not silently promote an env var into the settings file
        // just because the user opened the panel.
        sourceValues[field.key] = settings.sources[field.key] ?? "";
      }
    }
  }

  return {
    identity: settings.identity,
    appearance: settings.appearance,
    voice: settings.voice,
    model: {
      enabled: settings.model.enabled,
      provider: settings.model.provider,
      model: settings.model.model,
      apiKey: {
        present: resolved.apiKey.length > 0,
        masked: resolved.apiKey.length > 0 ? maskSecret(resolved.apiKey) : "",
        from: resolved.keyFrom,
      },
      baseUrl: settings.model.baseUrl,
      temperature: settings.model.temperature,
    },
    sourceSecrets,
    sourceValues,
    permissions: settings.permissions,
    modelReady: resolved.apiKey.length > 0,
    effective: {
      provider: resolved.provider,
      model: resolved.model,
      baseUrl: resolved.baseUrl,
      active: settings.model.enabled && resolved.apiKey.length > 0,
    },
    settingsPath: SETTINGS_FILE,
  };
}

/* ------------------------------------------------------------------ */
/* The resolved model configuration                                   */
/* ------------------------------------------------------------------ */

export interface ResolvedModel {
  provider: ModelSettings["provider"];
  model: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
  /** False when the user has switched the model off, whatever keys exist. */
  enabled: boolean;
  /** Where the key came from, for the settings screen and the demo output. */
  keyFrom: SettingCredential["from"];
}

/**
 * Resolve the model configuration the way `llm.ts` needs it.
 *
 * This is the one place precedence is decided, and it resolves three
 * separate questions in a fixed order:
 *
 *  1. **The key.** A key typed into the UI wins over the environment. A
 *     provider-specific environment variable is recognised by name, so
 *     `DEEPSEEK_API_KEY` in the environment configures DeepSeek without the
 *     user having to also pick the provider.
 *  2. **The shape.** An explicit choice wins; failing that the endpoint
 *     the user pasted decides, since `/v1/messages` is Anthropic's and a
 *     hostname containing "anthropic" is theirs too.
 *  3. **The base URL.** Normalised, so any of the three shapes a provider
 *     documents works. Then a missing `/v1` is added for known hosted
 *     providers only, never for an unknown host where it would be a guess.
 *
 * The environment-proxy inference is the subtle part. If the only key
 * present is `DEEPSEEK_API_KEY`, then the user's intent is DeepSeek, and
 * silently sending that key to `api.openai.com` would fail with a 401 they
 * could not explain. So the key's own name selects the provider.
 */
export function resolveModel(): ResolvedModel {
  const settings = loadSettings();
  const model = settings.model;

  const explicitKey = model.apiKey.trim();

  /**
   * Environment keys, ordered most-specific first. A generic
   * `XANA_LLM_API_KEY` is an explicit "use this for whatever I configured",
   * so it outranks a provider-branded variable. Each entry names the
   * provider it implies, so a branded variable also selects the endpoint.
   */
  const envCandidates: { names: string[] }[] = [
    { names: ["XANA_LLM_API_KEY"] },
    { names: ["DEEPSEEK_API_KEY"] },
    { names: ["ANTHROPIC_API_KEY"] },
    { names: ["OPENAI_API_KEY"] },
    { names: ["GROQ_API_KEY"] },
    { names: ["OPENROUTER_API_KEY"] },
    { names: ["TOGETHER_API_KEY"] },
  ];

  let envKey = { value: "", present: false, from: "none" as SettingCredential["from"] };
  let envKeyName: string | undefined;
  for (const candidate of envCandidates) {
    const found = credential(...candidate.names);
    if (found.present) {
      envKey = found;
      // Which of the candidate's names actually answered, so the preset can
      // be resolved from the variable rather than from a second table.
      envKeyName = candidate.names.find((name) => process.env[name]?.trim());
      break;
    }
  }

  const apiKey = explicitKey || envKey.value;
  const keyFrom: SettingCredential["from"] = explicitKey ? "settings" : envKey.from;

  /**
   * Which endpoint the environment key implies. Only consulted when the
   * user has not chosen a base URL: if they have typed one, that is their
   * answer and a stray environment variable must not override it.
   *
   * The mapping is by environment variable name, so adding a provider to
   * the registry is all it takes to have its `*_API_KEY` recognised.
   */
  const envPreset =
    !model.baseUrl.trim() && envKeyName ? findProvider(ENV_KEY_PRESETS[envKeyName] ?? "") : undefined;

  const shape: ModelSettings["provider"] =
    model.provider === "anthropic" || model.provider === "openai"
      ? model.provider
      : (inferShape(model.baseUrl) ?? envPreset?.shape ?? "openai");

  const rawBase = model.baseUrl.trim() || envPreset?.baseUrl || defaultBaseUrl(shape);
  const baseUrl = canonicalBaseUrl(rawBase) || defaultBaseUrl(shape);

  const preset = matchProvider(baseUrl, model.model);
  const modelName = model.model.trim() || preset?.defaultModel || defaultModelFor(shape);

  return {
    provider: shape,
    model: modelName,
    baseUrl,
    apiKey,
    temperature: model.temperature,
    enabled: model.enabled,
    keyFrom,
  };
}

/**
 * Whether a model should answer. Both conditions are required: a key, and
 * the user having left the feature on. Someone who has a key in their
 * environment for another tool has not thereby opted Xana into using it.
 */
export function modelActive(): boolean {
  const resolved = resolveModel();
  return resolved.enabled && resolved.apiKey.length > 0;
}

/* ------------------------------------------------------------------ */
/* Patch normalisation                                                */
/* ------------------------------------------------------------------ */

/**
 * Merge a patch onto the current settings.
 *
 * This is the only function that turns client input into stored state, so
 * it is the only place that has to be careful. It never trusts a field it
 * does not recognise, never accepts a secret of the wrong shape, and
 * treats an absent field as "leave it" rather than as "set it to empty" — * which is what makes a partial save from one settings section safe.
 */
export function mergePatch(
  current: XanaSettings,
  patch: SettingsPatch,
): XanaSettings {
  const next: XanaSettings = {
    identity: { ...current.identity },
    appearance: { ...current.appearance },
    voice: { ...current.voice },
    model: { ...current.model },
    sources: { ...current.sources },
    permissions: { ...current.permissions },
  };

  if (patch.identity) {
    const p = patch.identity;
    if (typeof p.name === "string") next.identity.name = p.name.trim().slice(0, 60);
    if (typeof p.location === "string") next.identity.location = p.location.trim().slice(0, 80);
    if (typeof p.latitude === "string") next.identity.latitude = p.latitude.trim().slice(0, 24);
    if (typeof p.longitude === "string") next.identity.longitude = p.longitude.trim().slice(0, 24);
  }

  if (patch.appearance) {
    const p = patch.appearance;
    if (typeof p.theme === "string") {
      const preset = findTheme(p.theme);
      if (preset) {
        next.appearance.theme = preset.id;
        next.appearance.accent = preset.accent;
        next.appearance.accent2 = preset.accent2;
      } else if (p.theme === "custom") {
        next.appearance.theme = "custom";
      }
    }
    // An explicit channel triplet only ever applies to a custom theme, so
    // picking a colour by hand switches the theme to custom as a side
    // effect rather than being silently overwritten by the preset.
    if (typeof p.accent === "string" && p.accent.trim()) {
      next.appearance.accent = safeAccent(p.accent, 0);
      next.appearance.theme = "custom";
    }
    if (typeof p.accent2 === "string" && p.accent2.trim()) {
      next.appearance.accent2 = safeAccent(p.accent2, 1);
      next.appearance.theme = "custom";
    }
    if (typeof p.ambient === "number") {
      next.appearance.ambient = num(p.ambient, current.appearance.ambient, 0, 0.3);
    }
    if (typeof p.motionSpeed === "number") {
      next.appearance.motionSpeed = num(p.motionSpeed, current.appearance.motionSpeed, 0.25, 2);
    }

    // The theme id is a claim about the colours, so it is re-derived from them
    // after every appearance write rather than carried along untouched. A
    // patch that only moved the ambient slider used to leave the previous id
    // in place, which is how a store ends up calling itself "ember" while the
    // channels say something else. Nothing on screen reads this field, so the
    // drift was invisible until the settings panel started reporting it.
    const matched = findThemeByAccents(next.appearance.accent, next.appearance.accent2);
    next.appearance.theme = matched ? matched.id : "custom";
  }

  if (patch.voice) {
    const p = patch.voice;
    if (typeof p.speakReplies === "boolean") next.voice.speakReplies = p.speakReplies;
    if (typeof p.voiceName === "string") next.voice.voiceName = p.voiceName.slice(0, 120);
    if (typeof p.rate === "number") next.voice.rate = num(p.rate, current.voice.rate, 0.5, 1.5);
    if (typeof p.pitch === "number") next.voice.pitch = num(p.pitch, current.voice.pitch, 0, 2);
    if (typeof p.persona === "string") next.voice.persona = p.persona.slice(0, 8000);
    if (typeof p.wakeEnabled === "boolean") next.voice.wakeEnabled = p.wakeEnabled;
    if (typeof p.wakePhrases === "string") next.voice.wakePhrases = p.wakePhrases.slice(0, 300);
  }

  if (patch.model) {
    const p = patch.model;
    if (typeof p.enabled === "boolean") next.model.enabled = p.enabled;
    if (p.provider === "openai" || p.provider === "anthropic") {
      next.model.provider = p.provider;
    }
    if (typeof p.model === "string") next.model.model = p.model.trim().slice(0, 120);
    if (typeof p.baseUrl === "string") {
      // Stored canonical rather than as typed. The UI tidies on blur, but a
      // value can also arrive from the API directly, and a file that holds
      // three different spellings of the same endpoint is a file nobody can
      // reason about later. An empty string stays empty: it means "use the
      // provider's default", which is different from a URL.
      const raw = p.baseUrl.trim();
      if (raw) {
        const normalised = normaliseEndpoint(raw).baseUrl;
        next.model.baseUrl = canonicalBaseUrl(raw).slice(0, 400);
      } else {
        next.model.baseUrl = "";
      }
    }
    if (typeof p.temperature === "number") {
      next.model.temperature = num(p.temperature, current.model.temperature, 0, 2);
    }
    if (p.clearApiKey) {
      next.model.apiKey = "";
      // Clearing a stored key with nothing behind it leaves the model with
      // no way to authenticate, so the feature switches itself off rather
      // than failing on the next message.
      const envStillHasKey = credential(
        "XANA_LLM_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "DEEPSEEK_API_KEY",
        "GROQ_API_KEY",
      ).present;
      if (!envStillHasKey) next.model.enabled = false;
    } else if (typeof p.apiKey === "string") {
      const key = p.apiKey.trim();
      // The sentinel means "the user did not retype the field". Storing it
      // literally would replace a working key with the string "__xana_keep__".
      if (key && key !== KEEP_KEY) {
        next.model.apiKey = key.slice(0, 400);
        /**
         * Storing a key switches the model on, unless the caller said
         * otherwise in the same patch.
         *
         * A stored key with the model switched off is a state nobody means
         * to be in, and it is silent: the key is visibly saved, the panel
         * looks configured, and every reply still comes from the local
         * engine with no explanation. That is exactly the report this
         * fixes. Pasting a key *is* the statement of intent to use it.
         *
         * An explicit `enabled: false` in the same patch still wins, so
         * scripted callers keep full control.
         */
        if (typeof p.enabled !== "boolean") next.model.enabled = true;
      }
    }
  }

  if (patch.sources) {
    for (const [key, value] of Object.entries(patch.sources)) {
      if (typeof value !== "string") continue;
      if (!isKnownSourceKey(key)) continue;
      const trimmed = value.trim();
      if (trimmed) next.sources[key] = trimmed.slice(0, 500);
      else delete next.sources[key];
    }
  }

  if (patch.clearSources) {
    for (const key of patch.clearSources) {
      if (isKnownSourceKey(key)) delete next.sources[key];
    }
  }

  /**
   * Capability grants.
   *
   * Three details that matter more than they look:
   *
   *  - Only capabilities in `CAPABILITY_KEYS` are accepted, so a client cannot
   *    write an arbitrary key into the permissions map and leave a file that
   *    claims something the app can never honour.
   *  - A non-boolean is dropped, not coerced. `"false"` is truthy, and the
   *    check on the read side is `=== true`, so accepting strings here would
   *    produce a file where `"net.read": "false"` reads as *granted* to anyone
   *    inspecting the JSON and *not granted* to the code. Refusing the write is
   *    the only outcome that cannot be misread.
   *  - `false` is stored rather than deleted. Revoking a permission and never
   *    having granted one are the same to the code, but not to the person
   *    reading the file, and the audit trail is the point.
   */
  if (patch.permissions) {
    for (const key of CAPABILITY_KEYS) {
      const value = patch.permissions[key];
      if (typeof value !== "boolean") continue;
      next.permissions[key] = value;
    }
  }

  return next;
}

/** Only keys the app actually reads may be written, so a malformed patch
 *  cannot fill the settings file with junk.
 *
 *  Two namespaces resolve here. The plugin keys are the live surface: every
 *  value the Plugins panel writes goes through `savePluginSetting`. The
 *  `SOURCE_GROUPS` keys are the older flat `XANA_*` names, kept resolvable
 *  because they still work from the environment and a user who set one should
 *  be able to clear it from the UI rather than by hand-editing JSON. */
function isKnownSourceKey(key: string): boolean {
  for (const group of SOURCE_GROUPS) {
    for (const field of group.fields) {
      if (field.key === key) return true;
    }
  }
  return (PLUGIN_SETTING_KEYS as readonly string[]).includes(key);
}

/* ------------------------------------------------------------------ */
/* Plugin settings                                                    */
/* ------------------------------------------------------------------ */

export interface PluginSettingResult {
  ok: boolean;
  error?: string;
}

/**
 * Write one plugin's non-secret settings.
 *
 * A separate entry point from the generic `sources` patch because it has two
 * jobs the generic path does not: refusing keys no plugin declared, and
 * clearing by empty string. In the flat sources map an empty value meant
 * "delete"; here it means the same thing, and it has to, because clearing the
 * vault folder is how a user turns notes off without revoking the permission
 * they granted for it.
 *
 * Secrets go through here too. They are `0600` in a gitignored file, which is
 * the same custody as the model API key — one file, one place to look, one
 * thing to delete.
 */
export function savePluginSetting(values: Record<string, string>): PluginSettingResult {
  const known = new Set<string>(PLUGIN_SETTING_KEYS);
  const patch: SettingsPatch = { sources: {} };
  const clear: string[] = [];

  for (const [key, raw] of Object.entries(values)) {
    if (!known.has(key)) continue;
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value) (patch.sources as Record<string, string>)[key] = value.slice(0, 2000);
    else clear.push(key);
  }

  if (clear.length > 0) patch.clearSources = clear;
  const next = mergePatch(loadSettings(), patch);
  const result = saveSettings(next);
  return { ok: result.ok, error: result.error };
}

/**
 * Whether a plugin setting is present, and where it came from.
 *
 * `value` is returned for non-secrets only by the caller's discipline; this
 * helper is deliberately dumb so both the plugin code and the settings view
 * can use it, and the view is the one that applies `maskSecret`.
 */
export function pluginSetting(key: string, legacyNames: readonly string[] = []): SettingCredential {
  return credential(key, ...legacyNames);
}

/* ------------------------------------------------------------------ */
/* Derived: the CSS the layout injects                                */
/* ------------------------------------------------------------------ */

/**
 * The custom properties the root layout writes onto `<html>`.
 *
 * Returned as a plain object of strings and rendered into a `style`
 * attribute, so the theme is applied before first paint: a client-side
 * effect would paint the default cyan for a frame and then flash to the
 * user's chosen colour, which is exactly the kind of detail that makes an
 * interface feel unfinished.
 */
export function themeStyle(
  settings: XanaSettings = loadSettings(),
): Record<string, string> {
  const { accent, accent2, ambient, motionSpeed } = settings.appearance;
  return {
    "--accent-rgb": safeAccent(accent, 0),
    "--accent-2-rgb": safeAccent(accent2, 1),
    "--glow-rgb": safeAccent(accent, 0),
    "--ambient-glow": String(ambient),
    "--motion": String(motionSpeed),
  };
}
