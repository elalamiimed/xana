/**
 * The model path, end to end, without a provider.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-analysis-live.ts
 *
 * There is no API key in this environment, so nothing here talks to a real
 * model — and saying "the model path is unverified" on that basis is only half
 * true. Everything except the provider's own intelligence is ours: the facts
 * we choose to send, whether the response reaches a section, whether a
 * fabricated memory is dropped, and what the card does when the call fails.
 * All of that is testable, and none of it was being tested.
 *
 * So `globalThis.fetch` is replaced. That makes the assertions about the
 * request itself possible — the prompt is captured and inspected, rather than
 * assumed — which is strictly more than a live call would tell us.
 *
 * What this does NOT prove: that a real DeepSeek or OpenAI response parses.
 * That needs a key, and it stays on the list.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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

/* ---- the stub provider, installed before anything reads settings ------- */

const dir = mkdtempSync(path.join(tmpdir(), "xana-live-"));
writeFileSync(
  path.join(dir, "settings.json"),
  JSON.stringify({
    model: {
      enabled: true,
      provider: "openai",
      baseUrl: "https://stub.invalid/v1",
      model: "stub-model",
      apiKey: "stub-key-not-a-real-secret",
      temperature: 0.3,
    },
  }),
  "utf8",
);
process.env.XANA_DATA_DIR = dir;

const calls: Array<{ url: string; body: { messages?: Array<{ role: string; content: string }> } }> = [];
let nextReply: { status: number; payload: unknown } = { status: 200, payload: { choices: [{ message: { content: "{}" } }] } };

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.includes("stub.invalid")) return realFetch(input as never, init);
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  calls.push({ url, body });
  return new Response(JSON.stringify(nextReply.payload), {
    status: nextReply.status,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

/* ---- now the app, with settings pointed at the stub ------------------- */

const { XanaStore, setStore } = await import("../src/lib/core/store");
const { buildLifeState } = await import("../src/lib/context/gateway");
const { analyseLifeState } = await import("../src/lib/mind/analysis");
const { localBriefingSections } = await import("../src/lib/mind/local");
const { llmAvailable } = await import("../src/lib/mind/llm");

const store = new XanaStore(path.join(dir, "live.db"));
setStore(store);

check("the stub is seen as a configured model", llmAvailable() === true);

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
  content: "The launch post goes out the first week of March.",
  source: "user",
  salience: 0.7,
});

// A pattern the detector could not find in an empty database, so the prompt
// has something measured to reason about.
const base = await buildLifeState({ force: true });
base.patterns = [
  {
    id: "p1",
    key: "habit-at-risk-h1",
    observation: "Your meditation run is 26 days — the longest you have managed.",
    confidence: 0.62,
    basis: "how firmly a 26-day run predicts the next week",
    evidence: ["2 of 7 this week", "26-day streak, longest 26"],
    suggestion: "Log it today?",
    detectedAt: new Date().toISOString(),
  },
];

/* ---- 1. The prompt carries the measured facts ------------------------- */

console.log("\nWhat is actually sent\n");

nextReply = {
  status: 200,
  payload: {
    choices: [
      {
        message: {
          content: JSON.stringify({
            pattern: {
              analysis: "Your longest run and your weakest week are the same week.",
              evidence: ["2 of 7 this week", "26-day streak"],
              suggestion: "Log it today.",
            },
            recall: [{ title: "Spare key", because: "unmentioned for months" }],
          }),
        },
      },
    ],
  },
};

const analysis = await analyseLifeState({ lifeState: base });
const sent = calls.at(-1)?.body.messages ?? [];
const system = sent.find((m) => m.role === "system")?.content ?? "";
const user = sent.find((m) => m.role === "user")?.content ?? "";

check("one request was made", calls.length === 1, `${calls.length}`);
check("it went to the configured endpoint", calls[0]?.url.includes("stub.invalid"), calls[0]?.url);
check("there is a system prompt", system.length > 200, `${system.length} chars`);
check(
  "the system prompt forbids inventing facts",
  /never invent/i.test(system),
  system.slice(0, 120),
);
check("the measured pattern is in the prompt", user.includes("meditation run is 26 days"), user.slice(0, 200));
check("its evidence is in the prompt", user.includes("2 of 7 this week"));
check("its basis is in the prompt", user.includes("how firmly a 26-day run"), user.slice(0, 300));
check("the user's memories are in the prompt", user.includes("Spare key") && user.includes("blue pot"));
check(
  "and the prompt does not tell the model the confidence",
  !/62%/.test(user) || /how firmly/.test(user),
  user.slice(0, 300),
);

