/**
 * Hybrid memory recall: lexical and semantic channels, fused by rank.
 *
 * WHY TWO CHANNELS
 *
 * The old recall was one channel wearing four hats: a hashing-embedder cosine, a
 * Jaccard overlap, a salience and a recency decay, added together with weights
 * that implied somebody had measured how much each should matter. Nobody had,
 * and nobody could: a weight is only meaningful against a known scale, and those
 * four are on four different scales.
 *
 * BEIR's much-replicated finding is the argument for keeping both: BM25 is a
 * strong zero-shot baseline that dense models often fail to beat *out of domain*,
 * and a single person's memory of their own life is the out-of-domain case by
 * definition - there is no training corpus of one person's Tuesday. So the
 * lexical channel is not a fallback for the dense one; it is the channel that
 * wins on the queries with a rare exact word in them ("the Allotment Society"),
 * while the dense channel wins on the ones that share no words with the target
 * ("when am I seeing Sarah" against a memory titled "lunch with my sister").
 *
 * WHY RANK FUSION AND NOT A WEIGHTED SUM
 *
 * `reciprocalRankFusion` consumes ranks, which have exactly one scale. That
 * means the two channels can disagree about scoring entirely and still combine
 * correctly, and it means the weights in `core/fusion.ts` are honest: they
 * describe how much to trust a *ranking*, which is a claim the data can support,
 * rather than a *score*, which it cannot.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not re-rank with a model. Anthropic's measured stack is 5.7% -> 3.7%
 * with contextual embeddings -> 2.9% with contextual BM25 -> 1.9% with a rerank
 * step, so a reranker is worth about a third of the total gain - but it needs a
 * model call per query, and the failure it fixes (a near-miss in the top three)
 * is not the one that makes recall feel broken. Recorded here so the next person
 * knows it was considered rather than missed.
 */

import type { MemoryHit, MemoryRecord } from "../core/types";
import { getStore, type XanaStore } from "../core/store";
import { cosine } from "../core/vector";
import { reciprocalRankFusion, rankedFromScores } from "../core/fusion";

export interface HybridHit {
  memory: MemoryRecord;
  /** Fused score. Comparable only to other fused scores from the same call. */
  score: number;
  /** Which channel found it. `both` is the strongest signal available here. */
  because: "lexical" | "semantic" | "both";
}

/** How deep each channel is read before fusing. */
const CHANNEL_DEPTH = 20;

/**
 * Recall, lexically and semantically, fused.
 *
 * Recency is applied *after* fusion and as a tie-breaker rather than as a term
 * inside either channel, which is the correction to a real defect: the old
 * scorer decayed from `created_at` with a flat 45-day half-life for every kind
 * of memory, so a preference stored eight months ago scored about 0.002 on
 * recency - statistically identical to noise - and the user's own stated
 * preferences lost to whatever they mentioned yesterday.
 *
 * Here, recency scales the fused score by a factor in [0.7, 1.0]. It can
 * reorder two memories the channels rated similarly and it can never promote a
 * memory neither channel found, which is the property that keeps an irrelevant
 * but recent memory from climbing over a relevant old one.
 */
