/**
 * Saying her name: the hits, and — more importantly — the misses.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-wake-word.ts
 *
 * WHY THIS FILE LEANS ON FALSE POSITIVES
 *
 * A wake word has two failure modes and they are not symmetric. Missing the
 * name is annoying and instantly obvious: the user says "Xana" and nothing
 * happens, so they say it again. Firing on a sentence that merely *contains*
 * the name is silent and corrosive — an always-on listener that wakes up
 * during a conversation about her, swallows the rest of the sentence as a
 * command, and answers it. The user cannot tell that happened; they only learn
 * that the thing is unreliable and stop trusting it.
 *
 * So the negative cases below are the point of the file, not the extras. Every
 * one of them is a sentence a person could really say in a room with a
 * microphone, and half of them are near-misses by construction: "banana" and
 * "anaconda" contain the name as a substring, "Zara" is one edit away, "can a"
 * is two tokens that join into something close.
 *
 * NO BROWSER, NO MICROPHONE, NO NETWORK
 *
 * Everything here is a pure function of a string. That is the whole reason
 * matching lives in `wake-word.ts` away from the recogniser: the part of
 * always-on listening that can be wrong invisibly is testable without any of
 * the hardware, and the part that needs hardware is a thin wrapper over it.
 *
 * The fixtures are also consumed by the Python sidecar (`python/xana_stt.py
 * --wake-selftest`), which ports the same algorithm. If you change a case here,
 * change it there too — a divergence means the two halves of the feature
 * disagree about when she was called.
 */

import {
  DEFAULT_WAKE_PHRASES,
  backoffFor,
  editDistance,
  endFromError,
  foldToken,
  isWakeToken,
  matchWake,
  normalizeTranscript,
  planRestart,
  stripWake,
  toleranceFor,
} from "../src/components/xana/wake-word";

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

/** Groups one subject per heading so a failure says what part broke. */
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
/* Normalisation and folding                                           */
/* ------------------------------------------------------------------ */

group("Normalisation does not throw away the words", () => {
  check(
    "punctuation becomes a separator",
    normalizeTranscript("Xana, what's the weather?") === "xana whats the weather",
    normalizeTranscript("Xana, what's the weather?"),
  );
  check(
    "apostrophes join rather than split",
    normalizeTranscript("Xana's notes") === "xanas notes",
    normalizeTranscript("Xana's notes"),
  );
  check("case is irrelevant", normalizeTranscript("ZANA") === "zana");
  check("runs of whitespace collapse", normalizeTranscript("  hey   Xana  ") === "hey xana");
  check("an em dash separates", normalizeTranscript("Xana—stop") === "xana stop", normalizeTranscript("Xana—stop"));
  check("digits are dropped as noise", normalizeTranscript("Xana 2") === "xana");
  check("empty in, empty out", normalizeTranscript("   ") === "");
  // Non-Latin letters must survive, because `\p{L}` is what makes that true and
  // a careless `[a-z]` would silently drop them. The word is assembled from code
  // points rather than written out, for the same reason the encoding guard
  // assembles its own patterns: `scripts/check-encoding.mjs` treats CJK in the
  // source as evidence of a codepage round trip, and it is right to.
  const han = String.fromCharCode(0x5929, 0x6c14);
  check(
    "non-Latin letters survive",
    normalizeTranscript(`xana ${han}`) === `xana ${han}`,
    normalizeTranscript(`xana ${han}`),
  );
  check("non-Latin letters are not treated as separators", normalizeTranscript(han) === han);
});

group("Folding is symmetric, which is the only way it works", () => {
  check("z folds to x", foldToken("zana") === "xana", foldToken("zana"));
  check("s folds to x", foldToken("sana") === "xana", foldToken("sana"));
  check("an untouched token is unchanged", foldToken("xana") === "xana");
  check("v folds to f", foldToken("vera") === "fera", foldToken("vera"));
  // `c` is NOT folded, and this is the reason: folding it makes `can` one edit
  // from `xana`, which wakes her on "can I ask you something".
  check("c is deliberately not folded", foldToken("cana") === "cana", foldToken("cana"));
  // The folding is applied to phrases too, so a phrase that is already folded
  // and one that is not must agree.
  check("a folded phrase matches itself", isWakeToken("zana", ["xana"]));
  check("an unfolded phrase matches a folded token", isWakeToken("xana", ["zana"]));
});

