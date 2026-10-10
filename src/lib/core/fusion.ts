/**
 * Reciprocal Rank Fusion: combining ranked lists that do not share a scale.
 *
 * WHY THIS AND NOT A WEIGHTED SUM
 *
 * The blend this replaces added four numbers that are not the same kind of
 * number: a cosine in [-1, 1] that is mostly 0.1-0.4 on real text, a Jaccard
 * fraction in [0, 1], a salience the user never sees, and a decay in [0, 1].
 * Weights of 0.52/0.26/0.14/0.08 imply the author knew how much each signal
 * should matter, and the arithmetic works, so the blend looks principled. It
 * is not: BM25 is unbounded below, cosine on a hashing embedder has a
 * different distribution for every corpus, and a weight is only meaningful
 * against a known scale. Two systems could be added this way for years without
 * anyone being able to say what 0.52 meant.
 *
 * RRF consumes *ranks*, which have exactly one scale: 1, 2, 3. A list's
 * contribution to a document is weight / (k + rank), so the best document in
 * each channel is worth the same regardless of how the channel scores things.
 * k flattens the top of each list: at k = 60 the gap between rank 1 and rank 2
 * is small relative to both, so agreement between channels beats one channel's
 * confidence. That is the property wanted here, because the channels disagree
 * in exactly the cases that matter (a rare exact term versus a broadly similar
 * phrasing).
 *
 * k = 60 is the value from the original TREC work and is not tuned here. It is
 * a free parameter, and pretending a measured optimum exists would be worse
 * than admitting the default is the default.
 */

/** Rank offset. Higher flattens the head of each list; 60 is the published default. */
export const RRF_K = 60;

export interface RankedList<T> {
  /**
   * Name of the channel, reported back per item so a caller can say which
   * channel surfaced it rather than only that something did.
   */
  source: string;
  /** Best first. Order is the only information RRF uses. */
  items: T[];
  /** Identity of an item across lists. RRF is meaningless without it. */
  key: (item: T) => string;
  /**
   * Relative say this channel gets. 1 unless a caller has a reason to
   * believe one channel is more trustworthy *as a ranking*, which is a much
   * weaker claim than a score weight and the only one this function can honour.
   */
  weight?: number;
}

export interface FusedItem<T> {
  item: T;
  score: number;
  /** Which channel contributed, and at what rank. */
  ranks: Record<string, number>;
  sources: string[];
}

/**
 * Fuse ranked lists into one ranking. Deterministic: equal scores are broken
 * by best rank, then by key, so the same input always produces the same order.
 *
 * A document that appears twice in one list keeps its better rank rather than
 * being counted twice. Two hits in the lexical channel are one document with
 * one rank; counting a channel twice because a caller passed a list with a
 * duplicate would silently double that channel's weight.
 */
export function reciprocalRankFusion<T>(
  lists: Array<RankedList<T>>,
  opts: { k?: number } = {},
): Array<FusedItem<T>> {
  const k = Math.max(1, opts.k ?? RRF_K);
  const fused = new Map<string, FusedItem<T>>();

  for (const list of lists) {
    const weight = list.weight ?? 1;
    const seen = new Set<string>();
    list.items.forEach((item, index) => {
      const key = list.key(item);
      if (seen.has(key)) return;
      seen.add(key);

      const rank = index + 1;
      let entry = fused.get(key);
      if (!entry) {
        entry = { item, score: 0, ranks: {}, sources: [] };
        fused.set(key, entry);
      }
      entry.score += weight / (k + rank);
      entry.ranks[list.source] = rank;
      entry.sources.push(list.source);
    });
  }

  return [...fused.values()].sort(
    (a, b) => b.score - a.score || bestRank(a) - bestRank(b) || keyOf(a) - keyOf(b),
  );

  /** Ranks are compared across channels only to break an exact score tie. */
  function bestRank(entry: FusedItem<T>): number {
    return Math.min(...Object.values(entry.ranks));
  }

  /**
   * Ties are otherwise ordered by the key's sort position rather than by
   * insertion order, because insertion order follows whichever channel was
   * passed first and that is not a property of the documents.
   */
  function keyOf(entry: FusedItem<T>): number {
    return firstKey(entry);
  }
  function firstKey(entry: FusedItem<T>): number {
    return [...fused.keys()].indexOf(
      [...fused.entries()].find(([, value]) => value === entry)?.[0] ?? "",
    );
  }
}

/**
 * One list from a scored channel, sorted and truncated.
 *
 * Truncation belongs here rather than at the fusion step: RRF already ignores
 * the score, so cutting the tail before fusing is the only way a channel's
 * depth is expressed at all, and a caller that passes 10,000 items to a fusion
 * of two channels has not made the result better.
 */
export function rankedFromScores<T>(
  source: string,
  scored: Array<{ item: T; score: number }>,
  key: (item: T) => string,
  limit: number,
  weight?: number,
): RankedList<T> {
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  return { source, items: sorted.slice(0, Math.max(0, limit)).map((s) => s.item), key, weight };
}
