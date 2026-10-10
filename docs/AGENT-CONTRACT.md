# Agent loop — frozen implementation contract

**Status: FROZEN as of the Lead's build.** These are the exact names and shapes
being written to disk right now. `docs/UPGRADE-CONTRACTS.md` §3 says the same
thing at the design level; this file is the testable detail. If the
implementation ends up differing from anything here, **that is a defect** —
report it, do not adapt the test to it.

ASCII only in source. This file is documentation and may use typographic
punctuation; source files may not.

---

## 1. The seam for stubbing the model

`runAgentTurn()` calls `llmComplete()` **directly**. There is deliberately no
injectable model seam.

Stub at the network boundary instead, exactly as `scripts/check-analysis-live.ts`
already does: write `model.baseUrl` into the settings file pointing at a local
stub server (an `http.createServer` on `127.0.0.1`, port 0), set the key via
`model.apiKey`, and let the real `fetch` in `llmComplete` hit it. That is a
stronger test than an injected fake, because it exercises request building, the
tool-call plumbing and the response parser for real.

Force "no model configured" by writing `model.enabled = false` into the settings
file (and ensure no `DEEPSEEK_API_KEY` / `XANA_LLM_*` is present in the
environment). `llmAvailable()` returns `undefined === false` then.

```ts
export function llmAvailable(): boolean;   // src/lib/mind/llm.ts
```

---

## 2. `src/lib/mind/tools.ts`

```ts
export type ToolSafety = "read" | "write" | "destructive";

export interface ToolContext {
  lifeState: LifeState;
  sessionId: string;
  /**
   * Set when the proposal originated in content Xana did not write. Any WRITE
   * proposed while this is set is REFUSED in guard.ts. Fail-closed.
   */
  untrustedSource?: string;
}

export type ToolResult =
  | { ok: true; data: unknown; intent?: ActionIntent }
  | { ok: false; error: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;   // JSON Schema
  safety: ToolSafety;
  /** Argument keys whose values must resolve to a real record; never invented. */
  resolves?: Array<{ arg: string; kind: "task" | "event" | "goal" | "habit" }>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => ToolResult;
}

export const READ_TOOLS: ToolSpec[];
export const WRITE_TOOLS: ToolSpec[];
export const ALL_TOOLS: ToolSpec[];
export function findTool(name: string): ToolSpec | undefined;

/** Stable order — prompt caching depends on the tools array being byte-identical
 *  between calls, so this must never be built from a dynamic source. */
export function toolsJsonSchema(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}>;

/** Defensive. The provider warns arguments may be invalid JSON. Never throws. */
export function parseToolArguments(raw: string): { ok: true; args: Record<string, unknown> } | { ok: false; error: string };
```

### The exact write tool names and their `required` fields

For the malformed-arguments test, use **`create_task`** and omit its required
`title`.

| Tool | safety | `required` |
|---|---|---|
| `create_task` | write | `["title"]` |
| `complete_task` | write | `["task"]` |
| `update_task` | write | `["task"]` |
| `create_event` | write | `["title","start","end"]` |
| `create_reminder` | write | `["text","when"]` |
| `create_goal` | write | `["title"]` |
| `remember` | write | `["title","content"]` |
| `create_note` | write | `["title","body"]` |
| `log_health` | write | `[]` (refused if all fields absent) |
| `forget_memory` | destructive | `["memory"]` |
| `delete_task` | destructive | `["task"]` |

Read tools (safety `"read"`, never touch the database):
`get_tasks`, `get_calendar`, `get_goals`, `get_memory`, `get_energy`,
`get_habits`, `get_patterns`, `get_day`.

`resolves` is declared on every tool whose arguments name an existing record:

| Tool | `resolves` |
|---|---|
| `complete_task`, `update_task`, `delete_task` | `[{ arg: "task", kind: "task" }]` |
| `forget_memory` | `[{ arg: "memory", kind: "memory" as any }]` |
| `create_event` | `[]` (a new event is written, not resolved) |

**The model passes a NAME, never an id.** `complete_task` takes
`{"task": "review the Aurora deck"}`, not a uuid. Resolution happens server-side
against `lifeState`, and an unmatched name is a refusal. This matters because a
model that can supply an id can supply a *wrong* id, and a wrong id is a silent
edit to the wrong record.

---

## 3. `src/lib/mind/guard.ts`

```ts
export interface Proposal {
  tool: string;
  args: Record<string, unknown>;
}

export type Verdict =
  | { verdict: "allow"; intent: ActionIntent; spec: ToolSpec; toolCallId?: string }
  | { verdict: "confirm"; intent: ActionIntent; spec: ToolSpec; question: string; toolCallId?: string }
  | { verdict: "refuse"; reason: string; toolCallId?: string };

export function validateActionIntent(
  proposal: Proposal,
  ctx: { lifeState: LifeState; untrustedSource?: string; toolCallId?: string },
): Verdict;

/** The first token of a reply, as a confirmation gate reads it. */
export function isAffirmation(text: string): boolean;
export function isDenial(text: string): boolean;
```

Which verdict a proposal gets:

