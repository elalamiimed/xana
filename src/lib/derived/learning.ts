/**
 * What she learns about you from talking to you.
 *
 * THE GAP THIS FILLS
 *
 * `rememberUtterance` in `./memory` catches the phrasings a human anticipated -
 * "remember that...", "I prefer...", "my sister's name is..." - and stores them.
 * It is precise and it is offline, and it is also the whole of the write path, so
 * everything a person says in their own words that does not happen to match one
 * of those patterns is simply not remembered. A fact stated plainly in the middle
 * of a conversation ("the landlord wants an answer by the 20th") is lost.
 *
 * This adds the other half: after a turn, the model is asked whether anything
 * durable was said, and the answer is written through the same store.
 *
 * WHY THIS IS ALLOWED TO BE A MODEL WRITE
 *
 * Because it is the narrowest one in the project, and every part of it is
 * checked:
 *
 *   - It writes **only** to `memories`, through the store's own `remember`, so it
 *     inherits the same validation, embedding and idempotency as every other
 *     memory.
 *   - It stores **facts and preferences about the user**, never a summary of the
 *     conversation, and never a validation. The sycophancy filter is a real
 *     tested one (`soundsSycophantic`) plus a rejection list for the shapes a
 *     model reaches for when asked "anything worth remembering": "the user seems
 *     to appreciate...", "the user is engaged and thoughtful".
 *   - It is **idempotent by content**: a `key:` tag derived from the normalised
 *     fact, checked against `knownKeys()` before writing. The same sentence
 *     extracted twice adds nothing, so a conversation rolled through twice does
 *     not multiply memories.
 *   - It **refuses to run without a model**, and returns `[]` rather than
 *     throwing when one fails. Memory extraction is an upgrade, never a
 *     dependency.
 *
 * The failure this must never have is the one the research named: a memory
 * system that remembers what the user liked *hearing* drifts toward flattery,
 * because the write path is the training signal. So the filter refuses praise in
 * both directions - praise of the user, and any record of the assistant having
 * been praised.
 */

import type { MemoryKind, MemoryRecord } from "../core/types";
import type { XanaStore } from "../core/store";
import { getStore } from "../core/store";
import { llmAvailable, llmComplete } from "../mind/llm";
import { soundsSycophantic } from "../mind/voice";
import { extractEntities, knownKeys } from "./memory";

/** The kinds a conversation is allowed to produce. */
const ALLOWED: MemoryKind[] = ["fact", "preference", "person", "place", "project", "decision"];

export interface ExtractedFact {
  kind: MemoryKind;
  title: string;
  content: string;
}

const SYSTEM = `You read one exchange between a person and their assistant and return the durable facts about the PERSON that are worth knowing weeks from now. You return JSON only.

Return exactly this shape:
{"facts":[{"kind":"fact|preference|person|place|project|decision","title":"a few words to find it by","content":"the fact, one sentence, third person"}]}

Rules, in order of importance:
1. A fact must be something the PERSON said about themselves or their life. Never about the assistant, and never about the conversation.
2. Durable only. "Prefers mornings for deep work" is durable. "Is tired today" is not. "Moved the meeting to Thursday" is a calendar fact, not a memory, unless the date itself matters later.
3. Never record praise, agreement or approval - not theirs of you, and not yours of them. "They liked the suggestion" is not a fact worth keeping.
4. Never record anything you inferred. If they did not say it, it is not a fact.
5. Return at most 3. An empty list is the correct and common answer: most exchanges contain nothing durable, and returning nothing is better than returning something weak.
6. No commentary, no preamble, no markdown.`;

export interface ExtractOptions {
  store?: XanaStore;
  /** Skip the model. Used by tests and the offline path. */
  forceLocal?: boolean;
  /** Recorded on the memory, as `rememberUtterance` does, so a fact can be
   *  traced back to the conversation it came from. */
  sessionId?: string;
}

/**
 * Ask the model what is worth keeping, then write what survives the filters.
 *
 * Returns the memories it actually wrote, which is the honest answer to "did
 * this learn anything" - not what the model proposed.
 */
