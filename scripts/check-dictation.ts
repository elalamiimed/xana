/**
 * Dictation survives a pause.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-dictation.ts
 *
 * WHAT THIS PROVES, AND WHY IT NEEDS PROVING
 *
 * The bug this guards against was silent and destructive: the recogniser ends
 * its session after a few seconds of quiet, the loop starts another, and the new
 * session's result list is empty — so rebuilding the text field from that list
 * deleted everything said before the pause. Nothing errored, nothing was logged,
 * and the only symptom was words disappearing while the user watched.
 *
 * It cannot be reproduced in a browser on demand, because it needs a real pause
 * in the middle of a real sentence. It CAN be reproduced exactly here, because
 * the accumulation is a pure function of the event stream. So the fixtures below
 * are written as the event stream Chromium actually emits, session boundary
 * included, and the assertions are about the words that survive it.
 *
 * The event shape is worth reading once, because the whole bug lives in it:
 * `event.results` is the list for the CURRENT session and is re-sent in full on
 * every event, while `event.resultIndex` says how much of it is new.
 *
 * The last groups are two unrelated questions that are decided in code and
 * useless in a browser: which engine the microphone button means and whether it
 * should exist at all, and whether a press of it was a question or a
 * continuation. The first used to be answered twice — once for the button, once
 * for the click — and the two answers disagreed, which is what a pure function
 * with a test is for.
 */

import {
  EMPTY_DICTATION,
  accumulate,
  dictationText,
  type DictationEvent,
  type DictationState,
} from "../src/components/xana/dictation";
import { planDictation, spokenInputMode } from "../src/components/xana/speech";

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
/* Building the event stream the way the browser does                  */
/* ------------------------------------------------------------------ */

/**
 * A recogniser session, as an event source.
 *
 * `results` is the session's full list and grows; `say(...)` pushes a result and
 * returns the event a browser would fire for it. This is deliberately a faithful
 * little state machine rather than a hand-written array of events, because a
 * hand-written array is where a wrong assumption about the API would hide.
 */
function session() {
  const results: { isFinal: boolean; text: string }[] = [];

  const eventFor = (resultIndex: number): DictationEvent => {
    const list: Record<number, { isFinal: boolean; 0: { transcript: string } }> = {};
    for (let index = 0; index < results.length; index += 1) {
      const entry = results[index];
      if (!entry) continue;
      list[index] = { isFinal: entry.isFinal, 0: { transcript: entry.text } };
    }
    return {
      resultIndex,
      results: Object.assign(list, { length: results.length }) as DictationEvent["results"],
    };
  };

  return {
    /** A partial result that the recogniser may still revise. */
    interim(text: string, index = results.length): DictationEvent {
      results[index] = { isFinal: false, text };
      return eventFor(index);
    },
    /** A settled result. */
    final(text: string, index = results.length): DictationEvent {
      results[index] = { isFinal: true, text };
      return eventFor(index);
    },
  };
}

/** Feed a sequence of events through the accumulator. */
function run(events: DictationEvent[], from: DictationState = EMPTY_DICTATION): DictationState {
  let state = from;
  for (const event of events) state = accumulate(state, event);
  return state;
}

/**
 * The same, but marking the first event as belonging to a NEW recogniser.
 *
 * That is what the Composer does in `onend`, and it is the caller's job because
 * only the caller knows the session ended — see the note in `dictation.ts` on
 * why inferring it from the event was wrong.
 */
function runNewSession(events: DictationEvent[], from: DictationState): DictationState {
  let state = from;
  events.forEach((event, index) => {
    state = accumulate(state, event, index === 0);
  });
  return state;
}

/* ------------------------------------------------------------------ */
/* The bug this file exists for                                        */
/* ------------------------------------------------------------------ */

group("A session that ends mid-sentence does not take the words with it", () => {
  // What the user says: "remind me to call" — pause — "my mother tomorrow".
  // Chromium ends the session during the pause, so the tail arrives in a
  // SECOND session whose result list starts empty.
  const first = session();
  const second = session();

  const afterPause = run([first.final("remind me to call", 0)]);
  check("the first session is kept", afterPause.committed === "remind me to call", afterPause.committed);

  // The new session's first event is marked as belonging to a new recogniser —
  // that flag is what `onend` supplies.
  const afterResume = runNewSession([second.final("my mother tomorrow", 0)], afterPause);
  check(
    "the second session appends instead of replacing",
    afterResume.committed === "remind me to call my mother tomorrow",
    afterResume.committed,
  );
  check(
    "and the whole sentence is what the field shows",
    dictationText(afterResume) === "remind me to call my mother tomorrow",
    dictationText(afterResume),
  );
  // The precise failure of the old implementation, asserted as its own check so
  // a regression names itself.
  check(
    "the words before the pause are NOT dropped",
    dictationText(afterResume).includes("remind me to call"),
    dictationText(afterResume),
  );
});

