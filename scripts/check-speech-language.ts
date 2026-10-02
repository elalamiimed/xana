/**
 * The language tag that goes to the speech service.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-speech-language.ts
 *
 * WHAT THIS PROVES, AND WHY IT NEEDS PROVING
 *
 * The bug was one line — `instance.lang = navigator.language || "en-US"` — and its
 * symptom was a sentence telling an English speaker that their browser could not
 * recognise English. This browser profile reports the bare tag **`en`**;
 * Chromium forwards that tag to its speech service as the `language=` query
 * parameter; a service that needs a locale refuses it; the user is told to go and
 * change a browser setting that was never wrong.
 *
 * That cannot be reproduced on demand here: it needs a browser, a Microsoft
 * endpoint and a specific profile's language list, and a browser cannot run in
 * this environment at all. But the *decision* — which tag to send, and what to try
 * when it is refused — is a pure function of a setting and a list of browser
 * preferences, so it can be driven exactly, including the failing case that
 * started this.
 *
 * The negative cases matter as much as the positive ones, and they are the reason
 * this file is not three assertions long:
 *
 *   - A refused tag must never lead to a tag that has already been refused, or the
 *     retry becomes a spin with the microphone light on.
 *   - A fallback must never change the LANGUAGE. Falling back to English for a
 *     Chinese user's refusal produces confident nonsense, which reads as a bad
 *     microphone rather than as a refusal, and would send the user to buy a new
 *     headset.
 *   - A language the user chose by hand must not be second-guessed at all.
 */

import {
  DEFAULT_SPEECH_LANGUAGE,
  SPEECH_LANGUAGES,
  baseLanguage,
  browserLanguages,
  languageLabel,
  nextSpeechLanguage,
  normalizeLanguageTag,
  representativeFor,
  resolveSpeechLanguage,
  speechLanguageFallbacks,
  variantsOf,
  type SpeechLanguage,
} from "../src/components/xana/speech-language";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function group(title: string, run: () => void): void {
  console.log(`\n${title}\n`);
  try {
    run();
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${title} threw — ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* ------------------------------------------------------------------ */
/* The reported failure                                                */
/* ------------------------------------------------------------------ */

group("The reported failure: a bare `en` becomes a locale", () => {
  // This is the machine from `docs/MIC-DIAGNOSIS.md` §2 Cause 5: Edge's profile
  // carries `intl.accept_languages = "en,zh-CN,en-GB,en-US"`, so the browser
  // reports the bare `en` as its first preference.
  const chosen = resolveSpeechLanguage("", ["en", "zh-CN", "en-GB", "en-US"]);

  check("a locale is sent, not a bare language", chosen.tag === "en-US", chosen.tag);
  check("it still records what the browser asked for", chosen.fromBrowser === "en", chosen.fromBrowser);
  check("and where it came from", chosen.source === "browser", chosen.source);
  // The failure the old code produced: `en` went out unaltered, the service
  // refused it, and the user was told to change their browser language.
  check(
    "the unaltered tag is NOT what is sent",
    chosen.tag !== "en",
    chosen.tag,
  );
});

group("The user's own choice beats the browser, which is the point of the setting", () => {
  const chosen = resolveSpeechLanguage("en-GB", ["en", "zh-CN"]);
  check("the setting wins outright", chosen.tag === "en-GB", chosen.tag);
  check("it is reported as the user's", chosen.source === "setting", chosen.source);
  check("and the browser's tag is not even mentioned", chosen.fromBrowser === "", chosen.fromBrowser);

  // A tag outside the curated list is still honoured: the list is a convenience,
  // never an authority on what the browser will accept. See the module note.
  const unusual = resolveSpeechLanguage("is-IS", ["en-US"]);
  check("a tag in the list is used as given", unusual.tag === "is-IS", unusual.tag);
  const missing = resolveSpeechLanguage("kl-GL", ["en-US"]);
  check("and so is one that is not", missing.tag === "kl-GL", missing.tag);
});

group("A normalised tag is what is compared and sent", () => {
  // Case and separators are SPELLING, not a correction: `EN_us` is the locale
  // `en-US` written the way Windows writes it, so nothing has been inferred on
  // the user's behalf and there is nothing to report. Recording it as a
  // correction would put "the browser asks for EN_us, which a service will not
  // accept" on screen — true of the string, false of the request.
  const windows = resolveSpeechLanguage("", ["EN_us"]);
  check("the underscore Windows reports is understood", windows.tag === "en-US", windows.tag);
  check("and is not reported as a correction", windows.fromBrowser === "", windows.fromBrowser);

  // A tag with no region IS a correction, and that is the reported bug.
  const bare = resolveSpeechLanguage("", ["EN"]);
  check("a bare language is", bare.fromBrowser === "en", bare.fromBrowser);
  check("resolved to a locale", bare.tag === "en-US", bare.tag);

  const qualified = resolveSpeechLanguage("", ["en-US;q=0.9"]);
  check("a quality value is stripped", qualified.tag === "en-US", qualified.tag);
  check("so the tag matches rather than merely resembling", qualified.fromBrowser === "", qualified.fromBrowser);
});

/* ------------------------------------------------------------------ */
/* Normalisation, tag by tag                                           */
/* ------------------------------------------------------------------ */

group("A tag is read the way BCP-47 spells it, whatever arrives", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["en", "en"],
    ["EN", "en"],
    ["en-us", "en-US"],
    ["en_US", "en-US"],
    ["  en-GB  ", "en-GB"],
    ["zh-hans-cn", "zh-Hans-CN"],
    ["zh-Hant", "zh-Hant"],
    ["es-419", "es-419"],
    ["pt-br", "pt-BR"],
  ];
  for (const [input, expected] of cases) {
    const actual = normalizeLanguageTag(input);
    check(`${JSON.stringify(input)} -> ${expected}`, actual === expected, actual);
  }
});

