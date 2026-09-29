/**
 * Local, dependency-free embedding.
 *
 * Xana's memory must work with zero API keys, so the default embedder is a
 * deterministic feature-hashing model: token unigrams + bigrams + character
 * trigrams folded into a fixed-width vector, L2-normalised.
 *
 * It is not a transformer, but for a single user's memory it is genuinely
 * useful: lexical similarity is captured exactly, near-misses are caught by
 * the char-ngram channel, and cosine search over a few thousand entries is
 * instant. `MemoryStore` accepts any `Embedder`, so dropping in an API-backed
 * model later is a one-line swap.
 */

export interface Embedder {
  readonly id: string;
  readonly dim: number;
  embed(text: string): number[];
}

export const EMBED_DIM = 384;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "that", "this",
  "these", "those", "is", "am", "are", "was", "were", "be", "been", "being",
  "to", "of", "in", "on", "at", "by", "for", "with", "about", "as", "into",
  "it", "its", "i", "me", "my", "we", "our", "you", "your", "he", "she",
  "they", "them", "his", "her", "do", "does", "did", "have", "has", "had",
  "will", "would", "can", "could", "should", "just", "so", "up", "out",
]);

/** 32-bit FNV-1a. Stable across runs and platforms. */
export function hash32(input: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9+#.-]+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function bump(vec: Float64Array, key: string, weight: number): void {
  // Two independent hashes per feature reduces collision noise.
  const h1 = hash32(key, 0x811c9dc5);
  const h2 = hash32(key, 0x1000193);
  const i1 = h1 % EMBED_DIM;
  const i2 = h2 % EMBED_DIM;
  // Signed hashing keeps the expected dot product of unrelated features at 0.
  const sign = (h1 & 0x80000000) === 0 ? 1 : -1;
  vec[i1] += sign * weight;
  vec[i2] += sign * weight * 0.6;
}

export function embedText(text: string): number[] {
  const vec = new Float64Array(EMBED_DIM);
  const tokens = tokenize(text);

  for (const t of tokens) bump(vec, `w:${t}`, 1);

  for (let i = 0; i < tokens.length - 1; i++) {
    bump(vec, `b:${tokens[i]}_${tokens[i + 1]}`, 0.7);
  }

  // Character trigrams inside longer words catch morphology and typos.
  for (const t of tokens) {
    if (t.length < 5) continue;
    const padded = `^${t}$`;
    for (let i = 0; i < padded.length - 2; i++) {
      bump(vec, `c:${padded.slice(i, i + 3)}`, 0.28);
    }
  }

  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;

  const out = new Array<number>(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) out[i] = vec[i] / norm;
  return out;
}

export const localEmbedder: Embedder = {
  id: "xana-local-hash-v1",
  dim: EMBED_DIM,
  embed: embedText,
};

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/** Jaccard overlap of token sets — the lexical channel beside the vector one. */
export function lexicalOverlap(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared++;
  return shared / (sa.size + sb.size - shared);
}