group("A partial result is replaced, not appended", () => {
  const s = session();
  let state = run([s.interim("remind", 0)]);
  check("the first guess is shown", dictationText(state) === "remind", dictationText(state));

  state = accumulate(state, s.interim("remind me", 0));
  check("a better guess replaces it", dictationText(state) === "remind me", dictationText(state));

  state = accumulate(state, s.interim("remind me to", 0));
  check("and keeps replacing", dictationText(state) === "remind me to", dictationText(state));
  check(
    "no doubling has occurred",
    dictationText(state) === "remind me to" && !dictationText(state).includes("remind me remind"),
    dictationText(state),
  );
});

group("A partial becoming final is written once, and the tail is settled", () => {
  const s = session();
  let state = run([s.interim("remind me", 0)]);
  check("shown as a tail", dictationText(state) === "remind me", dictationText(state));

  state = accumulate(state, s.final("remind me to call", 0));
  check("committed", state.committed === "remind me to call", state.committed);
  check("and the tail is gone", state.interim === "", JSON.stringify(state.interim));
  check(
    "so it is not shown twice",
    dictationText(state) === "remind me to call",
    dictationText(state),
  );
});

group("A final result repeated by the browser is not written twice", () => {
  // Chromium re-sends the previous final on the event carrying the next interim.
  const s = session();
  let state = run([s.final("hello world", 0)]);
  const once = state.committed;

  state = accumulate(state, s.interim(" and", 1));
  state = accumulate(state, s.final("hello world", 0)); // the repeat
  check("the sentence did not gain a duplicate", state.committed === once, state.committed);
  // The tail is stored trimmed — see `dictationText` for why — so the assertion
  // is the text the user reads, not the internal spacing.
  check("and the new tail survived it", state.interim === "and", JSON.stringify(state.interim));
  check("so the field reads sensibly", dictationText(state) === "hello world and", dictationText(state));
});

group("Honouring resultIndex is what stops the sentence multiplying", () => {
  const s = session();
  let state = run([s.final("one", 0)]);
  state = accumulate(state, s.final("two", 1));
  check("the correct implementation reads each result once", state.committed === "one two", state.committed);

  // Re-reading the whole list on every event is the naïve implementation. Built
  // here as the literal thing it is — two events, each carrying the full list of
  // its session — so the failure it causes is visible rather than asserted.
  const makeList = (entries: { isFinal: boolean; text: string }[]) => {
    const list: Record<number, { isFinal: boolean; 0: { transcript: string } }> = {};
    entries.forEach((entry, index) => {
      list[index] = { isFinal: entry.isFinal, 0: { transcript: entry.text } };
    });
    return Object.assign(list, { length: entries.length }) as DictationEvent["results"];
  };
  const firstList = makeList([{ isFinal: true, text: "one" }]);
  const bothList = makeList([
    { isFinal: true, text: "one" },
    { isFinal: true, text: "two" },
  ]);

  let naive = "";
  for (const results of [firstList, bothList]) {
    for (let index = 0; index < results.length; index += 1) {
      const text = results[index]?.[0]?.transcript ?? "";
      naive = naive ? `${naive} ${text}` : text;
    }
  }
  check("the naïve one reads the list twice and doubles the sentence", naive === "one one two", naive);
});

group("An event carrying a final and the next interim keeps both", () => {
  // The case that made an earlier fix wrong: clearing the tail after the loop
  // rather than when the final is committed threw the new sentence away.
  const s = session();
  let state = run([s.interim("remind me", 0)]);
  state = accumulate(state, s.final("remind me", 0));

  const mixed = session();
  mixed.final("remind me", 0);
  mixed.interim(" and also", 1);
  state = accumulate(state, mixed.final("remind me", 0)); // repeat, ignored
  check("the repeated final is ignored", state.committed === "remind me", state.committed);
  check(
    "and the next sentence's tail is still shown",
    dictationText(state) === "remind me and also",
    dictationText(state),
  );
});