group("What is not a language is refused rather than guessed at", () => {
  const refused = ["", "   ", "und", "mul", "zxx", "*", "e", "english", "1234", "en-", "-en", "en--US", "en US!"];
  for (const input of refused) {
    const actual = normalizeLanguageTag(input);
    // `en US!` is refused because the space is removed and the `!` is not a
    // subtag character — a whitespace-stripped value that then passes would be
    // a tag invented by this module rather than reported by the browser.
    check(`${JSON.stringify(input)} is refused`, actual === "", actual);
  }
  check("a non-string is refused", normalizeLanguageTag(undefined) === "");
  check("and so is a number", normalizeLanguageTag(7) === "");
});

/* ------------------------------------------------------------------ */
/* The ladder                                                          */
/* ------------------------------------------------------------------ */

group("A refusal tries another model of the same language, never another language", () => {
  const chosen = resolveSpeechLanguage("", ["en"]);
  const ladder = speechLanguageFallbacks(chosen);

  check("there is something to try", ladder.length > 0, JSON.stringify(ladder));
  check(
    "every tag is English",
    ladder.every((tag) => baseLanguage(tag) === "en"),
    JSON.stringify(ladder),
  );
  check(
    "and none of them is the tag already refused",
    !ladder.includes(chosen.tag),
    JSON.stringify(ladder),
  );
  check("the first alternative is a different English", ladder[0] === "en-GB", String(ladder[0]));

  // The general rule, asserted against every language in the list rather than
  // just English: falling back to a different language would answer a Chinese
  // user's refusal in confident English nonsense.
  let crossLanguage = 0;
  for (const option of SPEECH_LANGUAGES) {
    const plan: SpeechLanguage = { tag: option.tag, source: "browser", fromBrowser: "" };
    for (const tag of speechLanguageFallbacks(plan)) {
      if (baseLanguage(tag) !== baseLanguage(option.tag)) crossLanguage += 1;
    }
  }
  check("no language's ladder ever leaves that language", crossLanguage === 0, String(crossLanguage));
});

group("A language the user chose is not second-guessed", () => {
  const chosen = resolveSpeechLanguage("de-DE", ["en-US"]);
  check("there is no ladder at all", speechLanguageFallbacks(chosen).length === 0);
  check("so a refusal is reported rather than answered in English", nextSpeechLanguage([chosen.tag], []) === null);
});

