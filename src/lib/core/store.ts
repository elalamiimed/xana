/**
 * Xana's external brain: durable SQLite storage + vector recall.
 *
 * Design notes:
 *  - Vectors are stored as raw float32 BLOBs, so no SQLite extension is needed.
 *  - Recall blends four signals: vector cosine, lexical overlap, salience and
 *    recency. Pure cosine on a hashing embedder over-recalls generic phrasing;
 *    the blend is what makes "what did I decide about the launch" land on the
 *    actual decision rather than every note containing "the".
 *  - The DB file lives in <project>/data/xana.db and is safe to delete: it
 *    rebuilds and re-seeds on next boot.
 */

import BetterSqlite3 from "better-sqlite3";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type {
  CalendarEvent,
  FocusSession,
  Goal,
  GoalProgress,
  Habit,
  HealthSample,
  MemoryHit,
  MemoryKind,
  MemoryRecord,
  Milestone,
  MoodLabel,
  Note,
  Reflection,
  Task,
  TaskStatus,
  TrashItem,
  TrashKind,
} from "./types";
import { TRASH_DAYS } from "./types";
import { cosine, lexicalOverlap, localEmbedder, type Embedder } from "./vector";
import { clamp, nowIso, recencyWeight, toDateKey, uid } from "./time";

type Row = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* The trash                                                           */
/* ------------------------------------------------------------------ */

/** Which table each kind lives in, so the bin can put it back. */
const TRASH_TABLES: Record<TrashKind, string> = {
  task: "tasks",
  event: "events",
  goal: "goals",
  milestone: "milestones",
  note: "notes",
  memory: "memories",
};

/**
 * A JSON round trip is not identity for a BLOB.
 *
 * `JSON.stringify` turns a Buffer into `{type: "Buffer", data: [...]}`, and
 * inserting that object back would store the string "[object Object]" where a
 * memory's embedding belongs — a restored memory that is present, readable, and
 * invisible to recall. This is the one value in the whole schema that needs it.
 */
function rehydrate(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "Buffer" &&
    Array.isArray((value as { data?: unknown }).data)
  ) {
    return Buffer.from((value as { data: number[] }).data);
  }
  return value;
}

/**
 * Which goal a binned milestone belongs to, read from the row that was stored.
 *
 * Parsed rather than pattern-matched: a `LIKE '%"goal_id":"…"%'` also matches a
 * milestone whose *title* happens to contain that text, and stepping through
 * the rows means no index and no escaped pattern to get wrong. The bin is
 * bounded by a week, so the scan is nothing.
 */
