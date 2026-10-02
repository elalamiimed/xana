/**
 * Saying her name, and nothing else.
 *
 * The mic button requires a hand. A wake word removes the hand: the app keeps
 * a recognizer open, watches for its own name at the start of an utterance,
 * and treats what follows as the request. Everything here is a pure function of
 * a transcript, which is the point — the matching rules are the part that can
 * be wrong in ways nobody notices (missing a name, or worse, firing on a
 * sentence that merely contains it), so they live somewhere a test can reach
 * them without a microphone, a browser, or a network.
 *
 * WHY THE MATCH IS SHAPED THIS WAY
 *
 * Speech recognisers do not return the string you said. "Xana" comes back as
 * "Zana", "Xena", "Zara", "Sana", "ex Anna", "Xana's", and with a Chinese or
 * Indian English acoustic model you get a different set again. So matching is
 * on a *normalised* form: lowercased, punctuation dropped, homophone letters
 * folded (z/s/x, ph/f), and a small edit distance allowed for one- and
 * two-syllable slips. Allowing a typo is not sloppiness here — it is the
 * difference between a feature that works once and one that works.
 *
 * The match must be near the START of the transcript. A wake word is how a
 * sentence is *addressed*, not something it contains. Matching anywhere would
 * mean any remark about her — "Xana said the market was closed" — wakes her up
 * and sends the rest of the sentence as a command, which is precisely the
 * failure that makes always-on listening unbearable. The window is one
 * leading filler ("hey", "ok", "hi", "um") plus the name.
 *
 * Every threshold here is a judgement call, so each one is named, explained,
 * and exercised by `scripts/check-wake-word.ts` rather than left as a magic
 * number. Four separate versions of the matching rules were wrong in ways that
 * only that file caught, including one that stopped recognising "okay Xana"
 * while continuing to answer "can I ask you something". If you change anything
 * in here, run it.
 */

/* ================================================================== */
/* Normalisation                                                      */
/* ================================================================== */

/**
 * Letters a recogniser swaps for each other.
 *
 * Not a general-purpose soundex. These are the specific confusions observed for
 * a name beginning with a sibilant: a leading `z` or `s` noisily transcribed as
 * `x`, and `ph`/`f`/`v` collapsing. Folding them means "Zana", "Sana" and
 * "Xana" are one token after normalisation, so the match does not depend on
 * guessing which one the user's accent produces.
 *
 * `c` is deliberately NOT folded even though "Cana" is a plausible mishearing,
 * because the cost is asymmetric: folding it turns `can` into `xan`, one edit
 * from `xana`, and "can I ask you something" then wakes her. Missing a name
 * spelled with a C is a nuisance; answering a question nobody asked is the
 * failure mode that makes an always-on listener unusable.
 */
const FOLDINGS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^[zs]/, "x"],
  [/ph/g, "f"],
  [/v/g, "f"],
];

/** Words that may precede the name without changing the fact that she is being addressed. */
const LEADING_FILLERS: readonly string[] = [
  "hey",
  "hi",
  "ok",
  "okay",
  "yo",
  "um",
  "uh",
  "so",
  "hello",
  "please",
];

/**
 * The default ways of saying her name.
 *
 * Four entries, and every one earns its place. An earlier version also carried
 * "xanna" and "zanna" as "belt and braces", which turned out to be the opposite:
 * a near-variant in the phrase list is an extra target that has to be cleared,
 * and `xanna` is one edit from `cana` — so the redundancy is what let "can a
 * person do that" wake her. Duplicates collapse under `foldToken` anyway, and
 * the spellings they were guarding (`xanna`, `zanna`) already match `xana`
 * through the edit budget, which is the whole point of having one.
 *
 * The folded forms these produce: `xana`, `exanna`, `xena`.
 * Everything within one edit of those is covered by tolerance, which is why
 * Zara, Sara, Dana, Zana and Xanna are absent.
 */
export const DEFAULT_WAKE_PHRASES: readonly string[] = ["xana", "exanna", "xena", "zena"];

/**
 * Lowercase, strip anything that is not a letter or a space, collapse runs of
 * spaces.
 *
 * Apostrophes are *removed* rather than treated as separators, so "Xana's"
 * normalises to "xanas" — one token, still a match, instead of two tokens where
 * the second is a stray "s". Digits are dropped because a recogniser writing
 * "Xana 2" is noise, not a request.
 */
