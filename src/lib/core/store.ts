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
import { mkdirSync } from "node:fs";
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
} from "./types";
import { cosine, lexicalOverlap, localEmbedder, type Embedder } from "./vector";
import { clamp, nowIso, recencyWeight, toDateKey, uid } from "./time";

type Row = Record<string, unknown>;

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
  private embedder: Embedder;

  constructor(filename?: string, embedder: Embedder = localEmbedder) {
    const file = filename ?? defaultDbPath();
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new BetterSqlite3(file);
    this.embedder = embedder;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 4000");
    this.migrate();
    this.addMissingColumns();
    this.backfillGoalOrder();
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
    `);
  }

  close(): void {
    this.db.close();
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
   * Forget a memory permanently.
   *
   * A hard delete rather than a `superseded_by` flag, and that is a
   * deliberate departure from how contradictions are handled elsewhere.
   * Superseding is for "this was true and then changed", where keeping the
   * history is useful. Forgetting is the user saying a thing should not be
   * known, and a soft delete would leave it in `allMemories`, in the vector
   * index, and reachable by a recall that happened to score it well.
   *
   * Returns whether anything was removed, so the caller can tell "forgotten"
   * from "there was nothing there".
   */
  forgetMemory(id: string): boolean {
    return this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id).changes > 0;
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

  updateTaskStatus(id: string, status: TaskStatus): Task | undefined {
    this.db
      .prepare(`UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?`)
      .run(status, status === "done" ? nowIso() : null, id);
    return this.taskById(id);
  }

  /**
   * Remove a task outright.
   *
   * Distinct from setting the status to `dropped`, which already exists and
   * means "I decided not to". This is for something typed by mistake or no
   * longer real, where keeping a record of it would be a record of a typo.
   */
  deleteTask(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
    return result.changes > 0;
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
   */
  deleteEvent(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM events WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  eventsBetween(fromIso: string, toIso: string): CalendarEvent[] {    return (
      this.db
        .prepare(`SELECT * FROM events WHERE start < ? AND end > ? ORDER BY start ASC`)
        .all(toIso, fromIso) as Row[]
    ).map(rowToEvent);
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
   */
  deleteGoal(id: string): boolean {
    const tx = this.db.transaction((goalId: string) => {
      this.db.prepare(`DELETE FROM milestones WHERE goal_id = ?`).run(goalId);
      const result = this.db.prepare(`DELETE FROM goals WHERE id = ?`).run(goalId);
      return result.changes > 0;
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
    return this.db.prepare(`DELETE FROM milestones WHERE id = ?`).run(id).changes > 0;
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

export function defaultDbPath(): string {
  // <project>/data/xana.db — resolved from this file's location so it works
  // identically under `next dev`, `next start` and tsx scripts.
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const projectRoot = path.resolve(here, "..", "..", "..");
  return path.join(projectRoot, "data", "xana.db");
}

let singleton: XanaStore | undefined;

/** Process-wide store. Next.js hot-reloads modules; keep one connection. */
export function getStore(): XanaStore {
  if (!singleton) singleton = new XanaStore();
  return singleton;
}

/**
 * Swap the process-wide store. Used by the seed and demo scripts to run against
 * a scratch database without touching the real one.
 */
export function setStore(store: XanaStore): void {
  singleton = store;
}

export type { GoalProgress };