function payloadGoalId(payload: string): string | undefined {
  try {
    const parsed = JSON.parse(payload) as { goal_id?: unknown };
    return typeof parsed.goal_id === "string" ? parsed.goal_id : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Vector <-> BLOB                                                     */
/* ------------------------------------------------------------------ */

export function encodeVector(vec: number[]): Buffer {
  const f = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) f[i] = vec[i];
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

export function decodeVector(buf: Buffer): Float32Array {
  // Copy into a fresh, 4-byte-aligned buffer — SQLite BLOBs are not guaranteed aligned.
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export class XanaStore {
  readonly db: BetterSqlite3.Database;
  /** Where this store lives. `:memory:` for a scratch run. */
  private readonly file: string;
  private embedder: Embedder;

  constructor(filename?: string, embedder: Embedder = localEmbedder) {
    const file = filename ?? defaultDbPath();
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new BetterSqlite3(file);
    this.file = file;
    this.embedder = embedder;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 4000");
    /**
     * Durability, stated rather than inherited.
     *
     * `synchronous = NORMAL` is the setting the SQLite documentation pairs with
     * WAL: a committed transaction is durable across an application crash, and
     * can be lost only if the *operating system* loses power before the write
     * reaches the disk. `FULL` would fsync on every commit, which for a local
     * assistant that writes a conversation row per utterance buys a guarantee
     * nobody is asking for at the cost of a stall per message. `OFF` would let
     * the WAL be what it quietly becomes if nobody chooses: fast, and able to
     * lose committed data. Naming it here means it is a decision on the record.
     */
    this.db.pragma("synchronous = NORMAL");
    /**
     * Checkpoint automatically once the log passes ~1 MB (250 pages of 4 KB).
     *
     * SQLite's default, stated here because it is load-bearing rather than
     * incidental: it is what keeps the log bounded *during* a long session, and
     * this app has to run for days without a restart. The explicit checkpoint on
     * open is what makes the file complete after a crash; this is what stops the
     * log growing without limit before that crash even matters.
     *
     * Raising it would let more uncommitted-to-the-main-file data accumulate;
     * lowering it would fold the log in every few writes for no benefit, since a
     * reader never sees the log's contents anyway — WAL exists precisely so a
     * read does not have to wait for one.
     */
    this.db.pragma("wal_autocheckpoint = 250");
    /**
     * Fold the write-ahead log back into the database on open.
     *
     * WAL is what makes a read not block a write, but the log grows until
     * something checkpoints it, and nothing did: a dev server that ran for a
     * while left a 2.9 MB `-wal` beside a 320 KB database, so the durable file
     * was a tenth of what "your data" actually was. A crash in that state can
     * still replay the log — SQLite is careful — but a copy of `xana.db` made by
     * anyone who did not know to bring `-wal` along was silently missing most of
     * the history.
     *
     * TRUNCATE rather than PASSIVE: this is a once-per-open moment, so paying
     * for the log to actually shrink to zero is worth it, and it means the file
     * on disk is complete from the first second the app is up.
     */
    this.checkpoint();
    this.migrate();
    this.addMissingColumns();
    this.backfillGoalOrder();
    // Anything that has been in the trash for longer than a week goes now,
    // rather than waiting for someone to open the bin. See `TRASH_DAYS`.
    this.purgeTrash();
  }

  /**
   * Fold the write-ahead log into the database file.
   *
   * Called on open, on close, and whenever a caller wants the on-disk file to be
   * the whole truth — the backup script, and the dev server's shutdown handler.
   * Returns what happened, so a caller can report it rather than assume.
   *
   * A checkpoint on a connection with no writes is nearly free, which is what
   * makes "always checkpoint on open" a reasonable thing to do rather than a
   * cost to weigh.
   */
  checkpoint(mode: "PASSIVE" | "TRUNCATE" = "TRUNCATE"): { busy: number; log: number; checkpointed: number } {
    if (this.file === ":memory:") return { busy: 0, log: 0, checkpointed: 0 };
    try {
      const row = this.db.pragma(`wal_checkpoint(${mode})`, { simple: false }) as
        | Array<{ busy: number; log: number; checkpointed: number }>
        | undefined;
      const first = row?.[0];
      return {
        busy: Number(first?.busy ?? 0),
        log: Number(first?.log ?? 0),
        checkpointed: Number(first?.checkpointed ?? 0),
      };
    } catch {
      // A checkpoint is maintenance. A database that cannot take one still
      // reads and writes correctly, and refusing to start over it would be a
      // far worse failure than a log that stays where it is.
      return { busy: 0, log: 0, checkpointed: 0 };
    }
  }

  /**
   * Write a consistent copy of the database to `target`.
   *
   * The Online Backup API, not a file copy. Copying `xana.db` while the app is
   * writing gives you a torn database, and copying it while forgetting `-wal`
   * gives you a database missing every recent write — both of which *look* like
   * a backup until the day you need one. `db.backup()` runs the same routine
   * SQLite's own `.backup` command uses: it takes a read lock, copies page by
   * page, and restarts the copy if a writer changes something underneath it, so
   * the result is a database as of a single instant.
   *
   * The copy is checkpointed before it is handed back, so it is one self-
   * contained file rather than another WAL pair for the user to keep together.
   */
  async backupTo(target: string): Promise<{ ok: boolean; path: string; bytes: number; error?: string }> {
    if (this.file === ":memory:") {
      return { ok: false, path: target, bytes: 0, error: "there is nothing on disk to back up" };
    }
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      await this.db.backup(target);
      // Open the copy to fold any log the backup API left beside it, then close
      // it: the point of a backup is one file you can move somewhere else.
      const copy = new BetterSqlite3(target);
      try {
        copy.pragma("wal_checkpoint(TRUNCATE)");
      } finally {
        copy.close();
      }
      const bytes = statSync(target).size;
      return { ok: true, path: target, bytes };
    } catch (err) {
      return { ok: false, path: target, bytes: 0, error: describeError(err) };
    }
  }

  /** Where this store keeps its file. Reported by the About panel and scripts. */
  get path(): string {
    return this.file;
  }

  close(): void {
    // Checkpoint first. `close()` on the last connection does fold the log in,
    // but it does so silently and only because SQLite is being careful; doing it
    // explicitly means the durable file is complete even on the paths where the
    // process never gets to call this at all.
    this.checkpoint();
    this.db.close();
  }

  /**
   * Add columns introduced after a database was first created.
   *
   * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so a new
   * column in the schema above never reaches a database that already exists.
   * That is silent: the queries referencing it fail, or worse, a feature
   * quietly returns nothing on the developer's machine and works on a fresh
   * one.
   *
   * `PRAGMA table_info` first, because SQLite has no
   * `ADD COLUMN IF NOT EXISTS` and a duplicate add is an error rather than a
   * no-op. Columns are nullable or defaulted so this is safe to run against
   * a populated table, and it runs on every boot, so the check has to be
   * cheap. It is: one pragma per table.
   */
  private addMissingColumns(): void {
    const additions: Array<{ table: string; column: string; definition: string }> = [
      // Drag-and-drop ordering in My cave.
      { table: "goals", column: "sort_order", definition: "REAL" },
      // Explicit "something moved" stamp, so a goal with no milestones can
      // still be credited with progress.
      { table: "goals", column: "last_touched_at", definition: "TEXT" },
      // Pinned memories are always considered for recall and never decay.
      { table: "memories", column: "pinned", definition: "INTEGER NOT NULL DEFAULT 0" },
      // The user's own energy reading, 1-5, and when they gave it. Unlike
      // every other health field this is not imported from anywhere — it is
      // the one number in the app that comes from asking them.
      { table: "health_samples", column: "energy", definition: "INTEGER" },
      { table: "health_samples", column: "energy_at", definition: "TEXT" },
      // Meals logged today, 0-3. A count rather than a list: the briefing
      // asks whether they have eaten, not what.
      { table: "health_samples", column: "meals", definition: "INTEGER" },
    ];

    for (const { table, column, definition } of additions) {
      try {
        const existing = this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all() as Array<{ name: string }>;
        if (existing.some((c) => c.name === column)) continue;
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      } catch {
        // A database that cannot take the column still works; the feature
        // that needs it degrades rather than the app refusing to start.
      }
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        entities TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]',
        salience REAL NOT NULL DEFAULT 0.5,
        source TEXT NOT NULL DEFAULT 'local',
        session_id TEXT,
        created_at TEXT NOT NULL,
        last_accessed_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        superseded_by TEXT,
        vector BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        due TEXT,
        project TEXT,
        people TEXT NOT NULL DEFAULT '[]',
        priority INTEGER NOT NULL DEFAULT 3,
        estimate_minutes INTEGER,
        energy TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'local',
        created_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        start TEXT NOT NULL,
        end TEXT NOT NULL,
        location TEXT,
        attendees TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'local',
        xana_authored INTEGER NOT NULL DEFAULT 0,
        all_day INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_events_start ON events(start);

      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        why TEXT,
        horizon TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        target_date TEXT,
        progress_override REAL,
        area TEXT,
        cadence TEXT
      );

      CREATE TABLE IF NOT EXISTS milestones (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        due TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_milestones_goal ON milestones(goal_id);

      CREATE TABLE IF NOT EXISTS habits (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        target_per_week INTEGER NOT NULL DEFAULT 5,
        unit TEXT,
        cadence_hint TEXT
      );

      CREATE TABLE IF NOT EXISTS habit_log (
        habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        PRIMARY KEY (habit_id, day)
      );

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'local',
        tags TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reflections (
        id TEXT PRIMARY KEY,
        period TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        body TEXT NOT NULL,
        highlights TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS focus_sessions (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        started_at TEXT NOT NULL,
        minutes INTEGER NOT NULL,
        media TEXT,
        completed INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS health_samples (
        day TEXT PRIMARY KEY,
        sleep_hours REAL,
        sleep_quality REAL,
        steps INTEGER,
        active_minutes INTEGER,
        resting_heart_rate INTEGER,
        mood TEXT,
        energy INTEGER,
        energy_at TEXT,
        meals INTEGER,
        source TEXT NOT NULL DEFAULT 'local'
      );
      CREATE INDEX IF NOT EXISTS idx_health_day ON health_samples(day DESC);

      CREATE TABLE IF NOT EXISTS conversation (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_created ON conversation(created_at DESC);

      /*
       * The trash.
       *
       * A deleted row MOVES here — it does not stay in its table with a flag on
       * it. That is a deliberate choice and the reason is the query count: this
       * store is read by the briefing, the derived layers, the adapters, the
       * cave and the seed script, and "remember to filter the deleted rows" is
       * a rule that has to be applied correctly in twenty-five places forever.
       * The first query somebody forgets puts a deleted task back in the
       * briefing. Moving the row means every existing read is already correct,
       * including ones written next year.
       *
       * The payload column holds the whole row as JSON, so a restore puts back
       * exactly what was taken — including a memory's embedding, which is why
       * the BLOB is rehydrated rather than re-embedded (a restore must not
       * change what recall finds, and re-embedding could).
       */
      CREATE TABLE IF NOT EXISTS trash (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        title TEXT NOT NULL,
        payload TEXT NOT NULL,
        deleted_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trash_deleted ON trash(deleted_at DESC);
    `);
  }

  /* ---------------- the trash ---------------- */

  /**
   * Every read in this class is written against the live tables, and a deleted
   * row is not in them — it has moved to `trash`. Nothing has to remember to
   * filter, which is the entire point. See the schema note.
   */
  private moveToTrash(kind: TrashKind, refId: string): boolean {
    const table = TRASH_TABLES[kind];
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(refId) as Row | undefined;
    if (!row) return false;

    const title = typeof row.title === "string" && row.title.trim() ? row.title : "(untitled)";
    this.db
      .prepare(
        `INSERT OR REPLACE INTO trash (id, kind, ref_id, title, payload, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(`${kind}:${refId}`, kind, refId, title, JSON.stringify(row), nowIso());
    this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(refId);
    return true;
  }

  /** What is in the bin, newest first, with the days it has left. */
  listTrash(): TrashItem[] {
    this.purgeTrash();
    const now = Date.now();
    const rows = this.db
      .prepare(`SELECT kind, ref_id, title, payload, deleted_at FROM trash ORDER BY deleted_at DESC`)
      .all() as Array<{ kind: string; ref_id: string; title: string; payload: string; deleted_at: string }>;

    /**
     * A goal's steps went into the bin with it and have no separate life
     * there: restoring the goal brings them back and "delete for good" takes
     * them with it. Listing them was the opposite claim — one deleted goal
     * filled the bin with a row per step — and it offered two actions that
     * could only produce a milestone whose goal was still in the bin. So the
     * goal is the row, and the row says how many steps came with it, which
     * keeps the count honest instead of quietly dropping them.
     *
     * A step deleted on its own — the ✕ on a goal card — is a different
     * thing: its goal is still on the board, it is restorable on its own, and
     * it is listed like anything else.
     */
    const binnedGoals = new Set(rows.filter((row) => row.kind === "goal").map((row) => row.ref_id));
    const stepsByGoal = new Map<string, number>();
    const hidden = new Set<string>();

    for (const row of rows) {
      if (row.kind !== "milestone") continue;
      const goalId = payloadGoalId(row.payload);
      if (!goalId || !binnedGoals.has(goalId)) continue;
      hidden.add(`${row.kind}:${row.ref_id}`);
      stepsByGoal.set(goalId, (stepsByGoal.get(goalId) ?? 0) + 1);
    }

    return rows
      .filter((row) => !hidden.has(`${row.kind}:${row.ref_id}`))
      .map((row) => {
        const deletedAt = new Date(row.deleted_at);
        const expiresAt = new Date(deletedAt.getTime() + TRASH_DAYS * 86_400_000);
        const steps = stepsByGoal.get(row.ref_id);
        return {
          kind: row.kind as TrashKind,
          id: row.ref_id,
          title: row.title,
          deletedAt: row.deleted_at,
          daysLeft: Math.max(0, Math.ceil((expiresAt.getTime() - now) / 86_400_000)),
          ...(steps ? { steps } : {}),
        };
      });
  }

  /**
   * Put a deleted thing back exactly as it was.
   *
   * The payload is the row that was removed, so the restore is an insert of the
   * same values rather than a reconstruction from memory — a task comes back
   * with its due date and priority, and a memory comes back with its embedding
   * intact rather than re-embedded from text that may read differently now.
   *
   * Keys the table no longer has are dropped rather than fatal: a row deleted
   * before a schema change must still be restorable, with the new columns left
   * at their defaults.
   */
  restoreFromTrash(kind: TrashKind, refId: string): boolean {
    const table = TRASH_TABLES[kind];
    const row = this.db
      .prepare(`SELECT payload FROM trash WHERE kind = ? AND ref_id = ?`)
      .get(kind, refId) as { payload: string } | undefined;
    if (!row) return false;

    let payload: Row;
    try {
      payload = JSON.parse(row.payload) as Row;
    } catch {
      return false;
    }

    const columns = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((c) => c.name)
      .filter((name) => name in payload);
    if (columns.length === 0) return false;

    this.db
      .prepare(
        `INSERT OR REPLACE INTO ${table} (${columns.join(", ")})
         VALUES (${columns.map(() => "?").join(", ")})`,
      )
      .run(...columns.map((name) => rehydrate(payload[name])));

    this.db.prepare(`DELETE FROM trash WHERE id = ?`).run(`${kind}:${refId}`);

    // A goal's milestones went into the bin with it, so they come back with it.
    // Without this a restored goal would open empty, which reads as data loss
    // even though nothing was lost.
    if (kind === "goal") {
      for (const child of this.binnedMilestonesOf(refId)) {
        this.restoreFromTrash("milestone", child);
      }
    }
    return true;
  }

  /**
   * Remove everything that has been in the bin for longer than `TRASH_DAYS`.
   *
   * Called on every open and before every listing, which is what makes the
   * window a real promise instead of a label: the app has to run for the purge
   * to happen, and it is the app that wrote the thing.
   */
  purgeTrash(now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - TRASH_DAYS * 86_400_000).toISOString();
    return this.db.prepare(`DELETE FROM trash WHERE deleted_at < ?`).run(cutoff).changes;
  }

  /** Empty the bin on purpose — the one delete with no way back. */
  emptyTrash(): number {
    return this.db.prepare(`DELETE FROM trash`).run().changes;
  }

  /**
   * Drop one item out of the bin ahead of the deadline.
   *
   * The interface offers it as "delete for good", which is the only irreversible
   * verb in the app, so it is its own call rather than a flag on `restore` —
   * nothing should be able to remove something permanently by accident.
   *
   * A goal takes its steps with it, because they are only in the bin as part
   * of it. They were left behind once, and the bin then held milestones for a
   * goal that no longer existed: rows that could still be restored, into a
   * board that could never show them.
   */
  purgeOne(kind: TrashKind, refId: string): boolean {
    if (kind === "goal") {
      for (const child of this.binnedMilestonesOf(refId)) {
        this.purgeOne("milestone", child);
      }
    }
    return this.db.prepare(`DELETE FROM trash WHERE kind = ? AND ref_id = ?`).run(kind, refId).changes > 0;
  }

  /** The ids of the milestones that went into the bin with this goal. */
  private binnedMilestonesOf(goalId: string): string[] {
    const rows = this.db
      .prepare(`SELECT ref_id, payload FROM trash WHERE kind = 'milestone'`)
      .all() as Array<{ ref_id: string; payload: string }>;
    return rows.filter((row) => payloadGoalId(row.payload) === goalId).map((row) => row.ref_id);
  }

  /* ---------------- memories ---------------- */

  remember(input: {
    kind: MemoryKind;
    title: string;
    content: string;
    entities?: string[];
    tags?: string[];
    salience?: number;
    source?: string;
    sessionId?: string;
    createdAt?: string;
  }): MemoryRecord {
    const rec: MemoryRecord = {
      id: uid("mem"),
      kind: input.kind,
      title: input.title,
      content: input.content,
      entities: input.entities ?? [],
      tags: input.tags ?? [],
      salience: clamp(input.salience ?? 0.5, 0, 1),
      source: input.source ?? "local",
      sessionId: input.sessionId,
      createdAt: input.createdAt ?? nowIso(),
      accessCount: 0,
    };
    const vec = this.embedder.embed(`${rec.title}\n${rec.content}\n${rec.entities.join(" ")}`);
    this.db
      .prepare(
        `INSERT INTO memories (id, kind, title, content, entities, tags, salience, source,
           session_id, created_at, access_count, vector)
         VALUES (@id, @kind, @title, @content, @entities, @tags, @salience, @source,
           @sessionId, @createdAt, 0, @vector)`,
      )
      .run({
        id: rec.id,
        kind: rec.kind,
        title: rec.title,
        content: rec.content,
        entities: JSON.stringify(rec.entities),
        tags: JSON.stringify(rec.tags),
        salience: rec.salience,
        source: rec.source,
        sessionId: rec.sessionId ?? null,
        createdAt: rec.createdAt,
        vector: encodeVector(vec),
      });
    return rec;
  }

  allMemories(): MemoryRecord[] {
    return (this.db.prepare(`SELECT * FROM memories WHERE superseded_by IS NULL`).all() as Row[]).map(
      rowToMemory,
    );
  }

  memoryById(id: string): MemoryRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToMemory(row) : undefined;
  }

  /**
   * Blended recall. `query` is the user's words; results are re-ranked so that
   * memories about the same people/projects win over merely similar phrasing.
   *
   * PINNED MEMORIES ARE ALWAYS INCLUDED
   *
   * Pinning previously raised a memory's salience, which is worth about 0.12
   * of the score. That is not what "pinned" means to a user: a fact they
   * explicitly marked as important could still be outranked by a strongly
   * matching fragment of yesterday's conversation, so the pin did nothing
   * they could rely on.
   *
   * So pinned entries are added to the result independently of their score,
   * and are allowed to bypass `minScore`. The blend then fills the remaining
   * slots by relevance. This is the one place a memory is surfaced for a
   * reason other than "it matched", which is exactly the guarantee a pin is
   * for — a birthday, an allergy, the name of a long-running project.
   */
  recall(query: string, opts: { limit?: number; kinds?: MemoryKind[]; minScore?: number; entityHint?: string[] } = {}): MemoryHit[] {
    const limit = opts.limit ?? 5;
    const minScore = opts.minScore ?? 0.08;
    const qvec = this.embedder.embed(query);
    const hintSet = new Set((opts.entityHint ?? []).map((e) => e.toLowerCase()));

    const rows = this.db
      .prepare(
        opts.kinds?.length
          ? `SELECT * FROM memories WHERE superseded_by IS NULL AND kind IN (${opts.kinds.map(() => "?").join(",")})`
          : `SELECT * FROM memories WHERE superseded_by IS NULL`,
      )
      .all(...(opts.kinds?.length ? opts.kinds : [])) as Row[];

    const pinned: MemoryHit[] = [];
    const scored: MemoryHit[] = [];

    for (const row of rows) {
      const mem = rowToMemory(row);
      const vecBlob = row.vector as Buffer | null;
      const sim = vecBlob ? cosine(qvec, decodeVector(vecBlob)) : 0;
      const lex = lexicalOverlap(query, `${mem.title} ${mem.content} ${mem.entities.join(" ")}`);
      const recency = recencyWeight(mem.createdAt, 45);
      const entityBoost = mem.entities.some((e) => hintSet.has(e.toLowerCase())) ? 0.18 : 0;

      const score = clamp(
        0.52 * Math.max(0, sim) + 0.26 * lex + 0.14 * mem.salience + 0.08 * recency + entityBoost,
        0,
        1,
      );

      if (mem.pinned) {
        pinned.push({
          memory: mem,
          score,
          // Named for what it is. A pinned memory that scored badly is here
          // because the user asked for it, not because it matched, and the
          // UI should be able to say so honestly rather than implying a
          // relevance it does not have.
          reason: score >= minScore ? describeRecall(sim, lex, mem) : "you pinned this",
        });
        continue;
      }

      if (score < minScore) continue;
      scored.push({ memory: mem, score, reason: describeRecall(sim, lex, mem) });
    }

    pinned.sort((a, b) => b.score - a.score);
    scored.sort((a, b) => b.score - a.score);

    // Pinned first, then the best of the rest. Pinned entries cannot crowd
    // out everything else, though: they take at most half the slots, so an
    // over-pinned store still answers the question that was asked.
    const pinnedBudget = Math.max(1, Math.ceil(limit / 2));
    const top = [...pinned.slice(0, pinnedBudget), ...scored].slice(0, limit);

    if (top.length) this.markAccessed(top.map((h) => h.memory.id));
    return top;
  }

  markAccessed(ids: string[]): void {
    const stmt = this.db.prepare(
      `UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
    );
    const tx = this.db.transaction((list: string[]) => {
      for (const id of list) stmt.run(nowIso(), id);
    });
    tx(ids);
  }

  /* ------------------------------------------------------------------ */
  /* Memory curation                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Pin or unpin a memory.
   *
   * Pinning raises salience to 1 as well as setting the flag, because the
   * recall blend weights salience and the flag only exempts the entry from
   * decay. Setting the flag alone would leave a pinned fact ranked below a
   * trivial recollection from this morning, which is the opposite of what
   * pinning means.
   */
  setMemoryPinned(id: string, pinned: boolean): MemoryRecord | undefined {
    this.db
      .prepare(`UPDATE memories SET pinned = ?${pinned ? ", salience = 1" : ""} WHERE id = ?`)
      .run(pinned ? 1 : 0, id);
    return this.memoryById(id);
  }

  /**
   * Forget a memory.
   *
   * A hard delete, and that is a deliberate departure from how contradictions
   * are handled elsewhere. Superseding is for "this was true and then changed",
   * where keeping the history is useful. Forgetting is the user saying a thing
   * should not be known — so the row leaves `memories` entirely rather than
   * sitting in it behind a flag, which would leave it in `allMemories`, in the
   * vector index, and reachable by a recall that happened to score it well.
   *
   * It goes to the trash rather than nowhere, which preserves every word of
   * that reasoning: the row is out of the table, out of the index and out of
   * reach of recall, and the user can still undo a misheard "forget that" for a
   * week. `forget` is about what the app knows; the bin is about what the user
   * can take back, and the two are not in conflict.
   *
   * Returns whether anything was removed, so the caller can tell "forgotten"
   * from "there was nothing there".
   */
  forgetMemory(id: string): boolean {
    return this.moveToTrash("memory", id);
  }

  /**
   * Edit a memory's text.
   *
   * The vector is recomputed, not left stale. This is the whole reason the
   * method exists rather than a raw UPDATE: recall is vector-first, so a
   * corrected title with an old embedding would still be found by the words
   * the user just removed.
   */
  updateMemory(
    id: string,
    patch: { title?: string; content?: string; kind?: MemoryKind; tags?: string[] },
  ): MemoryRecord | undefined {
    const existing = this.memoryById(id);
    if (!existing) return undefined;

    const title = patch.title ?? existing.title;
    const content = patch.content ?? existing.content;
    const kind = patch.kind ?? existing.kind;
    const tags = patch.tags ?? existing.tags;

    const textChanged = title !== existing.title || content !== existing.content;
    const vector = textChanged
      ? this.embedder.embed(`${kind} ${title}\n${content}`)
      : undefined;

    this.db
      .prepare(
        `UPDATE memories
            SET title = ?, content = ?, kind = ?, tags = ?
                ${vector ? ", vector = ?" : ""}
          WHERE id = ?`,
      )
      .run(
        ...[
          title,
          content,
          kind,
          JSON.stringify(tags),
          ...(vector ? [encodeVector(vector)] : []),
          id,
        ],
      );

    return this.memoryById(id);
  }

  /** Counts per kind, for the memory screen's summary. */
  memoryStats(): { total: number; pinned: number; byKind: Array<{ kind: string; count: number }> } {
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM memories`).get() as { c: number }).c;
    const pinned = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM memories WHERE pinned = 1`).get() as { c: number }
    ).c;
    const byKind = this.db
      .prepare(
        `SELECT kind, COUNT(*) AS count FROM memories GROUP BY kind ORDER BY count DESC`,
      )
      .all() as Array<{ kind: string; count: number }>;
    return { total, pinned, byKind };
  }

  /** People/places/projects Xana has seen repeatedly — feeds proactive nudges. */
  recurringEntities(minCount = 2, kinds: MemoryKind[] = ["person", "place", "project"]): Array<{ entity: string; kind: string; count: number; lastSeen: string }> {
    const rows = this.db
      .prepare(
        `SELECT kind, title, content, entities, created_at FROM memories
         WHERE superseded_by IS NULL AND kind IN (${kinds.map(() => "?").join(",")})`,
      )
      .all(...kinds) as Row[];

    const map = new Map<string, { entity: string; kind: string; count: number; lastSeen: string }>();
    for (const row of rows) {
      const kind = String(row.kind);
      const names = new Set<string>([
        ...(JSON.parse(String(row.entities ?? "[]")) as string[]),
        String(row.title),
      ]);
      for (const name of names) {
        const key = name.toLowerCase();
        const prev = map.get(key);
        if (prev) {
          prev.count++;
          if (String(row.created_at) > prev.lastSeen) prev.lastSeen = String(row.created_at);
        } else {
          map.set(key, { entity: name, kind, count: 1, lastSeen: String(row.created_at) });
        }
      }
    }
    return [...map.values()].filter((e) => e.count >= minCount).sort((a, b) => b.count - a.count);
  }

  /* ---------------- tasks ---------------- */

  createTask(input: Partial<Task> & { title: string }): Task {
    const task: Task = {
      id: uid("task"),
      title: input.title,
      status: input.status ?? "open",
      due: input.due,
      project: input.project,
      people: input.people ?? [],
      priority: input.priority ?? 3,
      estimateMinutes: input.estimateMinutes,
      energy: input.energy,
      tags: input.tags ?? [],
      source: input.source ?? "local",
      createdAt: input.createdAt ?? nowIso(),
      completedAt: input.completedAt,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, status, due, project, people, priority, estimate_minutes,
           energy, tags, source, created_at, completed_at)
         VALUES (@id, @title, @status, @due, @project, @people, @priority, @estimateMinutes,
           @energy, @tags, @source, @createdAt, @completedAt)`,
      )
      .run({
        id: task.id,
        title: task.title,
        status: task.status,
        due: task.due ?? null,
        project: task.project ?? null,
        people: JSON.stringify(task.people),
        priority: task.priority,
        estimateMinutes: task.estimateMinutes ?? null,
        energy: task.energy ?? null,
        tags: JSON.stringify(task.tags),
        source: task.source,
        createdAt: task.createdAt,
        completedAt: task.completedAt ?? null,
      });
    return task;
  }

  listTasks(filter: { status?: TaskStatus[]; limit?: number } = {}): Task[] {
    const statuses = filter.status ?? ["open", "doing"];
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE status IN (${statuses.map(() => "?").join(",")})
         ORDER BY priority ASC, (due IS NULL), due ASC, created_at DESC
         LIMIT ?`,
      )
      .all(...statuses, filter.limit ?? 200) as Row[];
    return rows.map(rowToTask);
  }

  taskById(id: string): Task | undefined {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToTask(row) : undefined;
  }

  /**
   * Change a task's own fields — anything except its status.
   *
   * Status has its own method because it carries a side effect: completing a task
   * stamps `completed_at`, and that timestamp is what the "what did I finish"
   * briefing reads. Folding that in here would mean every title edit had to
   * decide what to do about a completion date it has no business touching.
   *
   * `due` is the field this exists for. The distinguishing rule is that
   * `undefined` means "leave it alone" and `null` means "remove the date", and
   * the two are not interchangeable: a reschedule that cleared the deadline
   * instead of skipping it would silently drop a commitment, and a caller
   * patching only the title must not do that either.
   */
  updateTask(
    id: string,
    patch: {
      title?: string;
      due?: string | null;
      project?: string | null;
      priority?: Task["priority"];
      estimateMinutes?: number | null;
      energy?: Task["energy"] | null;
      tags?: string[];
    },
  ): Task | undefined {
    const existing = this.taskById(id);
    if (!existing) return undefined;

    const next: Task = {
      ...existing,
      title: patch.title ?? existing.title,
      // `in`-style semantics: only an explicit `null` clears a date, and only an
      // explicit value sets one.
      due: patch.due === undefined ? existing.due : (patch.due ?? undefined),
      project: patch.project === undefined ? existing.project : (patch.project ?? undefined),
      priority: patch.priority ?? existing.priority,
      estimateMinutes:
        patch.estimateMinutes === undefined ? existing.estimateMinutes : (patch.estimateMinutes ?? undefined),
      energy: patch.energy === undefined ? existing.energy : (patch.energy ?? undefined),
      tags: patch.tags ?? existing.tags,
    };

    this.db
      .prepare(
        `UPDATE tasks
            SET title = @title, due = @due, project = @project, priority = @priority,
                estimate_minutes = @estimateMinutes, energy = @energy, tags = @tags
          WHERE id = @id`,
      )
      .run({
        id,
        title: next.title,
        due: next.due ?? null,
        project: next.project ?? null,
        priority: next.priority,
        estimateMinutes: next.estimateMinutes ?? null,
        energy: next.energy ?? null,
        tags: JSON.stringify(next.tags),
      });

    return this.taskById(id);
  }

  updateTaskStatus(id: string, status: TaskStatus): Task | undefined {
    this.db
      .prepare(`UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?`)
      .run(status, status === "done" ? nowIso() : null, id);
    return this.taskById(id);
  }

  /**
   * Remove a task.
   *
   * Distinct from setting the status to `dropped`, which already exists and
   * means "I decided not to". This is for something typed by mistake or no
   * longer real, where keeping a record of it would be a record of a typo.
   *
   * It goes to the bin, which is what makes asking for this by voice safe: "is
   * that everything?" is a question people answer wrong, and a deletion that
   * cannot be undone turns a misheard sentence into lost work.
   */
  deleteTask(id: string): boolean {
    return this.moveToTrash("task", id);
  }

  /**
   * The whole open list, in one move.
   *
   * For "remove everything" and "clear the list", which is what people say when
   * a list has stopped being a plan and become a reproach. Every row is trashed
   * individually rather than by a `DELETE ... WHERE`, so the bin holds each one
   * separately and they can be restored one at a time.
   */
  deleteTasks(ids: readonly string[]): string[] {
    const gone: string[] = [];
    for (const id of ids) {
      if (this.moveToTrash("task", id)) gone.push(id);
    }
    return gone;
  }

  tasksCompletedSince(iso: string): Task[] {
    return (
      this.db
        .prepare(`SELECT * FROM tasks WHERE status = 'done' AND completed_at >= ? ORDER BY completed_at DESC`)
        .all(iso) as Row[]
    ).map(rowToTask);
  }

  /* ---------------- events ---------------- */

  createEvent(input: Partial<CalendarEvent> & { title: string; start: string; end: string }): CalendarEvent {
    const ev: CalendarEvent = {
      id: uid("evt"),
      title: input.title,
      start: input.start,
      end: input.end,
      location: input.location,
      attendees: input.attendees ?? [],
      source: input.source ?? "local",
      xanaAuthored: input.xanaAuthored ?? true,
      allDay: input.allDay ?? false,
    };
    this.db
      .prepare(
        `INSERT INTO events (id, title, start, end, location, attendees, source, xana_authored, all_day)
         VALUES (@id, @title, @start, @end, @location, @attendees, @source, @xanaAuthored, @allDay)`,
      )
      .run({
        id: ev.id,
        title: ev.title,
        start: ev.start,
        end: ev.end,
        location: ev.location ?? null,
        attendees: JSON.stringify(ev.attendees),
        source: ev.source,
        xanaAuthored: ev.xanaAuthored ? 1 : 0,
        allDay: ev.allDay ? 1 : 0,
      });
    return ev;
  }

  /**
   * Remove an event.
   *
   * Needed because the schedule can now be written by hand, and anything a
   * person types by hand they must be able to un-type. A calendar entry with
   * no way to delete it is worse than no calendar: it sits in the briefing
   * forever telling them about a class that moved.
   *
   * Removed entries go to the bin, so "cancel the thing at four" said about the
   * wrong thing costs a restore rather than an apology.
   */
  deleteEvent(id: string): boolean {
    return this.moveToTrash("event", id);
  }

  eventsBetween(fromIso: string, toIso: string): CalendarEvent[] {    return (      this.db
        .prepare(`SELECT * FROM events WHERE start < ? AND end > ? ORDER BY start ASC`)
        .all(toIso, fromIso) as Row[]
    ).map(rowToEvent);
  }

  /**
   * One event by id.
   *
   * Added for removal: cancelling an event has to say *which* one it cancelled,
   * and "the thing at four" is only reassuring if the reply names it back.
   */
  eventById(id: string): CalendarEvent | undefined {
    const row = this.db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToEvent(row) : undefined;
  }

  /* ---------------- goals ---------------- */

  /**
   * Create a goal. Milestones are given as drafts: `id` and `goalId` are
   * assigned here, so callers never have to invent them.
   */
  createGoal(
    input: Omit<Partial<Goal>, "milestones"> & {
      title: string;
      horizon: Goal["horizon"];
      milestones?: Array<Partial<Milestone> & { title: string }>;
    },
  ): Goal {
    const goal: Goal = {
      id: uid("goal"),
      title: input.title,
      why: input.why,
      horizon: input.horizon,
      status: input.status ?? "active",
      createdAt: input.createdAt ?? nowIso(),
      targetDate: input.targetDate,
      progressOverride: input.progressOverride,
      area: input.area,
      cadence: input.cadence,
      // Appended to the end of the board. Without this every new goal would
      // have a NULL order and sort below the ones already placed, so a goal
      // added from the cave would appear at the bottom of a column the user
      // just added it to the top of.
      sortOrder: input.sortOrder ?? this.nextGoalOrder(),
      milestones: [],
    };
    this.db
      .prepare(
        `INSERT INTO goals (id, title, why, horizon, status, created_at, target_date, progress_override, area, cadence, sort_order)
         VALUES (@id, @title, @why, @horizon, @status, @createdAt, @targetDate, @progressOverride, @area, @cadence, @sortOrder)`,
      )
      .run({
        id: goal.id,
        title: goal.title,
        why: goal.why ?? null,
        horizon: goal.horizon,
        status: goal.status,
        createdAt: goal.createdAt,
        targetDate: goal.targetDate ?? null,
        progressOverride: goal.progressOverride ?? null,
        area: goal.area ?? null,
        cadence: goal.cadence ?? null,
        sortOrder: goal.sortOrder ?? null,
      });
    // Milestones are inserted from the caller's drafts — `input.milestones`,
    // not `goal.milestones`, which is the (empty) hydrated list.
    for (const draft of input.milestones ?? []) {
      goal.milestones.push(this.createMilestone(goal.id, draft));
    }
    return goal;
  }

  createMilestone(goalId: string, input: Partial<Milestone> & { title: string }): Milestone {
    const m: Milestone = {
      id: input.id ?? uid("ms"),
      goalId,
      title: input.title,
      done: input.done ?? false,
      due: input.due,
      completedAt: input.completedAt,
    };
    this.db
      .prepare(
        `INSERT INTO milestones (id, goal_id, title, done, due, completed_at)
         VALUES (@id, @goalId, @title, @done, @due, @completedAt)`,
      )
      .run({
        id: m.id,
        goalId: m.goalId,
        title: m.title,
        done: m.done ? 1 : 0,
        due: m.due ?? null,
        completedAt: m.completedAt ?? null,
      });
    return m;
  }

  completeMilestone(id: string): Milestone | undefined {
    this.db.prepare(`UPDATE milestones SET done = 1, completed_at = ? WHERE id = ?`).run(nowIso(), id);
    const row = this.db.prepare(`SELECT * FROM milestones WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToMilestone(row) : undefined;
  }

  listGoals(status: Goal["status"][] = ["active"]): Goal[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM goals WHERE status IN (${status.map(() => "?").join(",")}) ORDER BY created_at ASC`,
      )
      .all(...status) as Row[];
    return rows.map((r) => this.hydrateGoal(r));
  }

  private hydrateGoal(row: Row): Goal {
    const ms = this.db
      .prepare(`SELECT * FROM milestones WHERE goal_id = ? ORDER BY (due IS NULL), due ASC, rowid ASC`)
      .all(String(row.id)) as Row[];
    return { ...rowToGoal(row), milestones: ms.map(rowToMilestone) };
  }

  milestoneById(id: string): Milestone | undefined {
    const row = this.db.prepare(`SELECT * FROM milestones WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToMilestone(row) : undefined;
  }

  goalById(id: string): Goal | undefined {
    const row = this.db.prepare(`SELECT * FROM goals WHERE id = ?`).get(id) as Row | undefined;
    return row ? this.hydrateGoal(row) : undefined;
  }

  /* ------------------------------------------------------------------ */
  /* Goal mutation                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Edit a goal in place.
   *
   * `undefined` means "leave this field alone", which is what makes a
   * partial update safe: dragging a card sends only `status` and
   * `sortOrder`, and must not blank the target date or the reason the goal
   * exists. Clearing a field is therefore explicit — an empty string for
   * text, or `null` for the nullable ones.
   *
   * This distinction has already caused one bug in this codebase (a partial
   * settings save that wiped a key), so it is enforced here rather than
   * left to each caller.
   */
  updateGoal(
    id: string,
    patch: {
      title?: string;
      why?: string | null;
      horizon?: Goal["horizon"];
      status?: Goal["status"];
      targetDate?: string | null;
      progressOverride?: number | null;
      area?: string | null;
      cadence?: string | null;
      sortOrder?: number;
      lastTouchedAt?: string;
    },
  ): Goal | undefined {
    const columns: Record<keyof typeof patch, string> = {
      title: "title",
      why: "why",
      horizon: "horizon",
      status: "status",
      targetDate: "target_date",
      progressOverride: "progress_override",
      area: "area",
      cadence: "cadence",
      sortOrder: "sort_order",
      lastTouchedAt: "last_touched_at",
    };

    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(columns)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value === null ? null : value);
    }

    if (sets.length > 0) {
      this.db.prepare(`UPDATE goals SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    }
    return this.goalById(id);
  }

  /**
   * Remove a goal and its milestones.
   *
   * The milestones carry `ON DELETE CASCADE`, but `foreign_keys` has to be
   * on for that to fire, so the count is deleted explicitly as well rather
   * than trusting a pragma that could be off.
   *
   * Both go to the bin, and the milestones go FIRST: the cascade would take
   * them the moment the goal row goes, and a cascade does not stop at the
   * trash. Restoring the goal brings its milestones back with it — see
   * `restoreFromTrash`.
   */
  deleteGoal(id: string): boolean {
    const tx = this.db.transaction((goalId: string) => {
      const milestones = this.db
        .prepare(`SELECT id FROM milestones WHERE goal_id = ?`)
        .all(goalId) as Array<{ id: string }>;
      for (const milestone of milestones) this.moveToTrash("milestone", milestone.id);
      return this.moveToTrash("goal", goalId);
    });
    return tx(id);
  }

  /** Every goal, in board order. Used by My cave, which shows all columns. */
  allGoals(): Goal[] {
    const rows = this.db
      .prepare(
        // Goals created before `sort_order` existed have NULL there; they go
        // last, ordered by creation date, so a new column never reshuffles
        // an existing board.
        `SELECT * FROM goals ORDER BY (sort_order IS NULL), sort_order ASC, created_at ASC`,
      )
      .all() as Row[];
    return rows.map((r) => this.hydrateGoal(r));
  }

  /**
   * Place a goal between two others.
   *
   * The caller passes the orders of the neighbours it dropped between; the
   * midpoint becomes the new order. `null` on either side means "the end of
   * that direction", which is how a card reaches the top or the bottom
   * without renumbering anything.
   *
   * Returning the updated goal rather than a boolean lets the caller
   * reconcile its optimistic reordering against what was actually stored.
   */
  reorderGoal(
    id: string,
    before: number | null,
    after: number | null,
  ): Goal | undefined {
    const goal = this.goalById(id);
    if (!goal) return undefined;

    let order: number;
    if (before === null && after === null) {
      order = 0;
    } else if (before === null) {
      // Dropped at the very top.
      order = (after as number) - 1;
    } else if (after === null) {
      // Dropped at the very bottom.
      order = before + 1;
    } else {
      order = (before + after) / 2;
    }

    return this.updateGoal(id, { sortOrder: order });
  }

  /** Append a new goal to the end of its column. */
  nextGoalOrder(): number {
    const row = this.db.prepare(`SELECT MAX(sort_order) AS m FROM goals`).get() as
      | { m: number | null }
      | undefined;
    const max = row?.m == null ? 0 : Number(row.m);
    // Spread rather than +1, so repeated appends stay ordered even after
    // several midpoint insertions have packed the region between integers.
    return max + 1024;
  }

  /**
   * Give every goal an explicit board position, once.
   *
   * Goals written before the column existed have a NULL order. They still
   * display, sorted by creation date, which looks correct — right up until a
   * new goal is added. The new goal gets a real number, and every NULL sorts
   * *after* a number, so a goal the user just typed appears below three
   * others at the bottom of the column.
   *
   * Backfilling on boot removes that: existing goals keep their current
   * visual order (creation date, which is what they were already being
   * sorted by) and now have numbers, so anything added later lands where it
   * should. Deliberately not done in the column-normalisation pass, because
   * that one has to run at most once per column and this must run once ever.
   */
  private backfillGoalOrder(): void {
    try {
      const unplaced = this.db
        .prepare(`SELECT id FROM goals WHERE sort_order IS NULL ORDER BY created_at ASC`)
        .all() as Array<{ id: string }>;
      if (unplaced.length === 0) return;

      const update = this.db.prepare(`UPDATE goals SET sort_order = ? WHERE id = ?`);
      const tx = this.db.transaction((rows: Array<{ id: string }>) => {
        rows.forEach((row, index) => update.run((index + 1) * 1024, row.id));
      });
      tx(unplaced);
    } catch {
      // A board that cannot be backfilled still displays, ordered by creation
      // date. Not worth refusing to start over.
    }
  }

  /**
   * Un-complete a milestone. Needed because the cave allows toggling, and a
   * toggle that only goes one way is a trap: an accidental click on the
   * wrong row would otherwise be unfixable without deleting the milestone.
   */
  reopenMilestone(id: string): Milestone | undefined {
    this.db
      .prepare(`UPDATE milestones SET done = 0, completed_at = NULL WHERE id = ?`)
      .run(id);
    return this.milestoneById(id);
  }

  updateMilestone(
    id: string,
    patch: { title?: string; due?: string | null },
  ): Milestone | undefined {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.title !== undefined) {
      sets.push("title = ?");
      values.push(patch.title);
    }
    if (patch.due !== undefined) {
      sets.push("due = ?");
      values.push(patch.due);
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE milestones SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    }
    return this.milestoneById(id);
  }

  deleteMilestone(id: string): boolean {
    return this.moveToTrash("milestone", id);
  }

  /** Milestone completions in a window — used by reflections and patterns. */
  milestoneCompletionsBetween(fromIso: string, toIso: string): Array<{ goalId: string; title: string; completedAt: string }> {
    return (
      this.db
        .prepare(
          `SELECT goal_id, title, completed_at FROM milestones
           WHERE done = 1 AND completed_at >= ? AND completed_at < ?`,
        )
        .all(fromIso, toIso) as Row[]
    ).map((r) => ({ goalId: String(r.goal_id), title: String(r.title), completedAt: String(r.completed_at) }));
  }

  /* ---------------- habits ---------------- */

  createHabit(input: Partial<Habit> & { name: string }): Habit {
    const habit: Habit = {
      id: uid("habit"),
      name: input.name,
      targetPerWeek: input.targetPerWeek ?? 5,
      completions: input.completions ?? [],
      streak: 0,
      longestStreak: 0,
      unit: input.unit,
      cadenceHint: input.cadenceHint,
    };
    this.db
      .prepare(`INSERT INTO habits (id, name, target_per_week, unit, cadence_hint) VALUES (?, ?, ?, ?, ?)`)
      .run(habit.id, habit.name, habit.targetPerWeek, habit.unit ?? null, habit.cadenceHint ?? null);
    for (const day of habit.completions) this.logHabit(habit.id, day);
    return this.habitById(habit.id)!;
  }

  logHabit(habitId: string, day = toDateKey()): Habit | undefined {
    this.db.prepare(`INSERT OR IGNORE INTO habit_log (habit_id, day) VALUES (?, ?)`).run(habitId, day);
    return this.habitById(habitId);
  }

  habitById(id: string): Habit | undefined {
    const row = this.db.prepare(`SELECT * FROM habits WHERE id = ?`).get(id) as Row | undefined;
    if (!row) return undefined;
    const days = (
      this.db.prepare(`SELECT day FROM habit_log WHERE habit_id = ? ORDER BY day ASC`).all(id) as Row[]
    ).map((r) => String(r.day));
    return { ...rowToHabit(row), completions: days, ...computeStreaks(days) };
  }

  listHabits(): Habit[] {
    return (this.db.prepare(`SELECT id FROM habits ORDER BY rowid ASC`).all() as Row[]).map(
      (r) => this.habitById(String(r.id))!,
    );
  }

  habitLogBetween(fromDay: string, toDay: string): Array<{ habitId: string; day: string }> {
    return (
      this.db
        .prepare(`SELECT habit_id, day FROM habit_log WHERE day >= ? AND day <= ? ORDER BY day ASC`)
        .all(fromDay, toDay) as Row[]
    ).map((r) => ({ habitId: String(r.habit_id), day: String(r.day) }));
  }

  /* ---------------- notes ---------------- */

  createNote(input: { title: string; body: string; tags?: string[]; source?: string }): Note {
    const note: Note = {
      id: uid("note"),
      title: input.title,
      body: input.body,
      source: input.source ?? "local",
      tags: input.tags ?? [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO notes (id, title, body, source, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(note.id, note.title, note.body, note.source, JSON.stringify(note.tags), note.createdAt, note.updatedAt);
    return note;
  }

  listNotes(limit = 50): Note[] {
    return (
      this.db.prepare(`SELECT * FROM notes ORDER BY updated_at DESC LIMIT ?`).all(limit) as Row[]
    ).map(rowToNote);
  }

  /**
   * Remove a note.
   *
   * Notes could be written and never unwritten, which made them the one thing
   * in the app that only ever grew. Into the bin like everything else: a note
   * deleted by a misheard word is recoverable for a week.
   */
  deleteNote(id: string): boolean {
    return this.moveToTrash("note", id);
  }

  /* ---------------- reflections ---------------- */

  saveReflection(input: Omit<Reflection, "id" | "createdAt">): Reflection {
    const r: Reflection = { ...input, id: uid("refl"), createdAt: nowIso() };
    this.db
      .prepare(
        `INSERT INTO reflections (id, period, period_start, period_end, body, highlights, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.period, r.periodStart, r.periodEnd, r.body, JSON.stringify(r.highlights), r.createdAt);
    return r;
  }

  listReflections(limit = 20): Reflection[] {
    return (
      this.db.prepare(`SELECT * FROM reflections ORDER BY created_at DESC LIMIT ?`).all(limit) as Row[]
    ).map(rowToReflection);
  }

  latestReflection(period?: string): Reflection | undefined {
    const row = period
      ? (this.db
          .prepare(`SELECT * FROM reflections WHERE period = ? ORDER BY created_at DESC LIMIT 1`)
          .get(period) as Row | undefined)
      : (this.db.prepare(`SELECT * FROM reflections ORDER BY created_at DESC LIMIT 1`).get() as Row | undefined);
    return row ? rowToReflection(row) : undefined;
  }

  /* ---------------- focus ---------------- */

  startFocus(label: string, minutes: number, media?: string): FocusSession {
    const s: FocusSession = {
      id: uid("focus"),
      label,
      startedAt: nowIso(),
      minutes,
      media,
      completed: false,
    };
    this.db
      .prepare(
        `INSERT INTO focus_sessions (id, label, started_at, minutes, media, completed)
         VALUES (?, ?, ?, ?, ?, 0)`,
      )
      .run(s.id, s.label, s.startedAt, s.minutes, s.media ?? null);
    return s;
  }

  completeFocus(id: string): FocusSession | undefined {
    this.db.prepare(`UPDATE focus_sessions SET completed = 1 WHERE id = ?`).run(id);
    const row = this.db.prepare(`SELECT * FROM focus_sessions WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToFocus(row) : undefined;
  }

  focusBetween(fromIso: string, toIso: string): FocusSession[] {
    return (
      this.db
        .prepare(`SELECT * FROM focus_sessions WHERE started_at >= ? AND started_at < ? ORDER BY started_at DESC`)
        .all(fromIso, toIso) as Row[]
    ).map(rowToFocus);
  }

  /* ---------------- health ---------------- */

  /** Upsert one day. Re-importing an overlapping export overwrites, never duplicates. */
  upsertHealth(sample: HealthSample): HealthSample {
    const s: HealthSample = { ...sample, source: sample.source || "local" };
    this.db
      .prepare(
        `INSERT INTO health_samples (day, sleep_hours, sleep_quality, steps, active_minutes, resting_heart_rate, mood, energy, energy_at, meals, source)
         VALUES (@day, @sleepHours, @sleepQuality, @steps, @activeMinutes, @restingHeartRate, @mood, @energy, @energyAt, @meals, @source)
         ON CONFLICT(day) DO UPDATE SET
           sleep_hours = COALESCE(excluded.sleep_hours, health_samples.sleep_hours),
           sleep_quality = COALESCE(excluded.sleep_quality, health_samples.sleep_quality),
           steps = COALESCE(excluded.steps, health_samples.steps),
           active_minutes = COALESCE(excluded.active_minutes, health_samples.active_minutes),
           resting_heart_rate = COALESCE(excluded.resting_heart_rate, health_samples.resting_heart_rate),
           mood = COALESCE(excluded.mood, health_samples.mood),
           -- The newest reading wins. A day holds two, and the card shows the
           -- current one; keeping the morning figure here would mean showing a
           -- number the user has already replaced.
           energy = COALESCE(excluded.energy, health_samples.energy),
           energy_at = CASE
             WHEN excluded.energy IS NULL THEN health_samples.energy_at
             ELSE excluded.energy_at
           END,
           meals = COALESCE(excluded.meals, health_samples.meals),
           source = excluded.source`,
      )
      .run({
        day: s.date,
        sleepHours: s.sleepHours ?? null,
        sleepQuality: s.sleepQuality ?? null,
        steps: s.steps ?? null,
        activeMinutes: s.activeMinutes ?? null,
        restingHeartRate: s.restingHeartRate ?? null,
        mood: s.mood ?? null,
        energy: s.energy ?? null,
        energyAt: s.energyAt ?? null,
        meals: s.meals ?? null,
        source: s.source,
      });
    return s;
  }

  /** Most recent `limit` days, oldest first — the shape trend maths wants. */
  healthSamples(limit = 30): HealthSample[] {
    return (
      this.db
        .prepare(`SELECT * FROM health_samples ORDER BY day DESC LIMIT ?`)
        .all(limit) as Row[]
    )
      .map(rowToHealth)
      .reverse();
  }

  /**
   * The newest health row's day and where it came from.
   *
   * One cheap question, asked by the device half of the health plugin: *has
   * anything a phone sent ever actually arrived?* The panel cannot answer it from
   * `healthSamples()`, which returns 30 days and no provenance summary, and it
   * must not guess — "no readings from your phone yet" printed over a table full
   * of them is exactly the kind of lie this exists to prevent.
   *
   * Ordered by day, not by insertion time: days are the table's key and its
   * ordering, so the newest row is the newest *day*, which is what the panel is
   * talking about. A hand-logged energy reading for today would outrank a phone
   * post for yesterday, and correctly so.
   */
  lastHealthSource(): { day: string; source: string } | undefined {
    const row = this.db
      .prepare(`SELECT day, source FROM health_samples ORDER BY day DESC LIMIT 1`)
      .get() as Row | undefined;
    if (!row) return undefined;
    return { day: String(row.day), source: String(row.source) };
  }

  /* ---------------- conversation ---------------- */

  logMessage(role: string, text: string, sessionId?: string, meta?: unknown): void {
    this.db
      .prepare(
        `INSERT INTO conversation (id, session_id, role, text, created_at, meta) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(uid("msg"), sessionId ?? null, role, text, nowIso(), meta ? JSON.stringify(meta) : null);
  }

  recentConversation(limit = 12): Array<{ role: string; text: string; createdAt: string }> {
    return (
      this.db
        .prepare(`SELECT role, text, created_at FROM conversation ORDER BY created_at DESC LIMIT ?`)
        .all(limit) as Row[]
    )
      .map((r) => ({ role: String(r.role), text: String(r.text), createdAt: String(r.created_at) }))
      .reverse();
  }

  counts(): Record<string, number> {
    const tables = ["memories", "tasks", "events", "goals", "milestones", "habits", "habit_log", "notes", "reflections", "focus_sessions", "health_samples", "conversation"];
    const out: Record<string, number> = {};
    for (const t of tables) {
      out[t] = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as Row).n);
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Row mappers                                                         */
/* ------------------------------------------------------------------ */

/**
 * `unknown` into a sentence, without reaching for the adapter layer.
 *
 * `lib/adapters/types.ts` exports an `errorMessage` that does the same thing,
 * and importing it here would close a cycle: the adapters import the settings
 * layer, which imports this file. Three lines is cheaper than a cycle, and the
 * different name is deliberate — a reader looking for `errorMessage` should not
 * find a second body and wonder which one is current.
 */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function j<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

function rowToMemory(row: Row): MemoryRecord {
  return {
    id: String(row.id),
    kind: String(row.kind) as MemoryKind,
    title: String(row.title),
    content: String(row.content),
    entities: j<string[]>(row.entities, []),
    tags: j<string[]>(row.tags, []),
    salience: Number(row.salience),
    source: String(row.source),
    sessionId: row.session_id ? String(row.session_id) : undefined,
    createdAt: String(row.created_at),
    lastAccessedAt: row.last_accessed_at ? String(row.last_accessed_at) : undefined,
    accessCount: Number(row.access_count),
    supersededBy: row.superseded_by ? String(row.superseded_by) : undefined,
    // SQLite stores the flag as 0/1; the domain type is a boolean, and
    // leaking the integer would make `if (record.pinned)` work while
    // `record.pinned === true` silently failed.
    pinned: Number(row.pinned ?? 0) === 1 ? true : undefined,
  };
}

function rowToTask(row: Row): Task {
  return {
    id: String(row.id),
    title: String(row.title),
    status: String(row.status) as TaskStatus,
    due: row.due ? String(row.due) : undefined,
    project: row.project ? String(row.project) : undefined,
    people: j<string[]>(row.people, []),
    priority: Number(row.priority) as Task["priority"],
    estimateMinutes: row.estimate_minutes == null ? undefined : Number(row.estimate_minutes),
    energy: row.energy ? (String(row.energy) as Task["energy"]) : undefined,
    tags: j<string[]>(row.tags, []),
    source: String(row.source),
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
  };
}

function rowToEvent(row: Row): CalendarEvent {
  return {
    id: String(row.id),
    title: String(row.title),
    start: String(row.start),
    end: String(row.end),
    location: row.location ? String(row.location) : undefined,
    attendees: j<string[]>(row.attendees, []),
    source: String(row.source),
    xanaAuthored: Number(row.xana_authored) === 1,
    allDay: Number(row.all_day) === 1,
  };
}

function rowToGoal(row: Row): Goal {
  return {
    id: String(row.id),
    title: String(row.title),
    why: row.why ? String(row.why) : undefined,
    horizon: String(row.horizon) as Goal["horizon"],
    status: String(row.status) as Goal["status"],
    createdAt: String(row.created_at),
    targetDate: row.target_date ? String(row.target_date) : undefined,
    progressOverride: row.progress_override == null ? undefined : Number(row.progress_override),
    area: row.area ? String(row.area) : undefined,
    cadence: row.cadence ? String(row.cadence) : undefined,
    sortOrder: row.sort_order == null ? undefined : Number(row.sort_order),
    lastTouchedAt: row.last_touched_at ? String(row.last_touched_at) : undefined,
    milestones: [],
  };
}

function rowToMilestone(row: Row): Milestone {
  return {
    id: String(row.id),
    goalId: String(row.goal_id),
    title: String(row.title),
    done: Number(row.done) === 1,
    due: row.due ? String(row.due) : undefined,
    completedAt: row.completed_at ? String(row.completed_at) : undefined,
  };
}

function rowToHabit(row: Row): Habit {
  return {
    id: String(row.id),
    name: String(row.name),
    targetPerWeek: Number(row.target_per_week),
    completions: [],
    streak: 0,
    longestStreak: 0,
    unit: row.unit ? String(row.unit) : undefined,
    cadenceHint: row.cadence_hint ? String(row.cadence_hint) : undefined,
  };
}

function rowToNote(row: Row): Note {
  return {
    id: String(row.id),
    title: String(row.title),
    body: String(row.body),
    source: String(row.source),
    tags: j<string[]>(row.tags, []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function rowToReflection(row: Row): Reflection {
  return {
    id: String(row.id),
    period: String(row.period),
    periodStart: String(row.period_start),
    periodEnd: String(row.period_end),
    body: String(row.body),
    highlights: j<string[]>(row.highlights, []),
    createdAt: String(row.created_at),
  };
}

function rowToFocus(row: Row): FocusSession {
  return {
    id: String(row.id),
    label: String(row.label),
    startedAt: String(row.started_at),
    minutes: Number(row.minutes),
    media: row.media ? String(row.media) : undefined,
    completed: Number(row.completed) === 1,
  };
}

function rowToHealth(row: Row): HealthSample {
  return {
    date: String(row.day),
    sleepHours: row.sleep_hours == null ? undefined : Number(row.sleep_hours),
    sleepQuality: row.sleep_quality == null ? undefined : Number(row.sleep_quality),
    steps: row.steps == null ? undefined : Number(row.steps),
    activeMinutes: row.active_minutes == null ? undefined : Number(row.active_minutes),
    restingHeartRate: row.resting_heart_rate == null ? undefined : Number(row.resting_heart_rate),
    mood: row.mood ? (String(row.mood) as MoodLabel) : undefined,
    energy: row.energy == null ? undefined : Number(row.energy),
    energyAt: row.energy_at ? String(row.energy_at) : undefined,
    meals: row.meals == null ? undefined : Number(row.meals),
    source: row.source ? String(row.source) : "local",
  };
}

/* ------------------------------------------------------------------ */
/* Derived values                                                      */
/* ------------------------------------------------------------------ */

/**
 * Streak = consecutive days ending today (or yesterday if today is not yet
 * logged — a streak should not read as broken before the day is over).
 */
export function computeStreaks(days: string[]): { streak: number; longestStreak: number } {
  const set = new Set(days);
  const sorted = [...set].sort();
  if (sorted.length === 0) return { streak: 0, longestStreak: 0 };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(`${sorted[i - 1]}T00:00:00`);
    const cur = new Date(`${sorted[i]}T00:00:00`);
    const diff = Math.round((cur.getTime() - prev.getTime()) / 86_400_000);
    if (diff === 1) run++;
    else if (diff > 1) run = 1;
    if (run > longest) longest = run;
  }

  const today = toDateKey();
  const yesterday = toDateKey(new Date(Date.now() - 86_400_000));
  let cursor = set.has(today) ? today : set.has(yesterday) ? yesterday : null;
  if (!cursor) return { streak: 0, longestStreak: longest };

  let streak = 0;
  while (set.has(cursor)) {
    streak++;
    const d = new Date(`${cursor}T00:00:00`);
    d.setDate(d.getDate() - 1);
    cursor = toDateKey(d);
  }
  return { streak, longestStreak: Math.max(longest, streak) };
}

function describeRecall(sim: number, lex: number, mem: MemoryRecord): string {
  if (lex > 0.35) return "same wording";
  if (sim > 0.45) return "close in meaning";
  if (mem.kind === "preference") return "your stated preference";
  if (mem.kind === "decision") return "a decision you made";
  if (mem.kind === "person") return "someone recurring";
  if (mem.accessCount > 2) return "recalled before";
  return "related";
}

/* ------------------------------------------------------------------ */

/**
 * Where the database lives: `<project>/data/xana.db`, unless told otherwise.
 *
 * `XANA_DATA_DIR` moves it, and it has to be honoured *here* rather than only in
 * the settings layer. The two halves of Xana's own state are documented as one
 * directory — "delete them and she rebuilds from empty", "one place to look is
 * one place to back up" — and for a long time only the settings file obeyed the
 * variable. The database did not, which meant `XANA_DATA_DIR=/tmp/scratch` gave
 * you a scratch settings file and the user's real life: a script, a container or
 * a test that believed the README wrote into `data/xana.db` and nothing failed
 * loudly enough to say so.
 *
 * The project root is still resolved from this file's own location, so the path
 * is the same under `next dev`, `next start` and a TypeScript script run from
 * anywhere. Only the directory is overridable, and an empty value means
 * "unset" rather than "the current working directory".
 */
export function defaultDbPath(): string {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const projectRoot = path.resolve(here, "..", "..", "..");
  const override = process.env.XANA_DATA_DIR?.trim();
  return path.join(override && override.length > 0 ? override : path.join(projectRoot, "data"), "xana.db");
}

let singleton: XanaStore | undefined;

/** Process-wide store. Next.js hot-reloads modules; keep one connection. */
export function getStore(): XanaStore {
  if (!singleton) singleton = new XanaStore();
  return singleton;
}

/**
 * Checkpoint and close the process-wide store, if one was ever opened.
 *
 * The app never used to close its database. Nothing was wrong with that in the
 * sense that SQLite survives it — but the write-ahead log was then only folded
 * back by the *next* open, so a server that ran for days left a log larger than
 * the database it belonged to, and any copy of `xana.db` taken meanwhile was
 * missing most of the history. This is the function the server calls on
 * SIGINT/SIGTERM and on process exit.
 *
 * Returns false when no store was opened, so a caller can say honestly that
 * there was nothing to flush rather than printing a zero it did not measure.
 */
export function closeStore(): boolean {
  if (!singleton) return false;
  try {
    singleton.close();
  } catch {
    // Already closed, or closed under us. Nothing to do and nothing to report:
    // this runs on the way out of the process.
  }
  singleton = undefined;
  return true;
}

/**
 * Swap the process-wide store. Used by the seed and demo scripts to run against
 * a scratch database without touching the real one.
 */
export function setStore(store: XanaStore): void {
  singleton = store;
}

export type { GoalProgress };