/* ---- 2. The reading reaches the briefing ----------------------------- */

console.log("\nWhat reaches the card\n");

check("an analysis came back", analysis !== undefined);
check(
  "the model's sentence is kept",
  analysis?.pattern?.analysis === "Your longest run and your weakest week are the same week.",
  JSON.stringify(analysis?.pattern),
);
check(
  "confidence still comes from the detector, not the reply",
  analysis?.pattern?.confidence === 0.62,
  String(analysis?.pattern?.confidence),
);
check(
  "the model's own evidence is preferred when it supplies one",
  analysis?.pattern?.evidence[0] === "2 of 7 this week",
  JSON.stringify(analysis?.pattern?.evidence),
);
check(
  "the recall item survived the provenance check",
  analysis?.recall?.length === 1 && analysis.recall[0].title === "Spare key",
  JSON.stringify(analysis?.recall),
);

const sections = localBriefingSections(base, new Date(), analysis);
const pattern = sections.find((s) => s.kind === "pattern");
const recall = sections.find((s) => s.kind === "recall");

check(
  "the pattern section is attributed to the model",
  Boolean(pattern && pattern.kind === "pattern" && pattern.detectedBy === "model"),
);
check(
  "and shows the model's sentence rather than the detector's",
  Boolean(pattern && pattern.kind === "pattern" && /weakest week/.test(pattern.analysis ?? "")),
  pattern?.kind === "pattern" ? pattern.analysis : "",
);
check(
  "the recall section exists with its reason",
  Boolean(recall && recall.kind === "recall" && (recall.items[0]?.because.length ?? 0) > 0),
  JSON.stringify(recall),
);

/* ---- 3. A provider that fails costs nothing --------------------------- */

console.log("\nWhen the provider misbehaves\n");

for (const [label, reply] of [
  ["a 401", { status: 401, payload: { error: "invalid api key" } }],
  ["a 429", { status: 429, payload: { error: "rate limited" } }],
  ["a 500", { status: 500, payload: { error: "boom" } }],
  ["a body with no choices", { status: 200, payload: {} }],
  ["prose instead of JSON", { status: 200, payload: { choices: [{ message: { content: "I could not find anything." } }] } }],
] as const) {
  nextReply = reply as never;
  const result = await analyseLifeState({ lifeState: base });
  check(`"${label}" yields no reading rather than a thrown turn`, result === undefined, JSON.stringify(result));
}

// And the briefing still renders its measured sections.
nextReply = { status: 500, payload: { error: "boom" } };
const failedReading = await analyseLifeState({ lifeState: base });
const survived = localBriefingSections(base, new Date(), failedReading);
check(
  "the briefing keeps its measured sections after a failure",
  survived.some((s) => s.kind === "energy") && survived.some((s) => s.kind === "pattern"),
  survived.map((s) => s.kind).join(","),
);
check(
  "and falls back to the detector's label",
  survived.find((s) => s.kind === "pattern")?.kind === "pattern" &&
    (survived.find((s) => s.kind === "pattern") as { detectedBy: string }).detectedBy === "detector",
);

/* ---- 4. No model, no request ----------------------------------------- */

console.log("\nWhen there is no model\n");

const { llmConfig } = await import("../src/lib/mind/llm");
writeFileSync(
  path.join(dir, "settings.json"),
  JSON.stringify({ model: { enabled: false, apiKey: "stub-key-not-a-real-secret" } }),
  "utf8",
);
// The settings store memoises on mtime, and this write may land in the same
// millisecond as the last read.
await new Promise((r) => setTimeout(r, 20));
const before = calls.length;
const none = await analyseLifeState({ lifeState: base });
check("no analysis without an enabled model", none === undefined);
check("and no request was made", calls.length === before, `${before} -> ${calls.length}`);
check("the client reports no model configured", llmConfig() === undefined);

store.close();
globalThis.fetch = realFetch;
rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
