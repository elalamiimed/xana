/**
 * Which language the recogniser is asked to recognise.
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * The recogniser was handed `navigator.language` and told nothing else:
 *
 *     instance.lang = navigator.language || "en-US";
 *
 * and that one line produced the app's most useless sentence — *"This browser
 * cannot recognise your language for dictation. Change the browser's language, or
 * type instead."* — on a machine whose owner speaks English. The diagnosis in
 * `docs/MIC-DIAGNOSIS.md` §2 Cause 5 found why: this browser profile reports the
 * bare tag **`en`**, Chromium sends that tag to its speech service as the
 * `language=` query parameter, and the service decides *server-side* that it
 * cannot serve it. The user is told to go and change a browser setting that is
 * not wrong, for a failure the app created by passing a value through untouched.
 *
 * Three things were wrong and all are fixed here:
 *
 *  1. **A bare language tag is not a locale.** `en` says which language; it does
 *     not say which *model* — en-US, en-GB and en-IN are three different acoustic
 *     models. A service that needs a locale refuses the language. So a bare tag
 *     is resolved to the representative regional tag this module keeps for it,
 *     which is the difference between `language-not-supported` and dictation.
 *  2. **The user could not disagree.** There was nowhere to say "I am speaking
 *     English even though this browser is set to something else". There is now a
 *     setting (`voice.speechLang`), and it is tried before everything else,
 *     because an explicit choice must beat an inference.
 *  3. **Only a bare tag is resolved, and the first version of that fix got this
 *     wrong.** It resolved the language of *every* browser tag, so a browser
 *     asking for `en-GB` was sent `en-US`, `fr-CA` got `fr-FR`, and `zh-HK` —
 *     Cantonese — got `zh-CN`. That is the original bug with the sign flipped:
 *     the app rewriting a tag the browser had already stated in full, and for
 *     Chinese a change of language rather than of region. See `isBareLanguage`.
 *
 * WHAT IS DELIBERATELY NOT CLAIMED
 *
 * MDN is plain that there is *"no way to programmatically determine from
 * front-end code the languages a user's browser supports"* — so `SPEECH_LANGUAGES`
 * is NOT an authority on what will be accepted. It is a curated starting set with
 * two jobs, both of which are honest about that:
 *
 *   - it populates the picker, so the user chooses from tags that are real and
 *     correctly spelled rather than typing `english`;
 *   - it supplies the retry ladder, which is tried only after the service has
 *     actually refused a tag — evidence, not a guess.
 *
 * A tag outside the list is still sent as-is, and so is any tag that names a
 * region or a script. Refusing or rewriting either would be this module inventing
 * a restriction the browser never stated, and would break the one user whose
 * locale happens to be missing from a list someone typed out.
 *
 * THE LADDER STAYS INSIDE ONE LANGUAGE
 *
 * When a tag is refused the next attempt is another regional variant of the SAME
 * language, never a different one. The tempting shortcut — fall back to `en-US`
 * come what may — would turn a Chinese user's refusal into confident English
 * nonsense, which is worse than an honest "this browser will not do your
 * language": wrong words are indistinguishable from a bad microphone, so the user
 * would keep talking at it. A *deliberate* choice (source `setting`) gets no
 * ladder at all, because second-guessing the user with a different language is
 * the same mistake wearing a helpful expression.
 */

/* ================================================================== */
/* The starting set                                                   */
/* ================================================================== */

/**
 * The tag used when the browser will not name a usable language.
 *
 * English because the app, its persona and its prompts are written in English,
 * and because it is the one answer that cannot be worse than saying nothing.
 */
export const DEFAULT_SPEECH_LANGUAGE = "en-US";

/** Sent by a browser that is refusing to name a language. Not a locale. */
const NOT_A_LANGUAGE = new Set(["und", "mul", "zxx"]);

export interface SpeechLanguageOption {
  /** A BCP-47 tag, as it will be sent to the recogniser. */
  readonly tag: string;
  /** What to show a person. */
  readonly label: string;
}

/**
 * Tags to offer, most likely first within each language.
 *
 * ORDER IS LOAD-BEARING. The first entry for a base language is the
 * representative that a bare tag (`en`, `zh`) resolves to and that the retry
 * ladder starts from, so `en-US` before `en-GB` is a decision rather than
 * alphabetical drift: it is the widest-coverage English model, and the one every
 * documented example of this API uses.
 */
