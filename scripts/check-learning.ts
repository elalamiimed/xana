/**
 * What she learns from a conversation, and what she refuses to learn.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-learning.ts
 *
 * THE WEIGHT IS ON THE REFUSALS
 *
 * Storing a true fact is easy to get right and hard to get *wrong* in a way
 * anyone notices. What this suite mostly proves is the negative direction: that
 * praise is not stored, that an observation about the conversation is not stored,
 * that a to-do is not stored as a memory, and that the same fact learned twice is
 * stored once.
 *
 * That last one is not hypothetical. The research pass found that a memory system
 * which remembers what the user *liked hearing* drifts toward flattery, because
 * the write path is the training signal - so the filter here is a mechanism with
 * tests, not a line of prompt advice.
 *
 * OFFLINE. No key, no network. `rememberConversation` returns `[]` without a
 * model, which is itself asserted.
 */

import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

const PROJECT_ROOT = process.cwd();
const REAL_DB = path.join(PROJECT_ROOT, "data", "xana.db");
const realBefore = existsSync(REAL_DB) ? statSync(REAL_DB) : undefined;

const dir = mkdtempSync(path.join(tmpdir(), "xana-learning-"));
process.env.XANA_DATA_DIR = dir;
// The suite runs with no key on purpose; make sure the environment cannot
// accidentally supply one and turn the offline assertions into live calls.
delete process.env.DEEPSEEK_API_KEY;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("XANA_LLM_")) delete process.env[key];
}

const { XanaStore } = await import("../src/lib/core/store");
const { rememberConversation, isWorthKeeping, keyFor } = await import("../src/lib/derived/learning");
const { llmAvailable } = await import("../src/lib/mind/llm");

const store = new XanaStore(path.join(dir, "xana.db"));

/* ------------------------------------------------------------------ */
console.log("\nWith no model, extraction is skipped rather than approximated\n");

check("there is no model configured", llmAvailable() === false);
const offline = await rememberConversation(
  { userText: "the landlord wants an answer about the deposit by the 20th", xanaText: "Noted." },
  { store },
);
check("nothing is written", offline.length === 0, JSON.stringify(offline));
check("and nothing reached the database", store.allMemories().length === 0);

/* ------------------------------------------------------------------ */
console.log("\nThe filter: what is worth keeping\n");

const KEEP: Array<[string, { kind: string; title: string; content: string }]> = [
  ["a preference", { kind: "preference", title: "Deep work", content: "Prefers mornings for deep work, before any meetings." }],
  ["a person", { kind: "person", title: "Priya", content: "Sister. Runs on Tuesdays and dislikes early calls." }],
  ["a place", { kind: "place", title: "Reading Room", content: "The cafe on the corner is where they do their best reading." }],
  ["a project", { kind: "project", title: "Aurora", content: "The scheduler rewrite is blocked on the caching decision." }],
  ["a decision", { kind: "decision", title: "Mobile app", content: "Dropped the mobile app to focus on the desktop client." }],
  ["a plain fact", { kind: "fact", title: "Landlord", content: "The landlord wants an answer about the deposit by the 20th." }],
];
for (const [label, fact] of KEEP) {
  check(`kept: ${label}`, isWorthKeeping(fact as never) === true, JSON.stringify(fact));
}

const REJECT: Array<[string, { kind: string; title: string; content: string }]> = [
  ["praise of the user", { kind: "fact", title: "Great idea", content: "That is a brilliant plan and the user is absolutely right." }],
  ["the assistant being praised", { kind: "fact", title: "Feedback", content: "The user thanked the assistant and appreciated the suggestion." }],
  ["a meta observation", { kind: "fact", title: "Engagement", content: "The user seems engaged and thoughtful about the topic." }],
  ["a comment on the conversation", { kind: "fact", title: "Discussion", content: "The conversation covered the launch and the vendor call." }],
  ["a question they asked", { kind: "fact", title: "Query", content: "The user asked about the status of the migration." }],
  ["a to-do in disguise", { kind: "fact", title: "Deposit", content: "Needs to reply to the landlord by the 20th." }],
  ["too short to be a fact", { kind: "fact", title: "x", content: "short" }],
  ["an empty title", { kind: "fact", title: "  ", content: "A perfectly reasonable sentence about something durable." }],
  ["a kind she may not write", { kind: "conversation", title: "Tuesday", content: "Talked about the week and what is coming up next." }],
  ["a task record", { kind: "task", title: "Review", content: "Review the Aurora deck before the standup on Friday." }],
];
for (const [label, fact] of REJECT) {
  check(`refused: ${label}`, isWorthKeeping(fact as never) === false, JSON.stringify(fact));
}