group("Tolerance is earned by length, and by sharing an opening sound", () => {
  check("three letters or fewer get nothing", toleranceFor(3) === 0);
  check("four letters get one edit", toleranceFor(4) === 1, String(toleranceFor(4)));
  check("ten letters get two", toleranceFor(10) === 2, String(toleranceFor(10)));
});

group("Bounded edit distance still measures distance correctly", () => {
  check("identical is zero", editDistance("xana", "xana", 2) === 0);
  check("one substitution is one", editDistance("xana", "xena", 2) === 1, String(editDistance("xana", "xena", 2)));
  check("one insertion is one", editDistance("xana", "xanna", 2) === 1, String(editDistance("xana", "xanna", 2)));
  check("one deletion is one", editDistance("xanna", "xana", 2) === 1, String(editDistance("xanna", "xana", 2)));
  check(
    "a transposition counts as two edits, not one",
    editDistance("xana", "xnaa", 3) === 2,
    String(editDistance("xana", "xnaa", 3)),
  );
  // The bound has to be *exceeded*, not merely hit, or a caller asking "is this
  // within 1?" cannot tell one edit from two.
  check("a distance over the bound is reported above it", editDistance("xana", "banana", 2) > 2);
  check("the early exit does not report a false zero", editDistance("xana", "zzzz", 1) > 1);
  check("empty against a word is the word's length", editDistance("", "xana", 4) === 4);
});

/* ------------------------------------------------------------------ */
/* The hits                                                            */
/* ------------------------------------------------------------------ */

group("The name alone means she was called, not that she was asked anything", () => {
  for (const said of ["Xana", "xana", "Xana!", "Xana?", "Zana", "Sana", "Xena", "exanna", "Xanna"]) {
    const match = matchWake(said);
    check(`"${said}" is addressed to her`, match.matched, JSON.stringify(match));
    check(`"${said}" carries no command`, match.matched && match.command === "", match.command);
  }
});

group("A filler in front of the name is still an address", () => {
  for (const said of ["Hey Xana", "hey xana", "OK Xana", "okay, xana", "Hi Xana", "Yo Xana", "hello Xana"]) {
    const match = matchWake(said);
    check(`"${said}" is addressed to her`, match.matched, JSON.stringify(match));
    check(`"${said}" carries no command`, match.matched && match.command === "", match.command);
  }
});

group("The request is what follows the name — not the name, and not the filler", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["Xana what's the weather", "whats the weather"],
    ["Xana, what's the weather?", "whats the weather"],
    ["hey Xana what's the weather", "whats the weather"],
    ["OK Xana, add milk to my list", "add milk to my list"],
    ["Hey Zana, what is on my calendar", "what is on my calendar"],
    ["Xana: how are the markets", "how are the markets"],
    ["xana remind me to call mum", "remind me to call mum"],
    // Two fillers: the window stops at the name either way, and a listener that
    // ignores a stammer is a listener that has to be shouted at.
    ["hey hey xana what time is it", "what time is it"],
    ["um, Xana, are you there", "are you there"],
  ];
  for (const [said, expected] of cases) {
    check(`"${said}" -> "${expected}"`, matchWake(said).command === expected, matchWake(said).command);
  }
});

group("A recogniser that splits or runs the name together is still understood", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["ex anna what's up", "whats up"],
    ["hey zana what's the weather", "whats the weather"],
    ["heyzana what's the weather", "whats the weather"],
    ["okzana stop", "stop"],
  ];
  for (const [said, expected] of cases) {
    const match = matchWake(said);
    check(`"${said}" -> "${expected}"`, match.matched && match.command === expected, JSON.stringify(match));
  }
});

group("The near-miss spellings an acoustic model actually returns", () => {
  for (const said of ["Zara", "Sara", "Zena", "zanna", "Xanna"]) {
    check(`"${said}" is close enough to the name`, matchWake(said).matched, JSON.stringify(matchWake(said)));
  }
  // Each of these is one step past the line, and the reason is worth recording
  // because it is the same reason three times: the OPENING sound is not hers.
  // Folding exists to handle that position (`zana`, `sana` → `xana`), so a
  // substitution there is a different word rather than a near-miss, and
  // accepting them is how "can a person do that" wakes her.
  check('"cana" is refused, because `c` is not folded', !matchWake("cana").matched);
  check('"Dana" is refused: position 0 is folding\'s job', !matchWake("Dana").matched);
  check('"xanadu" is refused as a different word', !matchWake("xanadu").matched);
  check('"Xanax" is refused as a different word', !matchWake("Xanax").matched);
  // The escape hatch: a user whose name really does come back as "Dana" adds it
  // to the phrase list, and then it matches — without loosening the default for
  // everybody.
  check("a configured phrase overrides the strictness", matchWake("Dana", ["dana"]).matched);
});