export const SPEECH_LANGUAGES: readonly SpeechLanguageOption[] = [
  { tag: "en-US", label: "English (United States)" },
  { tag: "en-GB", label: "English (United Kingdom)" },
  { tag: "en-AU", label: "English (Australia)" },
  { tag: "en-CA", label: "English (Canada)" },
  { tag: "en-IN", label: "English (India)" },
  { tag: "en-NZ", label: "English (New Zealand)" },
  { tag: "es-ES", label: "Spanish (Spain)" },
  { tag: "es-MX", label: "Spanish (Mexico)" },
  { tag: "es-US", label: "Spanish (United States)" },
  { tag: "fr-FR", label: "French (France)" },
  { tag: "fr-CA", label: "French (Canada)" },
  { tag: "de-DE", label: "German (Germany)" },
  { tag: "it-IT", label: "Italian (Italy)" },
  { tag: "pt-BR", label: "Portuguese (Brazil)" },
  { tag: "pt-PT", label: "Portuguese (Portugal)" },
  { tag: "nl-NL", label: "Dutch (Netherlands)" },
  { tag: "sv-SE", label: "Swedish (Sweden)" },
  { tag: "nb-NO", label: "Norwegian Bokmal (Norway)" },
  { tag: "da-DK", label: "Danish (Denmark)" },
  { tag: "fi-FI", label: "Finnish (Finland)" },
  { tag: "is-IS", label: "Icelandic (Iceland)" },
  { tag: "pl-PL", label: "Polish (Poland)" },
  { tag: "cs-CZ", label: "Czech (Czechia)" },
  { tag: "sk-SK", label: "Slovak (Slovakia)" },
  { tag: "hu-HU", label: "Hungarian (Hungary)" },
  { tag: "ro-RO", label: "Romanian (Romania)" },
  { tag: "bg-BG", label: "Bulgarian (Bulgaria)" },
  { tag: "hr-HR", label: "Croatian (Croatia)" },
  { tag: "sl-SI", label: "Slovenian (Slovenia)" },
  { tag: "sr-RS", label: "Serbian (Serbia)" },
  { tag: "bs-BA", label: "Bosnian (Bosnia and Herzegovina)" },
  { tag: "mk-MK", label: "Macedonian (North Macedonia)" },
  { tag: "sq-AL", label: "Albanian (Albania)" },
  { tag: "el-GR", label: "Greek (Greece)" },
  { tag: "tr-TR", label: "Turkish (Turkey)" },
  { tag: "ru-RU", label: "Russian (Russia)" },
  { tag: "uk-UA", label: "Ukrainian (Ukraine)" },
  { tag: "he-IL", label: "Hebrew (Israel)" },
  { tag: "ar-SA", label: "Arabic (Saudi Arabia)" },
  { tag: "ar-EG", label: "Arabic (Egypt)" },
  { tag: "fa-IR", label: "Persian (Iran)" },
  { tag: "ur-PK", label: "Urdu (Pakistan)" },
  { tag: "hi-IN", label: "Hindi (India)" },
  { tag: "bn-IN", label: "Bengali (India)" },
  { tag: "mr-IN", label: "Marathi (India)" },
  { tag: "gu-IN", label: "Gujarati (India)" },
  { tag: "ta-IN", label: "Tamil (India)" },
  { tag: "te-IN", label: "Telugu (India)" },
  { tag: "kn-IN", label: "Kannada (India)" },
  { tag: "ml-IN", label: "Malayalam (India)" },
  { tag: "pa-IN", label: "Punjabi (India)" },
  { tag: "ne-NP", label: "Nepali (Nepal)" },
  { tag: "si-LK", label: "Sinhala (Sri Lanka)" },
  { tag: "th-TH", label: "Thai (Thailand)" },
  { tag: "vi-VN", label: "Vietnamese (Vietnam)" },
  { tag: "id-ID", label: "Indonesian (Indonesia)" },
  { tag: "ms-MY", label: "Malay (Malaysia)" },
  { tag: "fil-PH", label: "Filipino (Philippines)" },
  { tag: "zh-CN", label: "Chinese, Mandarin (Simplified)" },
  { tag: "zh-TW", label: "Chinese, Mandarin (Taiwan)" },
  { tag: "zh-HK", label: "Chinese, Cantonese (Hong Kong)" },
  { tag: "ja-JP", label: "Japanese (Japan)" },
  { tag: "ko-KR", label: "Korean (South Korea)" },
  { tag: "ca-ES", label: "Catalan (Spain)" },
  { tag: "eu-ES", label: "Basque (Spain)" },
  { tag: "gl-ES", label: "Galician (Spain)" },
  { tag: "cy-GB", label: "Welsh (United Kingdom)" },
  { tag: "ga-IE", label: "Irish (Ireland)" },
  { tag: "af-ZA", label: "Afrikaans (South Africa)" },
  { tag: "sw-KE", label: "Swahili (Kenya)" },
  { tag: "am-ET", label: "Amharic (Ethiopia)" },
  { tag: "ka-GE", label: "Georgian (Georgia)" },
  { tag: "hy-AM", label: "Armenian (Armenia)" },
  { tag: "az-AZ", label: "Azerbaijani (Azerbaijan)" },
  { tag: "kk-KZ", label: "Kazakh (Kazakhstan)" },
  { tag: "uz-UZ", label: "Uzbek (Uzbekistan)" },
  { tag: "mn-MN", label: "Mongolian (Mongolia)" },
  { tag: "km-KH", label: "Khmer (Cambodia)" },
  { tag: "lo-LA", label: "Lao (Laos)" },
  { tag: "my-MM", label: "Burmese (Myanmar)" },
];