/* ------------------------------------------------------------------ */
/* Edges                                                               */
/* ------------------------------------------------------------------ */

group("Empty and malformed input changes nothing and throws nothing", () => {
  const before: DictationState = {
    committed: "keep me",
    interim: "and me",
    committedCount: 1,
    lastFinal: "keep me",
  };

  const noResults: DictationEvent = { resultIndex: 1, results: { length: 0 } };
  const emptyEvent = accumulate(before, noResults);
  // The tail is REBUILT from the event, not carried: an event that mentions no
  // results is an event in which the recogniser has nothing to say about the
  // unsettled words. `before.committedCount` is 1 and the event has no result at
  // index 1, so there is no tail to show — and the committed words, which are
  // the ones that matter, are untouched.
  check("an empty event keeps what was committed", emptyEvent.committed === "keep me", emptyEvent.committed);
  check("and shows no tail", emptyEvent.interim === "", JSON.stringify(emptyEvent.interim));

  const blank: DictationEvent = {
    resultIndex: 1,
    results: { length: 2, 1: { isFinal: true, 0: { transcript: "   " } } },
  };
  const blanked = accumulate(before, blank);
  check("a whitespace-only final commits nothing", blanked.committed === "keep me", blanked.committed);
  check("but its index is still accounted for", blanked.committedCount === 2, String(blanked.committedCount));
  check("so the tail is no longer waiting", blanked.interim === "", JSON.stringify(blanked.interim));

  // A hole in the list — the browser can send a sparse results object.
  const sparse: DictationEvent = {
    resultIndex: 0,
    results: { length: 3, 2: { isFinal: true, 0: { transcript: "third" } } },
  };
  check("a sparse list is survived", accumulate(EMPTY_DICTATION, sparse).committed === "third");
});

group("A new session resets the tail but never the committed words", () => {
  const before: DictationState = {
    committed: "said earlier",
    interim: "half a",
    committedCount: 3,
    lastFinal: "said earlier",
  };
  const s = session();
  let state = accumulate(before, s.interim("new words", 0), true);
  check("the old tail is dropped", state.interim === "new words", JSON.stringify(state.interim));
  check("the committed words survive", state.committed === "said earlier", state.committed);
  check("and the index boundary restarts", state.committedCount === 0, String(state.committedCount));
  check(
    "so the field reads as one continuous transcript",
    dictationText(state) === "said earlier new words",
    dictationText(state),
  );

  // A second event in that same new session must keep committing forward rather
  // than starting over.
  state = accumulate(state, s.final("new words", 0));
  state = accumulate(state, s.interim("and more", 1));
  check(
    "the new session continues from where it was",
    dictationText(state) === "said earlier new words and more",
    dictationText(state),
  );
});

group("Whitespace between chunks is cleaned up", () => {
  const s = session();
  let state = run([s.final("hello", 0)]);
  state = accumulate(state, s.final("world", 1));
  check("no doubled spaces", state.committed === "hello world", JSON.stringify(state.committed));
  check("no leading space", !dictationText(state).startsWith(" "), JSON.stringify(dictationText(state)));

  const t = session();
  let trimmed = run([t.final("  spaced  ", 0)]);
  check("surrounding whitespace is trimmed", trimmed.committed === "spaced", JSON.stringify(trimmed.committed));
  trimmed = accumulate(trimmed, t.final("out", 1));
  check("and joining still reads correctly", trimmed.committed === "spaced out", trimmed.committed);
});

group("A new session resets the tail but never the committed words", () => {
  const before: DictationState = {
    committed: "said earlier",
    interim: "half a",
    committedCount: 3,
    lastFinal: "said earlier",
  };
  const s = session();
  let state = accumulate(before, s.interim("new words", 0), true);
  check("the old tail is dropped", state.interim === "new words", JSON.stringify(state.interim));
  check("the committed words survive", state.committed === "said earlier", state.committed);
  check("and the index boundary restarts", state.committedCount === 0, String(state.committedCount));
  check(
    "so the field reads as one continuous transcript",
    dictationText(state) === "said earlier new words",
    dictationText(state),
  );

  // A second event in that same new session must keep committing forward rather
  // than starting over.
  state = accumulate(state, s.final("new words", 0));
  state = accumulate(state, s.interim("and more", 1));
  check(
    "the new session continues from where it was",
    dictationText(state) === "said earlier new words and more",
    dictationText(state),
  );
});