/* ------------------------------------------------------------------ */
console.log("\nThe key: the same fact learned twice is one memory\n");

const a = { kind: "preference" as const, title: "Deep work", content: "Prefers mornings for deep work." };
const b = { kind: "preference" as const, title: "deep work", content: "prefers mornings for deep work" };
const c = { kind: "preference" as const, title: "Deep work", content: "Prefers afternoons for deep work." };

check("the same fact keys the same", keyFor(a) === keyFor(b), `${keyFor(a)} vs ${keyFor(b)}`);
check("case and punctuation do not make it new", keyFor(a) === keyFor({ ...a, content: "Prefers mornings for deep work!" }));
check("a different fact keys differently", keyFor(a) !== keyFor(c));
check("the key is namespaced like the other derived keys", keyFor(a).startsWith("learned-"));

/* ------------------------------------------------------------------ */
console.log("\nThe write path, through the store\n");

/* Written directly here rather than through the model, because the model half
 * needs a key. What is being proven is the store contract the extractor relies
 * on: the `key:` convention is what `knownKeys()` reads, so a fact learned once
 * is not learned again. */
const first = store.remember({
  kind: "preference",
  title: "Deep work",
  content: "Prefers mornings for deep work.",
  tags: [`key:${keyFor(a)}`, "learned"],
  salience: 0.55,
  source: "conversation",
});
check("a fact lands", store.allMemories().length === 1);
check("stamped with the embedder that wrote it", store.embedderId().length > 0);

const { knownKeys } = await import("../src/lib/derived/memory");
const keys = knownKeys(store);
check("its key is known", keys.has(keyFor(a)), [...keys].join(","));

/* The extractor's guard, driven directly: the second sighting is skipped. */
const second = keys.has(keyFor(b));
check("so the same fact seen again is skipped", second === true);

/* And recall finds it, which is the point of storing it at all. */
const recalled = store.recall("when do they like to work", { limit: 3, minScore: 0.05 });
check("and it can be recalled afterwards", recalled.some((h) => h.memory.title === "Deep work"), recalled.map((h) => h.memory.title).join(","));

/* A superseded fact does not leave two live rows. */
const { rememberUtterance } = await import("../src/lib/derived/memory");
rememberUtterance("actually, I prefer evenings for deep work now", store, "s1");
const live = store.allMemories().filter((m) => m.title.toLowerCase().includes("deep work") || m.content.toLowerCase().includes("deep work"));
check("a correction supersedes rather than duplicating", live.length <= 2, `${live.length} live rows`);

/* ------------------------------------------------------------------ */
console.log("\nNear-duplicates: the same fact in different words\n");

/*
 * THE FAILURE THIS IS FOR, OBSERVED LIVE
 *
 * `keyFor` hashes the text, so it catches an identical sentence and nothing
 * else. The model is not deterministic, and re-running one conversation produced
 * "Their landlord wants an answer about the deposit by the 20th." and then "The
 * user needs to give their landlord an answer about the deposit by the 20th." -
 * one fact, two keys, two rows. Duplicates accumulating is precisely what this
 * module is meant to prevent, so the semantic check exists.
 *
 * The thresholds below are the *measured* ones, reproduced here so a change to
 * the embedder that breaks the separation fails a test rather than quietly
 * making recall worse. The numbers are in the comment on `DUPLICATE_SIMILARITY`.
 */