/* ------------------------------------------------------------------ */
/* The misses — the reason this file exists                            */
/* ------------------------------------------------------------------ */

group("The name in the middle of a sentence must NOT wake her", () => {
  // This is the failure that makes always-on listening unbearable: any remark
  // about her wakes her, and the rest of the sentence becomes a command.
  const sentences = [
    "I told Xana to remind me",
    "I asked Xana about the weather yesterday",
    "does xana work offline",
    "the notes xana wrote are wrong",
    "what did xana say about the meeting",
    "I wish xana would stop interrupting",
    "so anyway xana said the markets were closed",
  ];
  for (const said of sentences) {
    const match = matchWake(said);
    check(`"${said}" does not wake her`, !match.matched, JSON.stringify(match));
  }
});

group("Ordinary speech that merely sounds like the name must NOT wake her", () => {
  const sentences = [
    "can I ask you something",
    "can a person do that",
    "the banana is ripe",
    "anaconda is a long snake",
    "the analysis is done",
    "anyway I was saying",
    "in a minute",
    "a nana would know",
    "sonar is a kind of radar",
    "I need a nap",
  ];
  for (const said of sentences) {
    const match = matchWake(said);
    check(`"${said}" does not wake her`, !match.matched, JSON.stringify(match));
  }
});

group("Single letters and stray words are never the name", () => {
  for (const said of ["a", "i", "an", "in", "on", "so", "the", "is", "ok", "hey"]) {
    const match = matchWake(said);
    check(`"${said}" does not wake her`, !match.matched, JSON.stringify(match));
  }
  check("an empty transcript matches nothing", !matchWake("").matched);
  check("whitespace matches nothing", !matchWake("   ").matched);
  check("punctuation alone matches nothing", !matchWake("...").matched);
  check("punctuation and spaces match nothing", !matchWake(" , . ").matched);
  // A single letter is refused even when a phrase is handed in that would
  // otherwise match it, so the guard is structural rather than incidental.
  check("a one-letter token is refused outright", !isWakeToken("a", ["a"]));
  check("a two-letter token is refused outright", !isWakeToken("an", ["an"]));
});

group("A sentence that begins with something else is not an address", () => {
  check('"the xana is offline" does not wake her', !matchWake("the xana is offline").matched);
  check('"when xana is ready tell me" does not wake her', !matchWake("when xana is ready tell me").matched);
  check('"if xana can do it" does not wake her', !matchWake("if xana can do it").matched);
  // "please" is a filler, so this one IS an address — "please, Xana, tell me"
  // is how a person asks. Filler is not the same as a sentence opener.
  check('"please xana tell me" does wake her', matchWake("please xana tell me").matched);
  check(
    "and the request survives",
    matchWake("please xana tell me").command === "tell me",
    matchWake("please xana tell me").command,
  );
  // But the name has to be within the window, and a filler is the only thing
  // allowed in front of it.
  check('"I think xana should" does not wake her', !matchWake("I think xana should").matched);
});

group("The window is bounded, so a long rambling sentence cannot reach far enough", () => {
  const long = `${"word ".repeat(40)}xana what is the weather`;
  check("the name beyond the window does not match", !matchWake(long).matched);
  const nearStart = "word xana what is the weather";
  // "word" is not a filler, so the name at index 1 is out of the window.
  check("a non-filler before the name blocks the match", !matchWake(nearStart).matched);
});

/* ------------------------------------------------------------------ */
/* Cases that are knowingly wrong, recorded rather than hidden         */
/* ------------------------------------------------------------------ */

group("Known limits, asserted so a future change is a decision and not a surprise", () => {
  // "Zara" is a real name one edit from hers, and the tolerance that makes
  // "Zana" work necessarily makes "Zara" work too. Tightening this would cost
  // the common case, so the trade is named here instead of papered over.
  check("the name Zara is a false positive by design", matchWake("Zara what's the weather").matched);
  check(
    "and it is answered, not swallowed",
    matchWake("Zara what's the weather").command === "whats the weather",
    matchWake("Zara what's the weather").command,
  );
});