group("The retry cannot loop, which is what keeps the microphone from spinning", () => {
  const chosen = resolveSpeechLanguage("", ["en"]);
  const ladder = speechLanguageFallbacks(chosen);

  const tried = [chosen.tag];
  const first = nextSpeechLanguage(tried, ladder);
  check("the first retry is offered", first !== null, String(first));

  const second = nextSpeechLanguage([...tried, first ?? ""], ladder);
  check("the second is a different tag", second !== first, `${first} then ${second}`);

  // Walk the whole ladder, then insist on an end.
  const walked: string[] = [chosen.tag];
  let step = nextSpeechLanguage(walked, ladder);
  let guard = 0;
  while (step && guard < 50) {
    walked.push(step);
    step = nextSpeechLanguage(walked, ladder);
    guard += 1;
  }
  check("the ladder is finite and terminates", step === null, String(step));
  check(
    "having offered each tag exactly once",
    new Set(walked).size === walked.length,
    JSON.stringify(walked),
  );
  check(
    "and having offered every tag in it",
    ladder.every((tag) => walked.includes(tag)),
    JSON.stringify(walked),
  );
});

/* ------------------------------------------------------------------ */
/* When the browser says nothing useful                                */
/* ------------------------------------------------------------------ */

group("A browser that names no usable language still gets a working tag", () => {
  const empty = resolveSpeechLanguage("", []);
  check("the default is used", empty.tag === DEFAULT_SPEECH_LANGUAGE, empty.tag);
  check("and reported as the default", empty.source === "default", empty.source);

  const junk = resolveSpeechLanguage("", ["", "und", "*"]);
  check("junk preferences fall through to the default", junk.tag === DEFAULT_SPEECH_LANGUAGE, junk.tag);
  check("with nothing falsely attributed to the browser", junk.fromBrowser === "", junk.fromBrowser);

  // A browser preference the list has never heard of is still the best evidence
  // available: the first usable tag wins outright rather than walking on to a
  // language the user did not ask for.
  const unlisted = resolveSpeechLanguage("", ["kl-GL", "en-US"]);
  check("an unlisted language is obeyed rather than skipped", unlisted.tag === "kl-GL", unlisted.tag);
  check("and is not recorded as a correction", unlisted.fromBrowser === "", unlisted.fromBrowser);
});

/* ------------------------------------------------------------------ */
/* The list itself                                                     */
/* ------------------------------------------------------------------ */

group("The curated list is well formed", () => {
  const tags = SPEECH_LANGUAGES.map((option) => option.tag);
  check("no tag is repeated", new Set(tags).size === tags.length);
  check("every tag survives normalisation unchanged", tags.every((tag) => normalizeLanguageTag(tag) === tag));
  check("every tag has a label", SPEECH_LANGUAGES.every((option) => option.label.trim().length > 0));

  // The representative is the first entry for a language, and it is what a bare
  // tag resolves to — so the ordering of this list is a decision, not cosmetics.
  check("the representative of en is the first English", representativeFor("en") === "en-US", representativeFor("en"));
  check("of zh is the first Chinese", representativeFor("zh") === "zh-CN", representativeFor("zh"));
  check("of an unknown language there is none", representativeFor("kl") === "");
  check("a bare tag resolves through its base", representativeFor("en-GB") === "en-US", representativeFor("en-GB"));

  check("variants exclude the tag asked about", !variantsOf("en", "en-US").includes("en-US"));
  check("and are all of that language", variantsOf("en").every((tag) => baseLanguage(tag) === "en"));

  check("a label is readable", languageLabel("en-GB") === "English (United Kingdom)", languageLabel("en-GB"));
  check("an unlisted tag labels as itself", languageLabel("kl-GL") === "kl-GL", languageLabel("kl-GL"));
  check("and nothing labels as empty", languageLabel("") === "", JSON.stringify(languageLabel("")));
});

group("Nothing throws, in a browser or out of one", () => {
  // These modules are imported by client components, so they are also evaluated
  // on the server — but Node 24 defines a global `navigator` (language "en-US"),
  // so this cannot reproduce the server render where it is absent. The guard in
  // `browserLanguages()` is a `typeof` check rather than a branch this can reach.
  // What IS testable is the part that would break a build or a first paint: no
  // input, and no absence of input, produces a throw or an unusable tag.
  const detected = browserLanguages();
  check("the browser's languages are read as an array", Array.isArray(detected), typeof detected);

  const chosen = resolveSpeechLanguage("");
  check("a call with no arguments still yields a tag", chosen.tag.length > 0, chosen.tag);
  check("that is well formed", normalizeLanguageTag(chosen.tag) === chosen.tag, chosen.tag);
  check("and a usable ladder or none, never a broken one",
    speechLanguageFallbacks(chosen).every((tag) => normalizeLanguageTag(tag) === tag),
    JSON.stringify(speechLanguageFallbacks(chosen)),
  );
});

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
