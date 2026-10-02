/**
 * Memory ingestion — turning the day's data into durable memory.
 *
 * Xana's brain is only as good as what gets written to it. This module is the
 * write path: it walks a freshly-collected snapshot and distils the things
 * genuinely worth remembering into `memories`, with entity extraction so that
 * "who is Mom" and "what is the launch" resolve later.
 *
 * Two rules keep the store from silting up:
 *
 *  1. **Idempotence.** Everything is keyed. Ingesting the same snapshot twice
 *     adds nothing, because the second pass sees the key already present.
 *  2. **Supersession.** When you say "actually I prefer mornings now", the old
 *     preference is marked superseded rather than deleted, so recall stays
 *     consistent and the history survives.
 */

import type { LifeSnapshot } from "../adapters/types";
import type { MemoryKind, MemoryRecord } from "../core/types";
import { getStore, type XanaStore } from "../core/store";
import { tokenize } from "../core/vector";

/* ------------------------------------------------------------------ */
/* Entity extraction                                                   */
/* ------------------------------------------------------------------ */

/** Capitalised words that are never people or projects. */
const ENTITY_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "i", "we", "you", "they", "it",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "today", "tomorrow", "yesterday", "morning", "afternoon", "evening", "night",
  "ok", "okay", "sure", "yes", "no", "done", "new", "next", "last", "this",
]);

/**
 * Pull likely people, places and projects out of free text. Capitalisation is
 * the signal, which is crude but works well on the way people actually write
 * notes and tasks: "call Mom", "review the Aurora deck", "meet Sam in Lisbon".
 */