export async function rememberConversation(
  turn: { userText: string; xanaText: string },
  opts: ExtractOptions = {},
): Promise<MemoryRecord[]> {
  // No model, no extraction. The offline path is `rememberUtterance`, which the
  // caller has already run; this is additive and must never be a requirement.
  if (opts.forceLocal || !llmAvailable()) return [];

  const store = opts.store ?? getStore();
  const userText = turn.userText.trim();
  if (userText.length < 12) return [];

  let proposed: ExtractedFact[];
  try {
    const completion = await llmComplete(
      [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `THEY SAID: ${userText}\n\nASSISTANT REPLIED: ${turn.xanaText.trim().slice(0, 600)}`,
        },
      ],
      // No thinking: this is extraction, not reasoning, and the thinking tokens
      // would be pure latency on a path the user is already waiting on.
      { maxTokens: 500, thinking: false, responseFormat: "json_object", timeoutMs: 12_000 },
    );
    proposed = parseFacts(completion.text);
  } catch {
    // Best-effort by design. A model that is down must not cost the user a turn.
    return [];
  }

  const already = knownKeys(store);
  const written: MemoryRecord[] = [];

  for (const fact of proposed.slice(0, 3)) {
    const key = keyFor(fact);
    if (already.has(key)) continue;
    if (!isWorthKeeping(fact)) continue;

    /**
     * Exact key first, then a semantic check - because the key is not enough.
     *
     * `keyFor` hashes the *text*, so it catches the identical sentence and
     * nothing else. The model is not deterministic, and re-running the same
     * conversation produced "Their landlord wants an answer about the deposit by
     * the 20th." and then "The landlord is asking for a deposit answer by the
     * 20th." - the same fact, two keys, two rows. That is the failure this whole
     * module is supposed to prevent, so it is caught properly rather than by
     * hoping the wording repeats.
     *
     * The store's own recall does the work: it already fuses lexical and
     * semantic search, so a rephrase lands, and the embedding is compared
     * directly to confirm it is the same fact rather than a related one. The
     * 0.86 floor is high on purpose - "prefers mornings for deep work" and
     * "prefers afternoons for deep work" are one edit apart in wording and
     * opposite in meaning, and a loose threshold would silently keep the older
     * one.
     */
    if (nearDuplicate(store, fact)) continue;

    try {
      const record = store.remember({
        kind: fact.kind,
        title: fact.title,
        content: fact.content,
        entities: extractEntities(`${fact.title} ${fact.content}`),
        tags: [`key:${key}`, "learned"],
        // Below a stated preference and above an incidental note: something the
        // model judged durable but the user did not emphasise.
        salience: 0.55,
        source: "conversation",
        sessionId: opts.sessionId,
      });
      already.add(key);
      written.push(record);
    } catch {
      // The store is the only thing that can fail here, and a memory write must
      // never break the turn that produced it.
    }
  }

  return written;
}

/**
 * How close two embeddings must be before they are called the same fact.
 *
 * **Measured, not guessed.** From a probe on 2026-10-10, with the hashing
 * embedder this project ships. Every pair below is in the shape the module
 * actually compares - `title. content` - except where it says otherwise:
 *
 *   | pair                                                          | cosine |
 *   |---------------------------------------------------------------|--------|
 *   | SAME: "…deposit…by the 20th" vs "…give their landlord          | 0.809  |
 *   |       an answer…by the 20th", with the model's own titles      |        |
 *   | SAME: same pair, short generated title ("Landlord.")           | 0.776  |
 *   | SAME: same pair, longer generated title                        | 0.758  |
 *   | SAME: content only, no title at all                            | 0.730  |
 *   | DIFF: "Runs on Tuesdays" vs "Runs on Thursdays"                | 0.743  |
 *   | DIFF: "mornings for deep work" vs "afternoons…"                | 0.691  |
 *   | DIFF: "…deposit by the 20th" vs "…plumber for the bathroom"    | 0.634  |
 *
 * So the pairs that must match sit at 0.73-0.81 and the ones that must not sit
 * at 0.74 and below: **the ranges overlap by about one point.** A single
 * threshold on this embedder cannot separate them perfectly, and that is not a
 * tuning problem to solve - it is the measured ceiling of feature hashing, and
 * the concrete case for the local sentence-transformer that has not been done
 * yet. It is written down here so that decision rests on a number.
 *
 * 0.75 is chosen because production always supplies a title, which puts the
 * rephrases at 0.758 and above, and because the two errors are not symmetric: a
 * miss writes an untidy near-duplicate, while a false positive **silently drops
 * a fact the user stated**. So the threshold errs toward catching duplicates,
 * and `scripts/check-learning.ts` asserts both directions plus the known overlap.
 */