group("A press of the microphone is a question or a continuation, and the box decides", () => {
  /**
   * The report this covers: *"when I ask a question she does not answer it."*
   * The microphone worked — it transcribed the question into the field and
   * stopped, which is right for dictation and useless for asking. The only
   * signal that separates the two from outside is whether the user was already
   * writing, and this is that decision, named.
   */
  const empty = spokenInputMode("");
  check("an empty box means a question", empty === "question", empty);
  check("so does a box holding only whitespace", spokenInputMode("   ") === "question");
  check("and a newline is not writing either", spokenInputMode("\n\t ") === "question");

  const drafted = spokenInputMode("remind me to");
  check("text in the box means dictation", drafted === "dictation", drafted);
  check("however little of it there is", spokenInputMode("a") === "dictation");
  check("and leading space does not hide it", spokenInputMode("  hello") === "dictation");
});

group("The initial state is genuinely empty", () => {
  check("committed is empty", EMPTY_DICTATION.committed === "");
  check("interim is empty", EMPTY_DICTATION.interim === "");
  check("the text is empty", dictationText(EMPTY_DICTATION) === "");
  check("so nothing is rendered before speech", dictationText(EMPTY_DICTATION).length === 0);
});

/* ------------------------------------------------------------------ */
/* Which engine the button means                                       */
/* ------------------------------------------------------------------ */

/**
 * The microphone button and the click behind it used to be two copies of one
 * decision, and they had already disagreed: the button was drawn only where
 * `SpeechRecognition` existed, while the click handler had a branch for "no
 * recogniser, but this machine can record". The local path needs no
 * `SpeechRecognition` at all, so a browser that could dictate through the local
 * transcriber was offered nothing.
 *
 * `planDictation` is that decision once, as a function of three booleans, which
 * is what makes it testable here rather than only in a browser.
 */
group("Which engine the mic button means, and whether it exists at all", () => {
  // The setting decides first: a user who chose the local transcriber must not be
  // quietly given the browser's service because the browser has one.
  const localWanted = planDictation({ mode: "local", hasRecognition: true, canRecord: true });
  check("the chosen engine wins over the available one", localWanted.engine === "local", localWanted.engine);

  // The reported configuration's opposite: no Web Speech API at all, but this
  // machine can record — a browser that could dictate locally and was told
  // nothing rather than shown a button.
  const noApi = planDictation({ mode: "browser", hasRecognition: false, canRecord: true });
  check("a browser with no recogniser still gets a button", noApi.button);
  check("which explains the one setting that would make it work", noApi.note.includes("Settings → Voice"), noApi.note);
  check("and claims no engine rather than starting one", noApi.engine === "none", noApi.engine);

  const browser = planDictation({ mode: "browser", hasRecognition: true, canRecord: true });
  check("the browser's own service is used when it is asked for", browser.engine === "browser", browser.engine);
  check("with nothing to explain", browser.note === "", browser.note);

  // Local chosen but unrecordable: the browser engine is still a real fallback,
  // and taking it is better than a button that refuses.
  const fallback = planDictation({ mode: "local", hasRecognition: true, canRecord: false });
  check("an unusable local setting falls back to the browser", fallback.engine === "browser", fallback.engine);

  const nothing = planDictation({ mode: "local", hasRecognition: false, canRecord: false });
  check("nothing to dictate with means no button", !nothing.button);
  check("and no note, because there is nothing to press", nothing.note === "", nothing.note);
  check("and never an engine", nothing.engine === "none", nothing.engine);

  // No input may produce a plan that draws a button with nothing behind it, or an
  // engine with no button to reach it.
  let incoherent = 0;
  for (const mode of ["browser", "local"] as const) {
    for (const hasRecognition of [true, false]) {
      for (const canRecord of [true, false]) {
        const plan = planDictation({ mode, hasRecognition, canRecord });
        if (plan.engine !== "none" && !plan.button) incoherent += 1;
        if (plan.engine === "none" && plan.button && !plan.note) incoherent += 1;
      }
    }
  }
  check("no combination draws a dead button or hides a live engine", incoherent === 0, String(incoherent));
});

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