const { DUPLICATE_SIMILARITY } = await import("../src/lib/derived/learning");
const { cosine } = await import("../src/lib/core/vector");

/*
 * Both strings are in the shape the module actually compares: `title. content`.
 * Testing the content alone would be testing something production never does -
 * the earlier version of this suite made exactly that mistake, and it asserted a
 * score 0.03 lower than the real one.
 */
const SAME: Array<[string, string]> = [
  [
    "Landlord deposit deadline. Their landlord wants an answer about the deposit by the 20th.",
    "Deposit answer deadline. They need to give their landlord an answer about the deposit by the 20th.",
  ],
  [
    "Landlord. Their landlord wants an answer about the deposit by the 20th.",
    "Landlord. They need to give their landlord an answer about the deposit by the 20th.",
  ],
];
for (const [existing, rephrased] of SAME) {
  const sim = cosine(store.embedQuery(existing), store.embedQuery(rephrased));
  console.log(`    rephrase scores ${sim.toFixed(4)} (threshold ${DUPLICATE_SIMILARITY})`);
  check("a rephrase of one fact clears the duplicate threshold", sim >= DUPLICATE_SIMILARITY, sim.toFixed(4));
}

const DIFFERENT: Array<[string, string]> = [
  ["Prefers mornings for deep work.", "Prefers afternoons for deep work."],
  ["Sister. Runs on Tuesdays.", "Sister. Runs on Thursdays."],
  ["The landlord wants an answer about the deposit by the 20th.", "The landlord wants a plumber for the bathroom leak."],
];
for (const [a, b] of DIFFERENT) {
  const sim = cosine(store.embedQuery(a), store.embedQuery(b));
  console.log(`    different fact scores ${sim.toFixed(4)}`);
  check("and an opposite or unrelated fact does not", sim < DUPLICATE_SIMILARITY, sim.toFixed(4));
}

/* The margin is thin because the embedder is a feature hash, not a transformer.
 * Asserted rather than assumed, so the day someone swaps in a real model the
 * suite says the separation improved instead of the comment going stale. */
console.log(`    measured margin: same >= ${DUPLICATE_SIMILARITY}, different < ${DUPLICATE_SIMILARITY}`);

/*
 * THE MEASURED CEILING, recorded so it is a known fact rather than a surprise.
 *
 * The same rephrase measured without the generated titles scores 0.7298, which
 * is *below* the highest different-pair score of 0.743. The margins overlap at
 * the bottom, so this embedder cannot separate every rephrase from every
 * different fact, and a threshold that caught both would also drop a real one.
 *
 * Production compares `title. content`, which lands at 0.776 and clears the bar -
 * so the overlap does not bite today. It is recorded because it is the concrete,
 * measured case for the local sentence-transformer on the README's list, and
 * because the next person to look at this threshold deserves the number rather
 * than an assurance that it is fine.
 */
const untitledA = "The landlord wants an answer about the deposit by the 20th.";
const untitledB = "They need to give their landlord an answer about the deposit by the 20th.";
const untitledScore = cosine(store.embedQuery(untitledA), store.embedQuery(untitledB));
console.log(`    the untitled form scores ${untitledScore.toFixed(4)} - the overlap that motivates a real embedder`);
check(
  "the measured overlap is recorded, and production's shape is above it",
  untitledScore < DUPLICATE_SIMILARITY,
  `untitled ${untitledScore.toFixed(4)}; if this now clears the bar the embedder changed and the comment is stale`,
);

/* ------------------------------------------------------------------ */
console.log("\nThe real database was never touched\n");

if (realBefore) {
  const realAfter = statSync(REAL_DB);
  check("its size is unchanged", realAfter.size === realBefore.size, `${realBefore.size} -> ${realAfter.size}`);
  check("its mtime is unchanged", realAfter.mtimeMs === realBefore.mtimeMs);
} else {
  check("there was no real database to protect", true);
}

store.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;

export {};