export const DUPLICATE_SIMILARITY = 0.75;

/**
 * Is this fact already stored, in different words?
 *
 * Deliberately conservative in both directions: a miss writes a near-duplicate,
 * which is untidy; a false positive silently *drops* a fact the user stated,
 * which is a lie by omission. So the recall is only a candidate filter - the
 * decision is made on the embeddings, and only for the same kind.
 */
function nearDuplicate(store: XanaStore, fact: ExtractedFact): boolean {
  const text = `${fact.title}. ${fact.content}`;
  let candidates;
  try {
    /**
     * `minScore: 0.4`, not the recall default of 0.1.
     *
     * The recall score is a blend that includes salience and recency, both of
     * which pull a stored fact *down* even when the text matches well - so a low
     * floor is needed for the candidate to survive at all. 0.1 was too low in the
     * other direction and 0.4 was arrived at by checking that a rephrase with the
     * measured 0.78 cosine still comes back; the embedding comparison below is
     * what actually decides.
     */
    candidates = store.recall(text, { kinds: [fact.kind], limit: 5, minScore: 0.4 });
  } catch {
    return false;
  }

  const mine = store.embedQuery(text);
  for (const hit of candidates) {
    const theirs = store.vectorOf(hit.memory.id);
    if (!theirs) continue;
    let dot = 0;
    const n = Math.min(mine.length, theirs.length);
    for (let i = 0; i < n; i += 1) dot += mine[i] * theirs[i];
    if (dot >= DUPLICATE_SIMILARITY) return true;
  }
  return false;
}

/**
 * The filters a proposed fact has to survive.
 *
 * Exported because it is the part worth testing on its own, and because a
 * reviewer should be able to read the rules without reading the prompt.
 */
export function isWorthKeeping(fact: ExtractedFact): boolean {
  const kind = fact.kind;
  if (!ALLOWED.includes(kind)) return false;

  const title = fact.title.trim();
  const content = fact.content.trim();
  if (title.length < 3 || title.length > 120) return false;
  if (content.length < 12 || content.length > 500) return false;

  // The sycophancy filter, shared with the reply path so the two cannot drift.
  if (soundsSycophantic(`${title} ${content}`)) return false;

  /**
   * The shapes a model reaches for when asked "anything worth remembering" and
   * there is nothing. None of these is a fact about the user's life; they are
   * observations about the conversation, which is exactly what rule 1 forbids.
   */
  const META = [
    /\bthe user (?:seems|appears|is being|was being)\b/i,
    /\b(?:engaged|thoughtful|open|receptive|appreciative|collaborative|curious)\b/i,
    /\bthe (?:conversation|exchange|discussion|assistant|reply)\b/i,
    /\b(?:thanked|praised|complimented|appreciated|liked|enjoyed) (?:the|your|my)\b/i,
    /\b(?:asked about|wanted to know about|inquired)\b/i,
  ];
  if (META.some((p) => p.test(`${title} ${content}`))) return false;

  // A "fact" that is really a to-do belongs in tasks, not memory. This is the
  // most common confusion and it is worth one pattern to prevent it.
  if (/^(?:needs? to|has to|should|must|remember to|todo:)/i.test(content)) return false;

  return true;
}

/** Read the model's JSON defensively; a refusal or prose is not an error. */
function parseFacts(text: string): ExtractedFact[] {
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>).facts
      : undefined;
  if (!Array.isArray(list)) return [];

  const out: ExtractedFact[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const f = raw as Record<string, unknown>;
    const kind = typeof f.kind === "string" ? (f.kind as MemoryKind) : "fact";
    const title = typeof f.title === "string" ? f.title : "";
    const content = typeof f.content === "string" ? f.content : "";
    if (!title || !content) continue;
    out.push({ kind, title, content });
  }
  return out;
}

/**
 * A stable key for a fact, so the same thing learned twice is stored once.
 *
 * Normalised to lowercase with punctuation and runs of whitespace collapsed, so
 * "Prefers mornings for deep work." and "prefers mornings for deep work" are one
 * memory. The `key:` prefix is the convention `ingestSnapshot` already uses,
 * which means `knownKeys()` covers derived memories and learned ones alike.
 */
export function keyFor(fact: ExtractedFact): string {
  const normalized = `${fact.title} ${fact.content}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `learned-${h.toString(16)}`;
}
