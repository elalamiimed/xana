/**
 * The model's reading of the measured facts — and the guards around it.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-analysis.ts
 *
 * Two things are being checked, and only one of them is about prose.
 *
 *  1. **The no-model path.** With no key configured, `analyseLifeState`
 *     returns nothing and the briefing shows the detector's own evidence
 *     under a label saying where it came from. That is the whole reason the
 *     local engine can be trusted: it never claims an insight it did not
 *     measure.
 *
 *  2. **Provenance.** A model asked to pick from a list of memories
 *     occasionally returns one that was not on the list. In the chat window
 *     that is indistinguishable from a real memory, which makes it the most
 *     dangerous thing this feature can produce. So a returned memory is
 *     matched back to one that was actually supplied, by title, and dropped
 *     if it does not match.
 *
 * The tests below drive `parseAnalysis` directly with the strings a model
 * actually returns — including the fenced and chatty shapes — because that
 * function is the guard, and a guard tested through a live API is a guard
 * tested by luck.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setStore, XanaStore } from "../src/lib/core/store";
import { buildLifeState, invalidateContext } from "../src/lib/context/gateway";
import { localBriefingSections } from "../src/lib/mind/local";
import { parseAnalysis } from "../src/lib/mind/analysis";
import type { LifeState } from "../src/lib/core/types";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const dir = mkdtempSync(path.join(tmpdir(), "xana-analysis-"));
const store = new XanaStore(path.join(dir, "analysis.db"));
setStore(store);

/* ---- a state with one real memory and one real pattern --------------- */

store.remember({
  kind: "fact",
  title: "Spare key",
  content: "The spare key is under the blue pot.",
  source: "user",
  salience: 0.8,
});
store.remember({
  kind: "decision",
  title: "Launch date",
  content: "The launch post is due the first week of March.",
  source: "user",
  salience: 0.7,
});

const state: LifeState = await buildLifeState({ force: true });

// A fresh database has no history, so the detector finds nothing. Give the
// state a finding it could plausibly have produced, because what is under test
// here is the display path — "does the detector's evidence reach the card when
// there is no model reading" — not the detector's own thresholds, which
// verify:briefing covers.
state.patterns = [
  {
    id: "pat_test",
    key: "habit-at-risk-h1",
    observation: "Your meditation streak is 26 days and needs 5 more this week to hold.",
    confidence: 0.62,
    evidence: ["2 of 7 this week", "26-day streak, longest 26"],
    suggestion: "Log it today?",
    detectedAt: new Date().toISOString(),
  },
];

console.log("\nProvenance: what a model is allowed to return\n");

const real = parseAnalysis(
  JSON.stringify({
    pattern: { analysis: "Your streaks and your sleep are pulling apart.", evidence: ["26-day streak"] },
    recall: [{ title: "Spare key", because: "you have not mentioned it in months" }],
  }),
  state,
);
check("a real memory survives", real?.recall?.[0]?.title === "Spare key", JSON.stringify(real?.recall));

const invented = parseAnalysis(
  JSON.stringify({
    recall: [{ title: "Your sister's birthday", because: "it is next week" }],
  }),
  state,
);
check(
  "an invented memory is dropped",
  invented?.recall === undefined,
  JSON.stringify(invented?.recall),
);

const paraphrased = parseAnalysis(
  JSON.stringify({ recall: [{ title: "spare key location", because: "relevant" }] }),
  state,
);
check(
  "a paraphrased title is dropped rather than matched loosely",
  paraphrased?.recall === undefined,
  JSON.stringify(paraphrased?.recall),
);

const mixed = parseAnalysis(
  JSON.stringify({
    recall: [
      { title: "Nonexistent thing", because: "made up" },
      { title: "Launch date", because: "the date is close" },
    ],
  }),
  state,
);
check(
  "one real memory among invented ones still survives",
  mixed?.recall?.length === 1 && mixed.recall[0].title === "Launch date",
  JSON.stringify(mixed?.recall),
);

console.log("\nShape: how the answer arrives\n");

check(
  "a code-fenced answer is read",
  parseAnalysis('```json\n{"pattern":{"analysis":"x"}}\n```', state)?.pattern?.analysis === "x",
);
check(
  "an answer with a sentence in front is read",
  parseAnalysis('Sure, here it is:\n{"pattern":{"analysis":"y"}}', state)?.pattern?.analysis === "y",
);
check("prose with no object is ignored", parseAnalysis("I could not find anything.", state) === undefined);
check("malformed JSON is ignored", parseAnalysis('{"pattern":', state) === undefined);
check("an empty object yields nothing to show", parseAnalysis("{}", state)?.pattern === undefined);

console.log("\nThe confidence number is never the model's\n");

const borrowed = parseAnalysis(
  JSON.stringify({ pattern: { analysis: "x", confidence: 0.99 } }),
  state,
);
check(
  "confidence comes from the detector, not the reply",
  borrowed?.pattern?.confidence === state.patterns[0]?.confidence,
  `model said 0.99, card says ${borrowed?.pattern?.confidence}`,
);

console.log("\nThe briefing without a model\n");

const noModel = localBriefingSections(state, new Date());
const pattern = noModel.find((s) => s.kind === "pattern");
check(
  "the detector's finding is shown when there is no reading",
  Boolean(pattern && pattern.kind === "pattern" && pattern.detectedBy === "detector"),
  JSON.stringify(pattern),
);
check(
  "and no recall section is claimed",
  !noModel.some((s) => s.kind === "recall"),
);
check(
  "nothing in the briefing asserts an analysis",
  !noModel.some((s) => s.kind === "pattern" && s.analysis !== undefined),
);

console.log("\nThe briefing with one\n");

const withReading = localBriefingSections(state, new Date(), {
  pattern: {
    analysis: "Two of your streaks break in the same week your sleep drops.",
    evidence: ["26-day streak", "6.4h average"],
    confidence: state.patterns[0]?.confidence,
    suggestion: "Protect Thursday.",
  },
  recall: [{ id: "m1", title: "Spare key", content: "Under the blue pot.", because: "unmentioned for months" }],
  considered: { patterns: 1, memories: 2 },
  at: new Date().toISOString(),
});

const readPattern = withReading.find((s) => s.kind === "pattern");
const readRecall = withReading.find((s) => s.kind === "recall");
check(
  "the analysis is shown and attributed to the model",
  Boolean(readPattern && readPattern.kind === "pattern" && readPattern.detectedBy === "model"),
);
check(
  "its evidence travels with it",
  Boolean(readPattern && readPattern.kind === "pattern" && readPattern.evidence.length === 2),
);
check(
  "recall is shown with its reason",
  Boolean(readRecall && readRecall.kind === "recall" && readRecall.items[0].because.length > 0),
);

store.close();
rmSync(dir, { recursive: true, force: true });
invalidateContext();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