export function extractEntities(text: string): string[] {
  const found = new Set<string>();

  // Runs of capitalised words, allowing internal lowercase connectors.
  const matches = text.match(/\b[A-Z][a-zA-Z0-9'’-]*(?:\s+(?:of|the|and|de|van|von)\s+[A-Z][a-zA-Z0-9'’-]*|\s+[A-Z][a-zA-Z0-9'’-]*)*/g) ?? [];
  for (const raw of matches) {
    const candidate = raw.trim();
    // Skip a leading sentence-initial capital that is just a common word.
    const words = candidate.split(/\s+/);
    const cleaned = words.filter((w, i) => !(i === 0 && ENTITY_STOPWORDS.has(w.toLowerCase())));
    if (cleaned.length === 0) continue;
    const value = cleaned.join(" ");
    if (value.length < 2 || value.length > 48) continue;
    if (ENTITY_STOPWORDS.has(value.toLowerCase())) continue;
    if (/^\d+$/.test(value)) continue;
    found.add(value);
  }

  // "@name" and "#project" conventions.
  for (const m of text.matchAll(/[@#]([A-Za-z][A-Za-z0-9_-]{1,30})/g)) {
    found.add(m[1]);
  }

  return [...found].slice(0, 8);
}

/** Topics behind a memory — the words that make it findable later. */
export function extractTags(text: string): string[] {
  const tokens = tokenize(text);
  const counts = new Map<string, number>();
  for (const t of tokens) {
    if (t.length < 4) continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([t]) => t);
}

/* ------------------------------------------------------------------ */
/* Ingestion                                                           */
/* ------------------------------------------------------------------ */

export interface IngestResult {
  written: number;
  skipped: number;
  superseded: number;
}

interface PendingMemory {
  key: string;
  kind: MemoryKind;
  title: string;
  content: string;
  entities: string[];
  tags: string[];
  salience: number;
  source: string;
  /** When true, this memory replaces any earlier one sharing its key. */
  supersedes?: string;
}

/**
 * Ingest a life snapshot into memory.
 *
 * `key` is the idempotence handle: it is stored in the memory's tags as
 * `key:<value>` so a later pass can see what is already known without a schema
 * change or a second index.
 */
export function ingestSnapshot(
  snapshot: LifeSnapshot,
  store: XanaStore = getStore(),
  sessionId?: string,
): IngestResult {
  const pending: PendingMemory[] = [];

  /* --- Tasks: only the ones that say something about how you work. --- */
  for (const task of snapshot.tasks) {
    if (task.status === "done") {
      pending.push({
        key: `task-done:${task.id}`,
        kind: "task",
        title: `Completed: ${task.title}`,
        content: `${task.title} was completed${task.project ? ` in ${task.project}` : ""}. Priority ${task.priority}.`,
        entities: [...(task.people ?? []), ...(task.project ? [task.project] : [])],
        tags: ["completion", ...(task.tags ?? [])],
        salience: task.priority <= 2 ? 0.62 : 0.34,
        source: task.source,
      });
      continue;
    }
    // An open high-priority task is a standing intention worth recalling.
    if (task.priority <= 2) {
      pending.push({
        key: `task-open:${task.id}`,
        kind: "task",
        title: task.title,
        content: `Open ${task.priority === 1 ? "top-priority" : "high-priority"} task${task.project ? ` in ${task.project}` : ""}.`,
        entities: extractEntities(task.title),
        tags: ["intention", ...(task.tags ?? [])],
        salience: 0.45,
        source: task.source,
      });
    }
  }

  /* --- Events: commitments become memory so conflicts are detectable. --- */
  for (const event of snapshot.events) {
    if (event.allDay) continue;
    const people = event.attendees ?? [];
    pending.push({
      key: `event:${event.id}`,
      kind: "event",
      title: event.title,
      content: `Scheduled${event.location ? ` at ${event.location}` : ""}${people.length ? ` with ${people.join(", ")}` : ""} on ${event.start}.`,
      entities: [...people, ...(event.location ? [event.location] : [])],
      tags: ["schedule"],
      salience: people.length > 0 ? 0.52 : 0.32,
      source: event.source,
    });
  }

  /* --- Notes: the richest signal, ingested nearly whole. --- */
  for (const note of snapshot.notes) {
    pending.push({
      key: `note:${note.id}`,
      kind: "note",
      title: note.title,
      content: note.body.slice(0, 1200),
      entities: extractEntities(`${note.title}\n${note.body.slice(0, 600)}`),
      tags: [...note.tags, ...extractTags(note.body)].slice(0, 8),
      salience: 0.58,
      source: note.source,
    });
  }

  /* --- Health: aggregates only. Daily sleep is not worth a memory each. --- */
  const health = snapshot.health.slice(-7);
  if (health.length >= 3) {
    const sleep = health.filter((h) => typeof h.sleepHours === "number");
    if (sleep.length >= 3) {
      const avg = sleep.reduce((a, h) => a + (h.sleepHours ?? 0), 0) / sleep.length;
      const debt = sleep.reduce((a, h) => a + Math.max(0, 7.5 - (h.sleepHours ?? 7.5)), 0);
      pending.push({
        key: `health-sleep:${health[health.length - 1].date}`,
        kind: "fact",
        title: `Sleep averaged ${avg.toFixed(1)}h over ${sleep.length} days`,
        content: `Trailing sleep average ${avg.toFixed(1)}h with ${debt.toFixed(1)}h of debt across ${sleep.length} logged days.`,
        entities: [],
        tags: ["health", "sleep"],
        salience: debt > 3 ? 0.6 : 0.3,
        source: "health",
      });
    }
  }

  /* --- Write, skipping anything already known. --- */
  const known = knownKeys(store);
  const result: IngestResult = { written: 0, skipped: 0, superseded: 0 };

  for (const p of pending) {
    if (known.has(p.key)) {
      result.skipped++;
      continue;
    }
    store.remember({
      kind: p.kind,
      title: p.title,
      content: p.content,
      entities: p.entities,
      tags: [...p.tags, `key:${p.key}`],
      salience: p.salience,
      source: p.source,
      sessionId,
    });
    known.add(p.key);
    result.written++;
  }

  return result;
}

/** Every `key:` tag currently in the store — including the ones in the bin. */
export function knownKeys(store: XanaStore = getStore()): Set<string> {
  const keys = new Set<string>();
  for (const mem of store.allMemories()) {
    for (const tag of mem.tags) {
      if (tag.startsWith("key:")) keys.add(tag.slice(4));
    }
  }

  /**
   * A memory the user forgot is not unknown — it is forgotten, and this is
   * the pass that has to know the difference.
   *
   * Every key here is a projection of live data: a note, a completed task, a
   * week of sleep. Reading only the live memories meant the tombstone was
   * invisible, so the next ingest pass wrote the record straight back and the
   * user watched something they had just removed reappear within the minute.
   * Counting the bin's keys as known is what makes forgetting a decision
   * rather than a race with a background job.
   */
  for (const key of store.trashedMemoryKeys()) keys.add(key);

  return keys;
}

/* ------------------------------------------------------------------ */
/* Remembering things you say                                          */
/* ------------------------------------------------------------------ */

type Intent = "preference" | "decision" | "person" | "project" | "place" | "fact";

const PATTERNS: Array<{ kind: Intent; re: RegExp; salience: number }> = [
  { kind: "preference", re: /\b(i (?:prefer|like|love|hate|avoid|always|never)|my favourite|i'd rather|i would rather|don't ever|do not ever)\b/i, salience: 0.78 },
  { kind: "decision", re: /\b(i(?:'ve| have)? decided|we(?:'re| are) going with|let'?s go with|final call|i(?:'m| am) going to|i chose|i picked)\b/i, salience: 0.82 },
  { kind: "person", re: /\b(my (?:wife|husband|partner|mother|mom|mum|father|dad|brother|sister|son|daughter|boss|manager|friend|colleague|therapist|doctor))\b/i, salience: 0.8 },
  { kind: "project", re: /\b(i(?:'m| am) (?:working on|building|writing|launching)|the project|our (?:project|launch))\b/i, salience: 0.72 },
  { kind: "place", re: /\b(i live in|i(?:'m| am) based in|i moved to|my (?:office|home|flat|apartment) is)\b/i, salience: 0.7 },
];

/**
 * Decide whether a user utterance is worth remembering, and as what.
 *
 * Most sentences are not. This returns `undefined` far more often than not,
 * which is the point — a memory store full of small talk is worse than an
 * empty one.
 */
export function classifyUtterance(text: string): { kind: MemoryKind; title: string; salience: number } | undefined {
  const trimmed = text.trim();
  if (trimmed.length < 12 || trimmed.length > 600) return undefined;

  for (const p of PATTERNS) {
    const m = p.re.exec(trimmed);
    if (!m) continue;
    const title = summarise(trimmed, 72);
    return { kind: p.kind as MemoryKind, title, salience: p.salience };
  }
  return undefined;
}

function summarise(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : max)}…`;
}

/**
 * Store something the user said, superseding an older memory when it is a
 * genuine correction ("actually, I prefer evenings").
 */
export function rememberUtterance(
  text: string,
  store: XanaStore = getStore(),
  sessionId?: string,
): MemoryRecord | undefined {
  const classified = classifyUtterance(text);
  if (!classified) return undefined;

  const entities = extractEntities(text);
  const tags = extractTags(text);

  // Fold any contradiction: an earlier memory of the same kind sharing an
  // entity is now out of date.
  if (entities.length > 0 && (classified.kind === "preference" || classified.kind === "fact")) {
    for (const candidate of store.recall(text, { kinds: [classified.kind], limit: 3, minScore: 0.5 })) {
      const shared = candidate.memory.entities.some((e) =>
        entities.some((n) => n.toLowerCase() === e.toLowerCase()),
      );
      if (shared) {
        const replacement = store.remember({
          kind: classified.kind,
          title: classified.title,
          content: text.trim(),
          entities,
          tags: [...tags, `supersedes:${candidate.memory.id}`],
          salience: classified.salience,
          source: "conversation",
          sessionId,
        });
        // Write the back-reference so recall can exclude the stale record.
        store.db
          .prepare(`UPDATE memories SET superseded_by = ? WHERE id = ?`)
          .run(replacement.id, candidate.memory.id);
        return replacement;
      }
    }
  }

  return store.remember({
    kind: classified.kind,
    title: classified.title,
    content: text.trim(),
    entities,
    tags,
    salience: classified.salience,
    source: "conversation",
    sessionId,
  });
}

/** Names Xana has met more than once — feeds mail scoring and the people graph. */
export function knownPeople(store: XanaStore = getStore()): string[] {
  return store.recurringEntities(2, ["person"]).map((e) => e.entity);
}