/* ------------------------------------------------------------------ */
/* Restart policy: the part that decides whether always-on survives    */
/* ------------------------------------------------------------------ */

group("Silence is the normal end of an utterance and restarts immediately", () => {
  const decision = planRestart("silence", 0);
  check("restart is requested", decision.restart);
  check("with no delay", decision.delayMs === 0, String(decision.delayMs));
  check("and nothing is said to the user", decision.note === "", decision.note);
  check("it is not fatal", !decision.fatal);
});

group("A refused permission stops the loop instead of fighting the user", () => {
  const decision = planRestart("error-not-allowed", 0);
  check("no restart", !decision.restart);
  check("fatal", decision.fatal);
  check("the note names the fix", /microphone access/i.test(decision.note), decision.note);
  check(
    "even after many failures",
    planRestart("error-not-allowed", 99).restart === false,
  );
});

group("A missing microphone and a dead speech service are both terminal", () => {
  check("no microphone is fatal", planRestart("error-audio", 0).fatal);
  check("a dead service is fatal", planRestart("error-service", 0).fatal);
  check("both say something", planRestart("error-audio", 0).note.length > 0 && planRestart("error-service", 0).note.length > 0);
  check("an intentional stop never restarts", !planRestart("stopped", 0).restart);
});

group("A transient error backs off, then gives up rather than spinning", () => {
  check("the first transient error restarts", planRestart("error-other", 1).restart);
  check("after a delay", planRestart("error-other", 1).delayMs > 0, String(planRestart("error-other", 1).delayMs));
  check("the delay grows", backoffFor(2) > backoffFor(1));
  check("the delay is capped", backoffFor(50) === 10000, String(backoffFor(50)));
  check("no failures means no delay", backoffFor(0) === 0);
  check("but only a few times", !planRestart("error-other", 4).restart);
  check("and it tells the user it stopped", planRestart("error-other", 4).note.length > 0);
});

group("Error names map onto the policy the way the API means them", () => {
  check("not-allowed is a permission problem", endFromError("not-allowed") === "error-not-allowed");
  check("service-not-allowed is a service problem", endFromError("service-not-allowed") === "error-service");
  check("audio-capture is a hardware problem", endFromError("audio-capture") === "error-audio");
  // `no-speech` is a timeout, not a fault: treating it as an error would back
  // off after every quiet moment and make the listener feel broken.
  check("no-speech is just silence", endFromError("no-speech") === "silence");
  check("aborted is just silence", endFromError("aborted") === "silence");
  // Not folded into "other": a language the browser cannot recognise never
  // starts working by being retried, so backing off four times would just retry
  // four times and then stop with a misleading note.
  check("an unsupported language is terminal", endFromError("language-not-supported") === "error-language");
  check("and it is fatal", planRestart("error-language", 0).fatal);
  check("with something the user can act on", /language/i.test(planRestart("error-language", 0).note));
  check("an unknown error is transient, not fatal on sight", endFromError("something-new") === "error-other");
});

/* ------------------------------------------------------------------ */
/* The phrase list is data, and editing it must be safe                */
/* ------------------------------------------------------------------ */

group("The default phrase list is the one the tests assume", () => {
  check("it is not empty", DEFAULT_WAKE_PHRASES.length > 0);
  check("it is lowercase, because matching normalises", DEFAULT_WAKE_PHRASES.every((p) => p === p.toLowerCase()));
  check("every phrase matches itself", DEFAULT_WAKE_PHRASES.every((p) => matchWake(p).matched));
  // An empty list means "never wake", which is a legitimate configuration and
  // must not crash or match everything.
  check("an empty phrase list never matches", !matchWake("xana hello", []).matched);
  check("a custom nickname works", matchWake("jarvis what's up", ["jarvis"]).matched);
  check(
    "and its command survives",
    matchWake("jarvis what's up", ["jarvis"]).command === "whats up",
    matchWake("jarvis what's up", ["jarvis"]).command,
  );
  // stripWake must agree with matchWake, since it is defined in terms of it.
  for (const said of ["hey xana what's up", "xana", "banana", "I asked xana"]) {
    check(`stripWake agrees with matchWake for "${said}"`, stripWake(said) === matchWake(said).command);
  }
});

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