| Condition | Verdict |
|---|---|
| Unknown tool name | `refuse` — `"no tool named X"` |
| `ctx.untrustedSource` set and `spec.safety !== "read"` | `refuse` — the fail-closed rule |
| Missing a `required` field | `refuse` |
| A `resolves` argument that matches nothing in `lifeState` | `refuse` |
| `spec.safety === "destructive"` | `confirm` with a `question` |
| Everything else | `allow` |

**Nothing in this table depends on the model's cooperation.** `validateActionIntent`
never throws: a thrown validator is a validator the caller has to wrap, and the
refusal reasons are the entire value of the function.

---

## 4. `src/lib/mind/agent.ts`

```ts
export interface AgentTurnInput {
  text: string;
  lifeState: LifeState;
  sessionId: string;
  modality?: "text" | "voice";
}

export interface AgentToolCallRecord {
  name: string;
  ok: boolean;
  effect?: string;
  /** Present on a refusal, so a test can name the reason. */
  reason?: string;
}

export interface AgentTurnResult {
  text: string;
  cards?: Card[];
  outcome?: ActionOutcome;
  toolCalls: AgentToolCallRecord[];
  engine: "agent" | "local";
}

/** Never throws. Called only when the local engine matched nothing AND a model
 *  is configured. Caps at MAX_TOOL_ROUNDS (4) round trips. */
export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
```

`runAgentTurn` **never throws** and **never writes outside `executeAction`**. Its
guarantees, in order:

1. Every write goes through `executeAction` with
   `{ sessionId, source: "model", idempotencyKey, tool }`.
2. The idempotency key is `sha1(sessionId + turnId + toolCallId)` — stable for a
   given tool call, so a retried round trip cannot double-write.
3. At most `MAX_TOOL_ROUNDS = 4` model round trips per turn.
4. A refusal is fed back to the model as a `role: "tool"` message with
   `ok: false` and the reason, so it can correct itself and then tell the truth.
5. If the model never produces text, the result's `text` is the local engine's
   honest sentence, not an empty string.

---

## 5. `src/lib/core/store.ts`

Table (created in `migrate()`, `CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE IF NOT EXISTS action_log (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  source TEXT NOT NULL,              -- 'local' | 'model' | 'system'
  tool TEXT NOT NULL,
  intent TEXT NOT NULL DEFAULT '{}', -- JSON
  ok INTEGER NOT NULL DEFAULT 0,
  effect TEXT NOT NULL DEFAULT '',
  detail TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_log_created ON action_log(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_action_log_idem
  ON action_log(idempotency_key) WHERE idempotency_key IS NOT NULL;
```

Methods:

```ts
logAction(entry: {
  sessionId?: string; source: "local" | "model" | "system";
  tool: string; intent: unknown; ok: boolean; effect: string;
  detail?: string; idempotencyKey?: string;
}): void;

/** True when a SUCCESSFUL write already used this key. A failed attempt does not
 *  consume the key, so a corrected retry still lands. */
seenIdempotencyKey(key: string): boolean;

recentActions(limit?: number): Array<{
  tool: string; effect: string; ok: boolean; createdAt: string; detail?: string;
}>;
```

**Atomicity.** `logAction` is called from inside `executeAction`'s wrapper, which
runs the whole effect plus the audit row inside one `db.transaction()`. Because
`better-sqlite3` nests transactions as SAVEPOINTs, the handlers that already open
their own transaction keep working, and a handler that throws rolls back both the
effect and the row. So "the row exists" and "the effect happened" cannot disagree.

**Who suppresses the duplicate write:** `executeAction`. It calls
`seenIdempotencyKey(key)` before dispatching and returns early with
`{ ok: true, effect: "action.duplicate", message: "" }` when the key is spent.
It does not consult `action_log` from inside the handler.

---

## 6. `src/lib/actions/executor.ts`

```ts
export interface ExecuteOptions {
  sessionId?: string;
  store?: XanaStore;
  noInvalidate?: boolean;
  /** Who asked. Defaults to "local"; the agent loop passes "model". */
  source?: "local" | "model" | "system";
  /** Stable per tool call. Present means "this write must happen at most once". */
  idempotencyKey?: string;
  /** The tool name for the audit row. Defaults to the intent's own `type`. */
  tool?: string;
}

export function executeAction(intent: ActionIntent, opts?: ExecuteOptions): ActionOutcome;
```

A duplicate returns effect `"action.duplicate"`, `ok: true`, `ids: []`, and an
empty `message` — deliberately empty, because the loop already told the model the
first call succeeded and a second sentence about it would be noise.

---

## 7. Gating

`src/lib/mind/index.ts` enters the loop only when **all** of these hold:

1. `llmAvailable()` is true (model enabled AND a key resolved), and
2. the local engine returned **no** `outcome` and **no** `cards`, and
3. `opts.forceLocal` is not set.

Otherwise behaviour is exactly as before. That is the acceptance criterion
"with no key configured the loop is never entered" — prove it by asserting the
`engine` field of the returned `Message` is `"local"` and that
`store.recentActions()` never gained a `source: "model"` row.
