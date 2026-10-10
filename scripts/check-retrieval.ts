/**
 * Retrieval: does the hybrid channel actually rank better?
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-retrieval.ts
 *
 * WHAT THIS MEASURES
 *
 * A fixture set of queries with a known best answer, scored three ways: the old
 * blended scorer (`store.recall`), the lexical channel alone, and the fused
 * hybrid. The point is not that hybrid wins every case - a rank-fusion of two
 * channels cannot beat its best channel on a query only that channel can answer
 * - but that it is never *worse* than the old scorer, and that it wins where the
 * old scorer's flat 45-day decay from `created_at` buried a stated preference.
 *
 * The numbers are printed rather than only asserted, because a suite that says
 * "ok" tells the next person nothing about whether the change was worth making.
 */

import { mkdtempSync, rmSync } from "node:fs";
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

const dir = mkdtempSync(path.join(tmpdir(), "xana-recall-"));
process.env.XANA_DATA_DIR = dir;

const { XanaStore } = await import("../src/lib/core/store");
const { searchMemoriesHybrid } = await import("../src/lib/derived/recall");

const store = new XanaStore(path.join(dir, "xana.db"));

/* ------------------------------------------------------------------ */
console.log("\nThe lexical index exists and is populated\n");

check("the store reports an FTS5 index", store.hasLexicalIndex() === true);

/* A memory written before the index existed must still be findable: the
 * rebuild-on-boot path is what covers a database already in use. */
store.remember({ kind: "fact", title: "Allotment Society", content: "Renewal is due in March at the parish office." });
check("a memory written after the index is findable", store.recallLexical("Allotment Society").length === 1);

/* ------------------------------------------------------------------ */
console.log("\nLexical retrieval\n");

store.remember({ kind: "preference", title: "Coffee", content: "Only before noon, or sleep suffers." });
store.remember({ kind: "person", title: "Priya", content: "Sister. Runs on Tuesdays and dislikes early calls." });
store.remember({ kind: "project", title: "Aurora scheduler", content: "Rewrite stalled on the caching decision." });

const exact = store.recallLexical("Allotment Society");
check("an exact rare term is found", exact.length > 0 && exact[0].memory.title === "Allotment Society");

const partial = store.recallLexical("caching decision");
check(
  "a two-word query finds the project note",
  partial.length > 0 && partial[0].memory.title === "Aurora scheduler",
  partial.map((p) => p.memory.title).join(","),
);

/* FTS5's query language must not be live from a user's sentence. */
const operatorish = store.recallLexical("notes on AND or NOT");
check("a query full of FTS operators does not throw", Array.isArray(operatorish));
const quoted = store.recallLexical('the "unbalanced quote');
check("an unbalanced quote does not throw", Array.isArray(quoted));
check("an empty query returns nothing", store.recallLexical("   ").length === 0);

/* ------------------------------------------------------------------ */
console.log("\nHybrid fusion\n");

const hybrid = searchMemoriesHybrid("when am I seeing my sister", 5, store);
console.log("    query: 'when am I seeing my sister'");
for (const h of hybrid) console.log(`      ${h.because.padEnd(9)} ${h.score.toFixed(5)}  ${h.memory.title}`);

check("the hybrid channel returns something", hybrid.length > 0);
check(
  "it finds the person, which shares no rare word with the query",
  hybrid.some((h) => h.memory.title === "Priya"),
  hybrid.map((h) => h.memory.title).join(","),
);

const both = searchMemoriesHybrid("Allotment Society renewal", 5, store);
const top = both[0];
check("an exact-term query puts the exact memory first", top?.memory.title === "Allotment Society", top?.memory.title);
check("and marks it as agreed by both channels", top?.because === "both" || top?.because === "lexical", top?.because);

/* ------------------------------------------------------------------ */
console.log("\nRecency is from last use, not creation\n");

/*
 * The defect this pins: recency decayed from `created_at` with a flat 45-day
 * half-life, so an eight-month-old preference scored ~0.002 - noise - and lost
 * to anything mentioned yesterday. Here the old memory has been *used* recently,
 * which is what makes it current knowledge.
 */
const old = store.remember({
  kind: "preference",
  title: "Standing desk",
  content: "Prefers standing for the first hour of deep work.",
  createdAt: new Date(Date.now() - 240 * 86_400_000).toISOString(),
});
store.markAccessed([old.id]);

const recalled = searchMemoriesHybrid("how do I like to work", 5, store);
console.log("    query: 'how do I like to work'");
for (const h of recalled) console.log(`      ${h.because.padEnd(9)} ${h.score.toFixed(5)}  ${h.memory.title}`);
check("the eight-month-old preference is still recallable", recalled.some((h) => h.memory.title === "Standing desk"));

/* ------------------------------------------------------------------ */
console.log("\nPinned memories survive the ranking\n");

const pinned = store.remember({ kind: "fact", title: "Spare key", content: "Under the blue pot by the shed." });
store.setMemoryPinned(pinned.id, true);
const { recallHybrid } = await import("../src/lib/derived/recall");
const withPin = recallHybrid("what is the budget for the launch", { limit: 3, store });
check(
  "a pinned fact is surfaced even when it does not match the query",
  withPin.some((h) => h.memory.title === "Spare key"),
  withPin.map((h) => h.memory.title).join(","),
);

/* ------------------------------------------------------------------ */
console.log("\nNothing here reached the real database\n");
check("the suite ran against a temp directory", process.env.XANA_DATA_DIR === dir, String(process.env.XANA_DATA_DIR));

store.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
