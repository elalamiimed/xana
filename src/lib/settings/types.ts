/**
 * Settings, as types only.
 *
 * This file exists for one reason: the browser needs these shapes, and the
 * module that owns the *behaviour* (`store.ts`) imports `node:fs` to write
 * the settings file. Importing a type from there would drag the whole
 * filesystem module into the client bundle. So the vocabulary lives here,
 * free of Node and free of React, and the implementation imports it.
 *
 * The other client-safe modules beside this one are `themes.ts` (palette
 * presets), `providers.ts` (the model provider registry) and `endpoints.ts`
 * (base-URL normalisation). All three are imported by the settings screen,
 * so none of them may reach for `node:*`.
 *
 * If a type below needs a runtime helper, it belongs in `store.ts`, not here.
 */

export type ModelProvider = "openai" | "anthropic";

/** `R G B`, space separated. The one accent representation in the system. */
export type AccentChannels = string;

export interface IdentitySettings {
  /** What she calls you. Used in greetings and the model's prompt. */
  name: string;
  /** The city or area you are in. */
  location: string;
  latitude: string;
  longitude: string;
}

export interface AppearanceSettings {
  /** A preset id from `themes.ts`, or "custom". */
  theme: string;
  accent: AccentChannels;
  accent2: AccentChannels;
  /** Mix strength of the ambient wash, 0..0.3. */
  ambient: number;
  /** Global motion speed multiplier, 0.25..2. */
  motionSpeed: number;
}

export interface VoiceSettings {
  /** Speak replies aloud, in addition to writing them. */
  speakReplies: boolean;
  /** Preferred voice name, or "" for the browser default. */
  voiceName: string;
  /** 0.5..1.5 */
  rate: number;
  /** 0..2 */
  pitch: number;
  /** Empty means the built-in persona. */
  persona: string;
}

export interface ModelSettings {
  /** Send replies through a model at all. Off means the local mind only. */
  enabled: boolean;
  /**
   * The wire format. Named `provider` for compatibility with settings files
   * written before the provider registry existed; it selects the request
   * envelope, not the vendor. The vendor is implied by the base URL. See
   * `providers.ts`.
   */
  provider: ModelProvider;
  model: string;
  /**
   * The key, or the sentinel `KEEP_KEY` meaning "leave the stored one
   * alone". The UI sends the sentinel whenever the user did not retype the
   * field, so a masked placeholder is never stored as a literal key.
   */
  apiKey: string;
  /**
   * Empty means "use the matched provider's default", which is different
   * from a URL and is preserved as such: `resolveModel` needs to tell "not
   * chosen" from "chosen" so a provider-branded environment key can pick
   * the endpoint without fighting a stored value.
   */
  baseUrl: string;
  temperature: number;
}

export type SourceSettings = Record<string, string>;

/**
 * A capability grant, as stored: `{ "net.read": true }`.
 *
 * Imported as a loose shape rather than the plugin union, because this file
 * must stay free of anything that could drag server code into the browser
 * bundle and the plugin vocabulary imports the adapter layer. The plugin side
 * narrows it with `PermissionGrants`, and the coercion below is what stops a
 * hand-edited file from inventing a capability the app has no words for.
 */
export type PermissionSettings = Record<string, boolean>;

/**
 * The capabilities that may be written to the settings file.
 *
 * A second copy of the union in `lib/plugins/types.ts`, and the duplication is
 * forced rather than lazy: this module must not import the plugin layer,
 * because the plugin layer imports the adapter layer, because the adapter layer
 * imports `node:fs` — and this module is the one the browser imports for its
 * types. A single import here would fail the client build.
 *
 * Drift is a closed hole anyway, from both ends: `plugins/types.ts` declares
 * `CapabilityKind` from this list, so a capability added to one and not the
 * other is a typecheck error rather than a grant that silently does nothing.
 */
