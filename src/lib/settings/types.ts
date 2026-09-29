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

export interface XanaSettings {
  identity: IdentitySettings;
  appearance: AppearanceSettings;
  voice: VoiceSettings;
  model: ModelSettings;
  sources: SourceSettings;
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

export const SOURCE_GROUPS: readonly SourceGroup[] = [
  {
    id: "weather",
    label: "Weather",
    blurb: "A free Open-Meteo lookup. Only your coordinates leave the machine.",
    fields: [
      { key: "XANA_LAT", label: "Latitude", hint: "Decimal degrees", kind: "number", example: "51.5072" },
      { key: "XANA_LON", label: "Longitude", hint: "Decimal degrees", kind: "number", example: "-0.1276" },
      { key: "XANA_LOCATION_LABEL", label: "Place name", hint: "Shown on the card", kind: "text", example: "London" },
    ],
  },
  {
    id: "calendar",
    label: "Calendar",
    blurb:
      "Any number of read-only ICS feeds, comma separated. Google, Outlook and Fastmail all publish one under their calendar settings.",
    fields: [
      {
        key: "XANA_CALENDAR_ICS_URLS",
        label: "ICS feed URLs",
        hint: "Comma separated. A webcal address works too.",
        kind: "url",
        example: "https://calendar.google.com/calendar/ical/basic.ics",
      },
    ],
  },
  {
    id: "tasks",
    label: "Tasks",
    blurb:
      "Todoist is the only hosted task list Xana speaks natively. Without a token, tasks are local and still fully functional.",
    fields: [
      {
        key: "XANA_TODOIST_TOKEN",
        label: "Todoist API token",
        hint: "Todoist, then Settings, then Integrations, then API token",
        kind: "secret",
      },
    ],
  },
  {
    id: "knowledge",
    label: "Notes",
    blurb:
      "Point Xana at a folder of Markdown and she will read it, and write to it when you ask her to remember something.",
    fields: [
      {
        key: "XANA_OBSIDIAN_VAULT",
        label: "Vault folder",
        hint: "An absolute path to a folder of .md files",
        kind: "path",
        example: "C:\\Users\\you\\Documents\\Vault",
      },
    ],
  },
  {
    id: "health",
    label: "Health",
    blurb: "A folder of Apple Health or Google Fit exports. Read locally, never uploaded.",
    fields: [
      {
        key: "XANA_HEALTH_DIR",
        label: "Export folder",
        hint: "Where the JSON and CSV exports live",
        kind: "path",
        example: "C:\\Users\\you\\Health",
      },
    ],
  },
  {
    id: "media",
    label: "Now playing",
    blurb:
      "A small JSON endpoint, or a file, describing what is playing. Useful with a scrobbler.",
    fields: [
      {
        key: "XANA_NOWPLAYING_URL",
        label: "Endpoint URL",
        hint: "Returns a title and an artist",
        kind: "url",
        example: "http://127.0.0.1:9863/now",
      },
      { key: "XANA_NOWPLAYING_FILE", label: "or a file", hint: "The same JSON, read from disk", kind: "path" },
    ],
  },
  {
    id: "mail",
    label: "Mail",
    blurb:
      "The same shape as now-playing: a URL or a file returning recent messages. Xana reads subjects, never bodies.",
    fields: [
      { key: "XANA_MAIL_URL", label: "Endpoint URL", hint: "Returns a list of messages", kind: "url" },
      { key: "XANA_MAIL_FILE", label: "or a file", hint: "The same JSON, read from disk", kind: "path" },
    ],
  },
  {
    id: "finance",
    label: "Markets",
    blurb: "Quotes from Stooq, which needs no key. Symbols are comma separated.",
    fields: [
      {
        key: "XANA_FINANCE_SYMBOLS",
        label: "Symbols",
        hint: "Stooq tickers, comma separated",
        kind: "text",
        example: "aapl.us, msft.us, btcusd",
      },
    ],
  },
] as const;