/* ================================================================== */
/* Tags: reading them, and writing them back correctly                */
/* ================================================================== */

/** `en`, `en-US`, `zh-Hans-CN`. Deliberately shape-only — see the module note. */
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/**
 * Put one subtag into the case BCP-47 asks for.
 *
 * Not cosmetic. The tags travel into a URL query parameter and are matched
 * against a service's list; `ZH-hans-cn` is a different string from `zh-Hans-CN`
 * to anything that compares them literally, and the failure it produces is the
 * one this module exists to remove.
 */
function canonicalSubtag(part: string): string {
  if (/^[A-Za-z]{4}$/.test(part)) {
    // A script: `Hans`, `Hant`, `Latn`.
    return `${part[0]?.toUpperCase() ?? ""}${part.slice(1).toLowerCase()}`;
  }
  if (/^[A-Za-z]{2}$/.test(part) || /^[0-9]{3}$/.test(part)) {
    // A region, or a UN M.49 area code such as `es-419`.
    return part.toUpperCase();
  }
  return part.toLowerCase();
}

/**
 * A browser or a person's idea of a language tag, as a tag or as `""`.
 *
 * `""` is the only failure this reports, and callers must treat it as "ask
 * something else" rather than as "no language" — a browser that reports
 * `navigator.language === "en"` is not broken, it is unspecific, and
 * `resolveSpeechLanguage` is where that distinction is spent.
 *
 * The three tolerated shapes are the ones that actually arrive: an ordinary tag,
 * a tag with the underscore Windows uses (`en_US`), and an `Accept-Language`
 * entry with its quality value (`en-US;q=0.9`) — which is what a browser profile
 * carries, so it is what a value copied out of one looks like.
 */
export function normalizeLanguageTag(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const first = raw.trim().split(";")[0] ?? "";
  const cleaned = first.replace(/_/g, "-").replace(/\s+/g, "");
  if (!cleaned || !LANGUAGE_PATTERN.test(cleaned)) return "";

  const parts = cleaned.split("-");
  const primary = (parts[0] ?? "").toLowerCase();
  if (NOT_A_LANGUAGE.has(primary)) return "";
  return [primary, ...parts.slice(1).map(canonicalSubtag)].join("-");
}

/** The language of a tag, without its region or script: `en-GB` -> `en`. */
export function baseLanguage(tag: string): string {
  return normalizeLanguageTag(tag).split("-")[0] ?? "";
}

/**
 * Whether a tag names a language and nothing else: `en`, not `en-GB`.
 *
 * This is the difference the whole module turns on, and it is a test for a
 * subtag rather than a lookup in a list. `en` is a language and no model, so a
 * service that wants a locale refuses it and it must be resolved. `en-GB`,
 * `zh-Hant` and `es-419` already name a model: they are what the browser asked
 * for, in full, and they are sent as they are.
 *
 * Resolving those too was a defect of this module's first version, and it was
 * the same mistake in the opposite direction: `navigator.language` of `zh-HK`
 * became `zh-CN`, which is not a British-for-American substitution but Cantonese
 * transcribed as Mandarin. The app had no more business rewriting a complete tag
 * than it had leaving a bare one alone.
 */
function isBareLanguage(tag: string): boolean {
  return !tag.includes("-");
}

/**
 * The tag this module would use for a language on its own.
 *
 * This is what a bare `en` becomes, and it is half of the reported bug's fix:
 * `en` is a language, `en-US` is the model to ask for.
 *
 * It answers for a LANGUAGE, not for a tag, which is why `representativeFor`
 * of `en-GB` is still `en-US`. That is a fact about English and not a
 * recommendation to rewrite `en-GB`: only `resolveSpeechLanguage` decides what
 * is sent, and it asks this only about a bare tag. Calling it on a complete tag
 * and adopting the answer is the defect `isBareLanguage` exists to prevent.
 */
export function representativeFor(language: string): string {
  const base = baseLanguage(language);
  if (!base) return "";
  return SPEECH_LANGUAGES.find((option) => baseLanguage(option.tag) === base)?.tag ?? "";
}