export function searchMemoriesHybrid(
  query: string,
  limit = 5,
  store: XanaStore = getStore(),
): HybridHit[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  /* --- Channel 1: lexical, through FTS5/BM25. --- */
  const lexical = store.recallLexical(trimmed, CHANNEL_DEPTH);

  /* --- Channel 2: dense, over the live memories. --- */
  const queryVector = store.embedQuery(trimmed);
  const all = store.allMemories();
  const semantic = all
    .map((memory) => ({ item: memory, score: cosine(queryVector, store.vectorOf(memory.id) ?? []) }))
    // A floor rather than a top-N: with a hashing embedder, unrelated memories
    // still score a little, and padding the channel with them would let noise
    // into the fusion where it would outrank a genuinely good lexical hit.
    .filter((s) => s.score > 0.05);

  const lists = [
    rankedFromScores("lexical", lexical.map((l) => ({ item: l.memory, score: -l.bm25 })), (m) => m.id, CHANNEL_DEPTH),
    rankedFromScores("semantic", semantic, (m) => m.id, CHANNEL_DEPTH),
  ];

  const fused = reciprocalRankFusion(lists, { k: 60 });
  const now = Date.now();

  return fused
    .map((entry) => ({
      memory: entry.item,
      score: entry.score * recencyFactor(entry.item, now),
      because:
        entry.sources.length > 1 ? ("both" as const) : entry.sources[0] === "lexical" ? ("lexical" as const) : ("semantic" as const),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * How fast a kind of memory goes stale, in days to the midpoint.
 *
 * WHY PER KIND, AND WHY THIS REPLACED ONE NUMBER
 *
 * The scorer this replaces decayed every memory with the same flat 45-day
 * half-life, measured from `created_at`. Both halves of that were wrong, and the
 * second one was worse than the first.
 *
 * *From creation* is wrong because it confuses "written down long ago" with "no
 * longer true". A preference the user stated in January and confirmed last week
 * is current knowledge; a note from yesterday that nobody has touched is not
 * more current than that. So the clock runs from `lastAccessedAt`, falling back
 * to `createdAt` for a memory that has never been recalled.
 *
 * *One half-life* is wrong because these are not the same kind of fact. A
 * `preference` is durable by definition - that is what makes it a preference -
 * and the user's own stated dislikes losing to a passing mention from yesterday
 * is exactly the failure the report named. An `event` is the opposite: what
 * happened last Tuesday stops being interesting within a week. Applying one
 * constant to both means one of them is always mis-weighted, and the old 45 days
 * mis-weighted all of them: at eight months a preference scored about 0.002 on
 * recency, which is indistinguishable from noise.
 *
 * The numbers below are [OPINION] - reasoned, not measured - and they are
 * deliberately coarse. A finer set would imply a precision nobody has evidence
 * for. What matters is the *ordering*: durable kinds keep their footing for
 * years, dated kinds fade within weeks, and everything sits on a floor that
 * cannot reach zero. See `docs/WHY-THIS-WAY.md` section 0 for why an untagged
 * number is not allowed to decide anything.
 */
const HALF_LIFE_DAYS: Record<string, number> = {
  // Durable: a fact about a person does not expire.
  preference: 365,
  person: 365,
  place: 365,
  fact: 180,
  // Slow: a project or a decision stays relevant for a season.
  project: 120,
  decision: 120,
  reflection: 90,
  // Dated: what happened, and what was said about it.
  event: 21,
  conversation: 14,
  note: 60,
  task: 30,
};

/** The half-life for a kind, and the fallback for a kind nobody has classified. */
function halfLifeFor(kind: string): number {
  return HALF_LIFE_DAYS[kind] ?? 90;
}

/**
 * A multiplier in [0.7, 1.0], from how long ago the memory was last *used*
 * relative to how long that kind of memory stays fresh.
 *
 * The floor is the important part: an old memory is still a memory, and a factor
 * that could reach zero would silently delete the user's history from recall one
 * day at a time. Recall is ranked by relevance first and nudged by recency;
 * recency never gets to overrule relevance outright.
 */
function recencyFactor(memory: MemoryRecord, now: number): number {
  const stamp = memory.lastAccessedAt ?? memory.createdAt;
  const then = new Date(stamp).getTime();
  if (!Number.isFinite(then)) return 1;
  const days = Math.max(0, (now - then) / 86_400_000);
  // Exponential decay to a half at the kind's half-life, scaled into [0.7, 1.0].
  const freshness = Math.pow(0.5, days / halfLifeFor(memory.kind));
  return 0.7 + 0.3 * freshness;
}

/**
 * The hybrid result, in the shape the rest of the app already speaks.
 *
 * `MemoryHit.score` is carried through as the fused score, and pinned memories
 * are added independently of it - the guarantee a pin is for. A pinned fact is
 * one the user marked as always-true, so it must not be outranked by a strongly
 * matching fragment of yesterday's conversation; that was a real complaint about
 * the previous scorer, where a pin was worth about 0.12 of salience.
 */
export function recallHybrid(query: string, opts: { limit?: number; store?: XanaStore } = {}): MemoryHit[] {
  const store = opts.store ?? getStore();
  const limit = opts.limit ?? 5;
  const hits = searchMemoriesHybrid(query, limit, store);

  const out: MemoryHit[] = hits.map((h) => ({
    memory: h.memory,
    score: h.score,
    reason:
      h.because === "both"
        ? "matched your words and the sense of it"
        : h.because === "lexical"
          ? "matched your words"
          : "recalled by meaning",
  }));

  const present = new Set(out.map((h) => h.memory.id));
  for (const memory of store.allMemories()) {
    if (!memory.pinned || present.has(memory.id)) continue;
    out.push({ memory, score: 1, reason: "pinned" });
  }
  return out;
}