export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’ʼ`]/g, "")
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fold a single token to its comparison form.
 *
 * Applied to both the transcript tokens and the configured phrases, so the two
 * sides of the comparison are always transformed the same way — folding only
 * one side is the classic way this kind of matching silently stops working.
 */
export function foldToken(token: string): string {
  let out = token;
  for (const [pattern, replacement] of FOLDINGS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Levenshtein distance, bounded.
 *
 * Bounded because the only question ever asked is "is this within `max`?", and
 * an unbounded implementation spends its time on tails that cannot change the
 * answer. Standard rolling-row dynamic programming, two rows instead of a
 * matrix.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      const value = Math.min(substitution, insertion, deletion);
      current[j] = value;
      if (value < rowBest) rowBest = value;
    }
    // Every cell in this row already exceeds the budget, so no later row can
    // come back under it.
    if (rowBest > max) return max + 1;
    previous = current;
  }

  return previous[b.length] ?? max + 1;
}

/**
 * How many edits a token may differ by and still count as the name.
 *
 * Length is the honest proxy for how much of the name a token actually carries.
 * Three earlier versions of this were wrong, each in a way only a test caught:
 *
 *   - "no latitude under five letters" rejected `Zana` and `Zara`, which is to
 *     say it rejected the most likely way the user's own name comes back.
 *   - "one bonus edit for sharing an opening sound" let `sonar` through, since
 *     folding makes it `xonar` and three edits then fitted a budget of two.
 *   - A hard length gate (shorter than the name, or more than twice as long)
 *     is now the wrong shape too, because it is the COMBINATION of extra
 *     letters and edits that identifies a different word. `xanadu` adds two
 *     letters and pays with them; `exanna` adds two and only needs one edit, so
 *     it survives.
 */
export function toleranceFor(length: number): number {
  if (length <= 3) return 0;
  if (length <= 6) return 1;
  return 2;
}

/** The comparison form of a whole phrase: normalised, folded, spaces gone. */
function foldPhrase(phrase: string): string {
  return foldToken(normalizeTranscript(phrase).replace(/[^\p{L}]/gu, ""));
}

/**
 * One extra letter is allowed, but only as the doubled sound.
 *
 * A recogniser writes "Xana" as "Xanna" — the middle `n` heard twice — and that
 * must match. `Xanax` is the same length and the same edit distance and must
 * NOT, because it is a word people say for reasons that have nothing to do with
 * her. Arithmetic cannot separate those two: any budget that admits `xanna`
 * admits `xanax`.
 *
 * So the rule is structural. The extra letter has to duplicate the one before
 * it, anywhere in the token — a doubled sound, not an appended letter. An
 * earlier version of this checked only the FINAL letter, which meant it looked
 * for `xanaa` and therefore missed `xanna`, the single most likely spelling of
 * the name by voice.
 */
function paddingIsNotADifferentWord(folded: string, target: string): boolean {
  if (folded.length !== target.length + 1) return false;
  for (let index = 0; index < folded.length; index += 1) {
    if (folded[index] !== folded[index - 1]) continue;
    const collapsed = `${folded.slice(0, index)}${folded.slice(index + 1)}`;
    if (collapsed === target) return true;
  }
  return false;
}

/**
 * Whether a one-edit difference can be forgiven.
 *
 * Folding already handles the opening consonant (`zana`, `sana` → `xana`), so a
 * substitution at position 0 is never a near-miss — it is a different word that
 * happens to look like a shifted version of hers. `cana` is exactly that, and
 * so is `xanax` under a laxer rule. Refusing position 0 is what keeps "can a
 * person do that" and "cana" from waking her while `Dana`, `Zara` and `Sara`
 * still match.
 */
function forgivableEdit(folded: string, target: string): boolean {
  if (folded.length !== target.length) return false;
  let differences = 0;
  for (let index = 0; index < folded.length; index += 1) {
    if (folded[index] === target[index]) continue;
    if (index === 0) return false;
    differences += 1;
    if (differences > 1) return false;
  }
  return differences === 1;
}

/**
 * A candidate shorter than the name carries less of it than the name has, so
 * there is nothing to forgive. `can` is refused here rather than by the edit
 * budget, which matters because the budget grows with the length of the PHRASE
 * and would eventually admit it.
 */
function longEnoughToBeThePhrase(folded: string, target: string): boolean {
  return folded.length >= target.length;
}

/** Whether one transcript token is the name, in any of its spellings. */
export function isWakeToken(token: string, phrases: readonly string[]): boolean {
  // One or two letters is never the name, whatever phrase is configured — a
  // guard against matching `a` and `i`, and against a phrase list edited down
  // to something that would.
  if (token.length < 3) return false;

  const folded = foldToken(token);
  for (const phrase of phrases) {
    const target = foldPhrase(phrase);
    if (!target) continue;
    if (folded === target) return true;
    if (!longEnoughToBeThePhrase(folded, target)) continue;
    // An over-long candidate is ONLY the doubled sound. Failing here is
    // decisive rather than something the budget can rescue.
    if (folded.length > target.length) {
      if (paddingIsNotADifferentWord(folded, target)) return true;
      continue;
    }
    if (forgivableEdit(folded, target)) return true;
  }
  return false;
}

/**
 * A filler glued to the front of a token by a recogniser: "heyzana", "okzana".
 *
 * Only peeled when doing so turns the token into something that could actually
 * be the name, which is what stops it from mangling ordinary words — "history"
 * begins with "hi", and a naive strip would hand the matcher "story".
 */
const GLUED_FILLERS = /^(hey|hi|ok|okay|yo)/;

function stripGluedFiller(token: string, phrases: readonly string[]): string | null {
  const stripped = token.replace(GLUED_FILLERS, "");
  if (stripped === token || stripped === "") return null;
  return isWakeToken(stripped, phrases) ? stripped : null;
}

/* ================================================================== */
/* Matching                                                           */
/* ================================================================== */

export interface WakeMatch {
  /** True when this transcript addresses her. */
  readonly matched: boolean;
  /**
   * What she was asked to do, when anything was.
   *
   * Empty string means the name alone was heard — she should listen for a
   * request rather than treat silence as one.
   */
  readonly command: string;
  /** The token that matched, for diagnostics. Empty when nothing matched. */
  readonly heard: string;
}

const NO_MATCH: WakeMatch = { matched: false, command: "", heard: "" };

/**
 * Decide whether a transcript is addressed to her, and what it asks for.
 *
 * The search window is deliberately one-sided: the name has to appear within
 * the first two tokens (after at most one leading filler). See the module note
 * for why a name in the middle of a sentence must not count.
 */
export function matchWake(
  transcript: string,
  phrases: readonly string[] = DEFAULT_WAKE_PHRASES,
): WakeMatch {
  const normalized = normalizeTranscript(transcript);
  if (!normalized) return NO_MATCH;

  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length === 0) return NO_MATCH;

  const found = findWake(tokens, phrases);
  if (!found) return NO_MATCH;

  const command = tokens.slice(found.end + 1).join(" ");
  const heard = tokens.slice(found.start, found.end + 1).join(" ");
  return { matched: true, command, heard };
}

/**
 * Where the name was found: the token it starts at, and the token it ends at.
 *
 * Two indices rather than one because the two callers need opposite ends. The
 * command is everything after the name, so it slices from `end`; the diagnostic
 * is the name itself, so it reads `start`. Returning only one of them is how
 * "hey zana what's the weather" once produced "zana what's the weather" — the
 * filler was reported as the name's position.
 */
interface WakeLocation {
  readonly start: number;
  readonly end: number;
}

/**
 * Locate the name in the leading window.
 *
 * The first candidate WINS. Short-circuiting is load-bearing: without it a
 * transcript like "can I ask you something" keeps hunting rightwards until
 * something looks name-like, and answering a sentence nobody addressed to her
 * is the failure that makes an always-on listener unbearable.
 */
function findWake(tokens: readonly string[], phrases: readonly string[]): WakeLocation | null {
  // Where the current phrase attempt began. A filler is skipped over rather
  // than ending the search: "hey Xana" and "hey hey Xana" are both addresses,
  // and the alternative is a listener that ignores a user who stammers.
  let start = 0;

  for (let index = 0; index < Math.min(tokens.length, 3); index += 1) {
    const token = tokens[index] ?? "";
    if (!token) continue;

    if (index > 0 && !LEADING_FILLERS.includes(token)) {
      // Not a filler, so — if everything before it was — this is a NEW phrase
      // starting here. The earlier version `break`ed instead, which tested a
      // token's letter length BEFORE testing whether it was the name, and so
      // threw away the name itself: in "okay Xana" the token at index 1 is
      // `xana`, not a filler, and the loop quit one step before finding her.
      const allBeforeWereFillers = tokens
        .slice(0, index)
        .every((earlier) => LEADING_FILLERS.includes(earlier) || earlier === "");
      if (!allBeforeWereFillers) break;
      start = index;
    }

    // A name is not one or two letters, and `isWakeToken` refuses those — but
    // only once it is called. The window's own rule otherwise lets a bare `a`
    // or `i` at the front count as an address.
    if (foldToken(token).length < 3) continue;
    if (isWakeToken(token, phrases)) return { start, end: index };

    // A recogniser that ran the filler into the name: "heyzana", "okzana".
    // Index 0 only: `stripGluedFiller` would otherwise peel the "hi" off
    // "history" and hand the matcher "story".
    if (index === 0 && stripGluedFiller(token, phrases)) return { start: 0, end: 0 };
  }

  // The name split across two tokens, which is what a recogniser returns for
  // "ex anna" and, with a Chinese acoustic model, for "za na". Only the
  // immediate pair is considered, so the window cannot creep rightwards
  // through a sentence hunting for a name that is not there.
  if (tokens.length >= 2) {
    const first = tokens[0] ?? "";
    const second = tokens[1] ?? "";
    // BOTH tokens must carry part of the name, and the second must be a
    // near-miss on its own. Joining anything with anything is too generous:
    // "can" + "a" makes `cana`, which is one edit from `xana`, and that is how
    // "can a person do that" woke her. `anna` is its own near-miss, `a` is not.
    const bothCarryTheName = isWakeToken(second, phrases) || foldToken(second).length >= 3;
    if (bothCarryTheName) {
      const joined = `${first}${second}`;
      if (isWakeToken(joined, phrases) || stripGluedFiller(joined, phrases)) {
        return { start: 0, end: 1 };
      }
    }
  }

  return null;
}

/**
 * Just the request, for callers that have already matched.
 *
 * Split out so a caller can re-run the strip on a longer transcript (interim
 * results grow) without re-deciding whether she was addressed.
 */
export function stripWake(
  transcript: string,
  phrases: readonly string[] = DEFAULT_WAKE_PHRASES,
): string {
  return matchWake(transcript, phrases).command;
}

/**
 * Turn the settings field into a phrase list.
 *
 * Comma-separated because that is what a person types without being taught, and
 * a trailing comma or double space is a typo rather than an instruction to match
 * an empty string — which would be a phrase that matches everything. Empty means
 * "use the built-in list", never "never match", because a field someone cleared
 * by accident should not silently disable the feature.
 */
export function parseWakePhrases(raw: string): readonly string[] {
  const parsed = raw
    .split(",")
    .map((part) => normalizeTranscript(part).replace(/[^\p{L}\s]/gu, " ").trim())
    .filter((part) => part.length >= 2);
  return parsed.length > 0 ? parsed : DEFAULT_WAKE_PHRASES;
}

/* ================================================================== */
/* Restart policy: keeping the recogniser alive                       */
/* ================================================================== */

/**
 * The browser will not keep a recogniser open, so it has to be restarted — and
 * the way it ends decides whether restarting is right.
 *
 * This is where always-on listening is actually won or lost. A recogniser that
 * ends after a silence is normal and must be restarted. A recogniser that ended
 * because permission was refused must NOT be: retrying against a refusal spins
 * the CPU, re-prompts the user, and looks like the app is fighting them.
 */
export type WakeEnd =
  | "silence"
  | "error-not-allowed"
  | "error-service"
  | "error-audio"
  | "error-language"
  | "error-network"
  | "error-other"
  | "stopped";

export interface RestartDecision {
  /** Whether to start a new recogniser immediately. */
  readonly restart: boolean;
  /**
   * Milliseconds to wait first.
   *
   * A small delay is not politeness: Chromium throws `InvalidStateError` when a
   * new recogniser starts in the same tick as the previous one ending, so the
   * gap is load-bearing.
   */
  readonly delayMs: number;
  /** A sentence for the user, when they need to know why it stopped. */
  readonly note: string;
  /** True when the loop should give up entirely rather than back off. */
  readonly fatal: boolean;
}

/** Grows with repeated rapid endings, so a broken loop cannot pin a core. */
export function backoffFor(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const steps = [600, 1200, 2400, 5000, 10000];
  return steps[Math.min(consecutiveFailures - 1, steps.length - 1)] ?? 10000;
}

/**
 * Whether to bring the listener back, and how long to wait.
 *
 * Called with how the recogniser ended and how many times in a row it has ended
 * that way. A silence is never a failure: it is the normal end of an utterance
 * and restarts with no delay. Permission and service problems are terminal —
 * the user has to change something, and looping would only hide that.
 */
export function planRestart(end: WakeEnd, consecutiveFailures = 0): RestartDecision {
  switch (end) {
    case "silence":
      return { restart: true, delayMs: 0, note: "", fatal: false };
    case "stopped":
      return { restart: false, delayMs: 0, note: "", fatal: true };
    case "error-not-allowed":
      return {
        restart: false,
        delayMs: 0,
        fatal: true,
        note: "Always-listening needs microphone access. Allow it for this page, then switch listening back on.",
      };
    case "error-service":
      return {
        restart: false,
        delayMs: 0,
        fatal: true,
        note: "This browser's speech service is unavailable, so she cannot watch for her name. The mic button and typing still work.",
      };
    case "error-audio":
      return {
        restart: false,
        delayMs: 0,
        fatal: true,
        note: "No microphone was found. Plug one in, then switch listening back on.",
      };
    case "error-language":
      /**
       * Reached only after the app has tried every tag of the language it has.
       *
       * A refused language is not something the user fixes in their browser: the
       * tag is chosen here, it is normalised here, and it is retried here (see
       * `speech-language.ts`). So the note names the setting that overrides the
       * choice rather than sending the user to a browser language menu — which is
       * what it used to do, for a failure the app had caused by sending a bare
       * `en` to a service that wanted a locale.
       */
      return {
        restart: false,
        delayMs: 0,
        fatal: true,
        note: "This browser's speech service will not recognise the dictation language in use, so she cannot watch for her name. Set it in Settings → Voice → Dictation language, or use the mic button.",
      };
    case "error-network":
      /**
       * Terminal, not transient, and this is a deliberate refusal to retry.
       *
       * The browser's recogniser does not transcribe anything itself — it sends
       * the audio to a speech service. When that service is unreachable, every
       * attempt fails with `network` immediately and identically, so retrying
       * four times against a blocked socket only delays the truth and burns the
       * user's patience. The diagnosis that produced this case showed ten
       * consecutive `network` errors with a microphone that opened every time.
       *
       * The note names the way out rather than the symptom, because the browser
       * engine has no local fallback of its own — the local transcriber is a
       * separate engine the user has to select.
       */
      return {
        restart: false,
        delayMs: 0,
        fatal: true,
        note: "The browser cannot reach its speech service, so it cannot watch for her name — retrying will not help. Switch Settings → Voice → Transcription to the local transcriber, or use the mic button.",
      };
    case "error-other":
      // A transient error is worth a backoff, but only a few times.
      return consecutiveFailures >= 4
        ? {
            restart: false,
            delayMs: 0,
            fatal: true,
            note: "Listening kept failing, so I stopped. Switch it back on to try again.",
          }
        : { restart: true, delayMs: backoffFor(consecutiveFailures), note: "", fatal: false };
    default:
      return { restart: false, delayMs: 0, note: "", fatal: true };
  }
}

/** Maps a Web Speech API error name onto the policy above. */
export function endFromError(error: string): WakeEnd {
  switch (error) {
    case "not-allowed":
    case "permission-denied":
      return "error-not-allowed";
    case "service-not-allowed":
      return "error-service";
    case "audio-capture":
      return "error-audio";
    case "language-not-supported":
      return "error-language";
    case "network":
      // Its own case rather than falling through to "transient". See the note in
      // `planRestart`: a blocked speech service never becomes reachable by
      // waiting, so retrying is pure delay.
      return "error-network";
    case "no-speech":
    case "aborted":
      // `no-speech` is a timeout, not a fault: the listener simply heard
      // nothing for a while and must come straight back.
      return "silence";
    default:
      return "error-other";
  }
}

/** The policy for an `onend` that arrived without an error. */
export function endFromSilence(): WakeEnd {
  return "silence";
}