/** The tags for one language, representative first, excluding `except`. */
export function variantsOf(language: string, except = ""): readonly string[] {
  const base = baseLanguage(language);
  if (!base) return [];
  return SPEECH_LANGUAGES.filter(
    (option) => baseLanguage(option.tag) === base && option.tag !== except,
  ).map((option) => option.tag);
}

/** A tag a person can read, for a status line. Falls back to the tag itself. */
export function languageLabel(tag: string): string {
  const normalized = normalizeLanguageTag(tag);
  if (!normalized) return "";
  return SPEECH_LANGUAGES.find((option) => option.tag === normalized)?.label ?? normalized;
}

/* ================================================================== */
/* Resolution                                                         */
/* ================================================================== */

/** Where the tag that is actually being sent came from. */
export type SpeechLanguageSource = "setting" | "browser" | "default";

export interface SpeechLanguage {
  /** The tag to set on the recogniser. Never empty. */
  readonly tag: string;
  /** Where it came from, so the UI can say so rather than imply. */
  readonly source: SpeechLanguageSource;
  /**
   * The browser's own tag, when it was not usable as-is.
   *
   * Carried rather than discarded because it is the difference between a working
   * default and a mystery: "the browser says en, dictation uses en-US" is the
   * entire explanation of the reported failure, and it is one line of a status
   * panel instead of a bug report.
   */
  readonly fromBrowser: string;
}

/** The tags the browser prefers, most preferred first. Empty outside a page. */
export function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  const languages = navigator.languages;
  if (Array.isArray(languages) && languages.length > 0) return [...languages];
  return navigator.language ? [navigator.language] : [];
}

/**
 * The tag to hand the recogniser.
 *
 * Precedence, and each step earns its place:
 *
 *  1. **The setting.** An explicit choice always wins, including a tag this
 *     module would not have picked — the user may know their service better than
 *     a list in a source file does.
 *  2. **The browser's own preference**, normalised. A tag that names only a
 *     language (`en`) is resolved to a regional model, because no service accepts
 *     a language where it wants a locale — this is the step that fixes the
 *     reported failure. A tag that already names a region or a script
 *     (`en-GB`, `zh-HK`, `es-419`) is sent exactly as the browser asked for it:
 *     it is complete, and rewriting it would be this module answering a request
 *     nobody made.
 *  3. **The default**, when the browser will not name one at all.
 */
export function resolveSpeechLanguage(
  preferred: string,
  fromBrowser: readonly string[] = browserLanguages(),
): SpeechLanguage {
  const chosen = normalizeLanguageTag(preferred);
  if (chosen) return { tag: chosen, source: "setting", fromBrowser: "" };

  for (const raw of fromBrowser) {
    const tag = normalizeLanguageTag(raw);
    if (!tag) continue;
    // Only a bare language is resolved. See `isBareLanguage`: `en-GB` is a
    // complete answer and `en` is not, and treating the second like the first is
    // what produced the reported refusal.
    const representative = isBareLanguage(tag) ? representativeFor(tag) : "";
    if (representative && representative !== tag) {
      return { tag: representative, source: "browser", fromBrowser: tag };
    }
    // The first usable tag wins outright. Walking on to a later preference
    // because this one is missing from `SPEECH_LANGUAGES` would answer in a
    // language the user did not ask for and cannot read.
    return { tag, source: "browser", fromBrowser: "" };
  }

  return { tag: DEFAULT_SPEECH_LANGUAGE, source: "default", fromBrowser: "" };
}

/**
 * The tags to try after the service refuses the first one, in order.
 *
 * Only ever another regional variant of the SAME language, and only for a tag
 * this module inferred. A user's own choice gets an empty ladder: if the service
 * will not do the language they picked, the honest answer is to say so and let
 * them pick again, not to quietly answer in a language they did not choose.
 *
 * See the module note for why the "just fall back to English" shortcut is
 * refused.
 */
export function speechLanguageFallbacks(chosen: SpeechLanguage): readonly string[] {
  if (chosen.source === "setting") return [];
  return variantsOf(chosen.tag, chosen.tag);
}

/**
 * The next untried tag, or `null` when the ladder is exhausted.
 *
 * Its own function because it is the anti-loop guard, and a guard that lives
 * inside an event handler is a guard nobody can test. `language-not-supported`
 * arrives as an error event, and an error event that restarts the recogniser
 * with a tag it has already refused is an infinite loop with a microphone light
 * on — so "which tags have I already failed" is state, and this reads it.
 */
export function nextSpeechLanguage(
  tried: readonly string[],
  ladder: readonly string[],
): string | null {
  for (const tag of ladder) {
    if (!tag || tried.includes(tag)) continue;
    return tag;
  }
  return null;
}