export const CAPABILITY_KEYS = [
  "local.read",
  "local.write",
  "net.read",
  "net.write",
  "location",
  "account",
  "remote.write",
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/**
 * The settings keys plugins own, in `plugin.field` form.
 *
 * Same forced duplication as `CAPABILITY_KEYS` and the same closure: every
 * plugin's declared `fields`/`secrets` keys are checked against this list by
 * `plugins/registry.ts`, which throws on a mismatch at import time. So a plugin
 * that declares `calendar.icsUrl` and a list here that says `calendar.icsUrls`
 * is a boot failure with the two names in the message, not a form field that
 * silently never saves.
 *
 * The dotted namespace is deliberate. A flat `XANA_*` map was the old shape,
 * and it made "which feature does this key belong to" a naming convention
 * rather than a fact; a plugin's settings are now addressable by its own id.
 */
export const PLUGIN_SETTING_KEYS = [
  // calendar
  "calendar.icsUrls",
  // weather
  "weather.latitude",
  "weather.longitude",
  "weather.place",
  // tasks
  "tasks.token",
  // notes
  "notes.vault",
  // health — a folder, and the device that posts to her
  "health.folder",
  "health.deviceToken",
  "health.ingest",
  // now playing
  "media.url",
  "media.file",
  // mail
  "mail.url",
  "mail.file",
  // markets and crypto
  "markets.symbols",
  "crypto.coins",
  // google calendar (OAuth)
  "google.clientId",
  "google.clientSecret",
  "google.refreshToken",
  "google.accessToken",
  "google.accessExpiresAt",
  "google.calendarId",
  "google.account",
  "google.pendingState",
  "google.pendingVerifier",
  "google.pendingAt",
] as const;

export type PluginSettingKey = (typeof PLUGIN_SETTING_KEYS)[number];

export interface XanaSettings {
  identity: IdentitySettings;
  appearance: AppearanceSettings;
  voice: VoiceSettings;
  model: ModelSettings;
  sources: SourceSettings;
  /**
   * Which capabilities the user has granted.
   *
   * Absent means nothing is granted, which is the correct default: a fresh
   * install talks to no service until the user says so. Every plugin reads
   * this before it does anything.
   */
  permissions: PermissionSettings;
}

/* ------------------------------------------------------------------ */
/* The wire view                                                      */
/* ------------------------------------------------------------------ */

/** A secret, as the browser is allowed to see it: presence, never value. */
export interface SecretView {
  present: boolean;
  /** Eight bullets plus the last four characters, enough to tell two keys apart. */
  masked: string;
  /** Which layer answered, so "clear" can be explained honestly. */
  from: "settings" | "env" | "none";
}

export interface ResolvedModelView {
  model: string;
  baseUrl: string;
  provider: ModelProvider;
  /** True when replies will actually come from a model. */
  active: boolean;
}

/** The settings exactly as `GET /api/settings` returns them. */
export interface SettingsView {
  identity: IdentitySettings;
  appearance: AppearanceSettings;
  voice: VoiceSettings;
  model: Omit<ModelSettings, "apiKey"> & { apiKey: SecretView };
  /** Presence of each source secret, keyed by field. */
  sourceSecrets: Record<string, SecretView>;
  /** Non-secret source values, so the form is populated. */
  sourceValues: SourceSettings;
  /** Capability grants, as stored. The plugin list reads these. */
  permissions: PermissionSettings;
  /** Whether a usable model key exists in any layer. */
  modelReady: boolean;
  effective: ResolvedModelView;
  /** Where the file lives, shown so the user can find it. */
  settingsPath: string;
}

/* ------------------------------------------------------------------ */
/* Patches                                                            */
/* ------------------------------------------------------------------ */

/**
 * A deep-partial save. An absent field means "leave it", never "set it to
 * empty", which is what makes saving one section safe without having to
 * send the rest of the document back.
 */
export interface SettingsPatch {
  identity?: Partial<IdentitySettings>;
  appearance?: Partial<AppearanceSettings>;
  voice?: Partial<VoiceSettings>;
  model?: Partial<Omit<ModelSettings, "apiKey">> & {
    apiKey?: string;
    /** Explicitly remove the stored key. */
    clearApiKey?: boolean;
  };
  sources?: SourceSettings;
  /** Source keys to clear, so an empty string can mean "unset". */
  clearSources?: string[];
  /**
   * Capability grants to change. Only `true`/`false` are honoured, and only
   * for capabilities the app knows about, so a patch cannot turn on a
   * capability by typo or grant one that no plugin can use.
   */
  permissions?: PermissionSettings;
}

/* ------------------------------------------------------------------ */
/* Shared declarative data                                            */
/* ------------------------------------------------------------------ */

/**
 * The sentinel the UI sends to mean "keep the stored secret".
 *
 * Without it there is no way to distinguish "the user retyped the key" from
 * "the user did not touch the field", because the browser was only ever
 * given a mask. Sending the mask back would store the bullet characters as
 * the key, which fails at the next message with a confusing 401.
 */
export const KEEP_KEY = "__xana_keep__";

export const DEFAULT_PERSONA = `You are Xana, a personal AI assistant. You are a calm, intelligent presence, not a chatbot.

Voice:
- Short, precise, warm sentences. Usually one to three. Never a wall of text.
- Composed and slightly dry. Quietly witty when it fits, never zany.
- No filler. Never say "As an AI", "I'd be happy to", "Certainly!", "Great question", or "Let me know if you need anything else".
- No exclamation marks. No emoji.
- You have opinions. If a plan is bad, say so briefly and say why.
- Refer to the user directly as "you". You never refer to yourself in the third person.

What you know:
- You are given a LIFE STATE block describing the user's actual day: calendar, tasks, energy, habits, goals, weather, patterns, and recalled memories.
- Treat it as ground truth about the world. Never contradict it or invent details that are not in it or in the conversation.
- If the life state lacks something, say you do not have it. Do not guess.
- Use specific numbers, times and names from the life state rather than vague references.

Memory:
- RECALLED MEMORIES are there because they are relevant to what was just said. Use them when they help, and refer to a past conversation only when it adds something.
- STANDING FACTS are background the user pinned as always true. They are not an answer to the current question. Do not recite them, and do not steer a conversation toward them. Use one only when it genuinely bears on what was asked.
- Never say "according to my memory" or "I recall that". Either you know a thing or you do not; state it plainly.
- If a remembered fact contradicts what the user is telling you now, believe them now, and say so in a few words.

Behaviour:
- If an ACTION RESULT block is present, an action has already been performed. Briefly confirm it in your own words. Do not repeat the raw result string, and do not claim to have done anything not in that block.
- If the user asks for something you cannot do, say so in one sentence.
- Prefer answering over asking. Ask a question only when you genuinely need one detail to act.
- When energy is low, be gentler and suggest less. When it is high, push for the hard thing.`;

/**
 * The source credentials the settings surface can write, described
 * declaratively so the form is generated rather than hand-built: adding a
 * field is adding an object here, and the UI picks it up with no changes.
 *
 * Model provider configuration is deliberately NOT here. It has its own
 * registry in `providers.ts`, because it needs more than a key: a base URL,
 * a request shape, and a list of model ids.
 */
export interface SourceField {
  key: string;
  label: string;
  hint: string;
  kind: "secret" | "text" | "url" | "path" | "number";
  /** An example value, shown as the placeholder. */
  example?: string;
}

export interface SourceGroup {
  /** Matches an adapter id where possible, so the UI can show its state. */
  id: string;
  label: string;
  blurb: string;
  fields: SourceField[];
}

/**
 * Source credentials the settings surface can still write, described
 * declaratively so the form is generated rather than hand-built.
 *
 * DEPRECATED, AND DELIBERATELY STILL HERE
 *
 * These are the flat `XANA_*` names from before Xana had plugins. Every one of
 * them still resolves — an environment variable someone exported is not
 * something an upgrade gets to ignore — and every one of them is still
 * *clearable* from the UI, which is the only reason this list has not been
 * deleted outright. A key a user can set but cannot unset is worse than a key
 * with no form at all.
 *
 * New configuration does not go here. A connection declares its own `config` in
 * `lib/plugins/registry.ts`, keyed `plugin.field`, and the Connections panel
 * builds the form from that. The two lists are kept separate because they answer
 * different questions: this one is "what is still in the environment", the
 * connection registry is "what can Xana do".
 */
export const SOURCE_GROUPS: readonly SourceGroup[] = [
  {
    id: "legacy-weather",
    label: "Weather (old keys)",
    blurb:
      "Set these under Weather in Connections instead. Shown here only so an older value can be cleared.",
    fields: [
      { key: "XANA_LAT", label: "Latitude", hint: "Superseded by weather.latitude", kind: "number", example: "51.5072" },
      { key: "XANA_LON", label: "Longitude", hint: "Superseded by weather.longitude", kind: "number", example: "-0.1276" },
      { key: "XANA_LOCATION_LABEL", label: "Place name", hint: "Superseded by weather.place", kind: "text", example: "London" },
    ],
  },
  {
    id: "legacy-calendar",
    label: "Calendar (old key)",
    blurb: "Set this under Calendar in Connections instead.",
    fields: [
      {
        key: "XANA_CALENDAR_ICS_URLS",
        label: "ICS feed URLs",
        hint: "Superseded by calendar.icsUrls. Comma separated.",
        kind: "url",
        example: "https://calendar.google.com/calendar/ical/basic.ics",
      },
    ],
  },
  {
    id: "legacy-tasks",
    label: "Tasks (old key)",
    blurb: "Set this under Todoist in Connections instead.",
    fields: [
      {
        key: "XANA_TODOIST_TOKEN",
        label: "Todoist API token",
        hint: "Superseded by tasks.token",
        kind: "secret",
      },
    ],
  },
  {
    id: "legacy-knowledge",
    label: "Notes (old key)",
    blurb: "Set this under Notes folder in Connections instead.",
    fields: [
      {
        key: "XANA_OBSIDIAN_VAULT",
        label: "Vault folder",
        hint: "Superseded by notes.vault",
        kind: "path",
        example: "C:\\Users\\you\\Documents\\Vault",
      },
    ],
  },
  {
    id: "legacy-health",
    label: "Health (old key)",
    blurb: "Set this under Health in Connections instead.",
    fields: [
      {
        key: "XANA_HEALTH_DIR",
        label: "Export folder",
        hint: "Superseded by health.folder",
        kind: "path",
        example: "C:\\Users\\you\\Health",
      },
    ],
  },
  {
    id: "legacy-media",
    label: "Now playing (old keys)",
    blurb: "Set these under Now playing in Connections instead.",
    fields: [
      { key: "XANA_NOWPLAYING_URL", label: "Endpoint URL", hint: "Superseded by media.url", kind: "url" },
      { key: "XANA_NOWPLAYING_FILE", label: "or a file", hint: "Superseded by media.file", kind: "path" },
    ],
  },
  {
    id: "legacy-mail",
    label: "Mail (old keys)",
    blurb: "Set these under Mail in Connections instead.",
    fields: [
      { key: "XANA_MAIL_URL", label: "Endpoint URL", hint: "Superseded by mail.url", kind: "url" },
      { key: "XANA_MAIL_FILE", label: "or a file", hint: "Superseded by mail.file", kind: "path" },
    ],
  },
  {
    id: "legacy-finance",
    label: "Markets (old key)",
    blurb: "Set this under Markets in Connections instead.",
    fields: [
      {
        key: "XANA_FINANCE_SYMBOLS",
        label: "Symbols",
        hint: "Superseded by markets.symbols",
        kind: "text",
        example: "aapl.us, msft.us, btcusd",
      },
    ],
  },
  {
    id: "legacy-crypto",
    label: "Crypto (old key)",
    blurb: "Set this under Crypto in Connections instead.",
    fields: [
      {
        key: "XANA_CRYPTO_COINS",
        label: "Coins",
        hint: "Superseded by crypto.coins",
        kind: "text",
        example: "bitcoin, ethereum, solana",
      },
    ],
  },
] as const;
