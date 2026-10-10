# Upgrade contracts — Xana, "smarter" pass

**Status: LOCKED.** Written by the Lead before any writer starts. If you need a
signature changed, message the Lead; do not unilaterally change a shape another
module already imports.

Read this whole file before writing code. It exists to stop three people editing
one file at once.

---

## 1. The decision this pass makes

Xana's load-bearing rule (MEMORY.md §1) is: **intent resolution is local, always**,
and the LLM only phrases. That rule is why she is trustworthy and why she works
with no key. It is also *exactly* why she feels limited: anything the local intent
engine does not match produces a refusal sentence, and the model is explicitly
forbidden from doing anything about it.

This pass keeps the property and removes the ceiling:

| | Before | After |
|---|---|---|
| Who decides what happens | local `localMind()` only | `localMind()` **first**; if it matches nothing, the model may **propose** from a closed catalog |
| How a proposal lands | — | exactly one path: `executeAction()` |
| Validation | implicit | `validateActionIntent()` — typed + semantic, fail-closed |
| Audit | `conversation.meta` only | append-only `action_log` row written with the effect |
| Duplicate writes | possible | `idempotency_key` on every model-originated call |
| Untrusted content | n/a | marked as data; a write proposed from it is refused |
| Casual conversation | refused with "I didn't follow that" | answered by the model, warmly, with full context |
| No API key | fully functional | **still** fully functional — the loop is skipped entirely |

**What we are NOT doing** (decided against, with reasons in `docs/WHY-THIS-WAY.md`):

- No generic SQL / HTTP / shell operation. The catalog is a closed set of typed
  intents, not a code interpreter. This is the whole safety argument.
- No web-fetch tool. Xana already holds private data; adding an exfiltration
  channel plus untrusted content would create the lethal trifecta. Out of scope.
- No model-written `progressOverride` on a goal. The model proposes *structure*
  (milestones); deterministic code owns *progress*.
- No new native dependency. `sqlite-vec` measured unnecessary at this scale.

---

## 2. File ownership — do not write outside your column

| Owner | Files (create unless noted) |
|---|---|
| **lead** | `src/lib/core/store.ts`, `src/lib/core/types.ts`, `src/lib/actions/executor.ts`, `src/lib/mind/index.ts` (edit), `src/lib/mind/claims.ts` (edit), `src/lib/mind/llm.ts` (edit), `src/lib/mind/agent.ts`, `src/lib/mind/tools.ts`, `src/lib/mind/guard.ts`, `src/lib/settings/types.ts`, `src/lib/settings/providers.ts`, `src/lib/settings/store.ts` |
| **retrieval** | `src/lib/core/vector.ts` (edit), `src/lib/core/bm25.ts`, `src/lib/core/fusion.ts`, `src/lib/core/embedder.ts`, `src/lib/derived/memory.ts` (edit), `src/lib/derived/summary.ts`, `src/app/api/memory/route.ts`, `scripts/check-retrieval.ts` |
| **conversation** | `src/lib/mind/persona.ts`, `src/lib/mind/voice.ts`, `src/lib/mind/casual.ts`, `scripts/check-persona.ts` |
| **goals** | `src/lib/derived/goals.ts` (edit), `src/lib/derived/intentions.ts`, `src/lib/derived/proactive.ts`, `src/lib/mind/plan.ts`, `src/app/api/schedule/route.ts`, `scripts/check-planning.ts` |
| **verifier** | `scripts/check-mind-loop.ts`, `scripts/check-contracts.ts`, `docs/WHY-THIS-WAY.md` |

Anyone may *read* anything. Nobody but the owner writes a file. If you believe a
file outside your column is wrong, message its owner or the Lead.

Two rules that are not negotiable:

- **Additive changes only to shared files you own.** `src/lib/core/types.ts` and
  `src/lib/settings/types.ts` are edited by the Lead only — ask.
- **The gate must stay green.** `npm run typecheck` after every significant edit,
  and your own `scripts/check-*.ts` suite must pass before you report done.

---

## 3. Interfaces

### 3.1 `src/lib/mind/tools.ts` — lead

```ts
import type { ActionIntent, LifeState } from "../core/types";

export type ToolSafety = "read" | "write" | "destructive";

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments, as the model sees it. */
  parameters: Record<string, unknown>;
  safety: ToolSafety;
  /** Ids the model must not invent: names are resolved server-side. */
  resolves?: Array<"task" | "event" | "goal" | "habit">;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => ToolResult;
}

export interface ToolContext {
  lifeState: LifeState;
  sessionId?: string;
  /** Set when the proposal came from content Xana did not write. Fail-closed. */
  untrustedSource?: string;
}

export type ToolResult =
  | { ok: true; data: unknown; intent?: ActionIntent }
  | { ok: false; error: string };

/** The read tools return JSON the model can reason over. */
export const READ_TOOLS: ToolSpec[];
/** The write tools wrap executeAction; nothing here executes directly. */
export const WRITE_TOOLS: ToolSpec[];
export const ALL_TOOLS: ToolSpec[];
/** OpenAI-compatible `tools` array, stable order (prompt caching depends on it). */
export function toolsJsonSchema(): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
```

### 3.2 `src/lib/mind/guard.ts` — lead

```ts
import type { ActionIntent, LifeState } from "../core/types";
import type { ToolSpec } from "./tools";

export interface Proposal {
  tool: string;
  args: Record<string, unknown>;
}

export type Verdict =
  | { verdict: "allow"; intent: ActionIntent; spec: ToolSpec }
  | { verdict: "confirm"; intent: ActionIntent; spec: ToolSpec; question: string }
  | { verdict: "refuse"; reason: string };

/** The one gate every model-proposed write passes through. Never throws. */
export function validateActionIntent(proposal: Proposal, ctx: { lifeState: LifeState }): Verdict;
```

### 3.3 `src/lib/mind/agent.ts` — lead

```ts
export interface AgentTurnInput {
  text: string;
  lifeState: LifeState;
  sessionId: string;
  modality?: "text" | "voice";
}
export interface AgentTurnResult {
  text: string;
  cards?: import("../core/types").Card[];
  outcome?: import("../core/types").ActionOutcome;
  toolCalls: Array<{ name: string; ok: boolean; effect?: string }>;
  engine: "agent" | "local";
}
export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult>;
```

`runAgentTurn` is called by `mind/index.ts` **only** when the local engine matched
nothing and a model is configured. It never throws.

### 3.4 `src/lib/mind/llm.ts` — lead (extending the existing client)

```ts
export interface LlmToolCall { id: string; name: string; arguments: string }

/** Extended, backwards compatible. `reasoning_content` is captured but NOT replayed. */
export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface LlmCompletion {
  text: string;
  model: string;
  latencyMs: number;
  toolCalls: LlmToolCall[];
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number; cachedTokens: number; reasoningTokens: number };
}

export interface LlmOptions {
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  tools?: ReturnType<typeof import("./tools").toolsJsonSchema>;
  toolChoice?: "auto" | "none" | "required";
  /** Default true. Disable for cheap extraction/analysis calls. */
  thinking?: boolean;
  reasoningEffort?: "low" | "high" | "max";
  responseFormat?: "text" | "json_object";
}

/** Existing signature kept working; now returns LlmCompletion. */
export async function llmComplete(messages: LlmMessage[], opts?: LlmOptions): Promise<LlmCompletion>;
```

**Verified API facts** (live-probed by the Lead on 2026-10-08, not from docs):

- `reasoning_content` returned when thinking is on. **Replaying it is NOT
  required** — omitting it returned 200. Docs claim a 400; they are wrong. Do not
  build a dependency on replaying it.
- `parallel_tool_calls` **is accepted** (200) though undocumented.
- `tool_choice: "required"` **fails with 400 in thinking mode**
  (`"Thinking mode does not support this tool_choice"`). With
  `thinking: {type:"disabled"}` it works. Never send `required` with thinking on.
- Tool arguments are a JSON **string** and can be malformed → always parse defensively.
- Prompt caching: stable prefix first, volatile last. `usage.prompt_cache_hit_tokens`.
- Legacy names `deepseek-chat`/`deepseek-reasoner` **still answer 200** as of today
  but are documented retired; new default is `deepseek-flash`.

### 3.5 `src/lib/core/store.ts` — lead (new methods; callers may use them)

```ts
/** Append-only. Written in the same transaction as the effect it records. */
logAction(entry: {
  sessionId?: string; source: "local" | "model" | "system";
  tool: string; intent: unknown; ok: boolean; effect: string;
  detail?: string; idempotencyKey?: string;
}): void;

/** True when this exact key already produced a successful write this session. */
seenIdempotencyKey(key: string): boolean;

/** Recent writes, newest first — what the claim guard reads. */
recentActions(limit?: number): Array<{ tool: string; effect: string; ok: boolean; createdAt: string; detail?: string }>;

/** Conversation summaries, keyed by session and covering a turn range. */
saveSummary(s: { sessionId: string; fromSeq: number; toSeq: number; text: string; topics: string[]; createdAt: string }): void;
recentSummaries(sessionId: string, limit?: number): Array<{ text: string; topics: string[]; createdAt: string }>;

/** Implementation intentions — if/then plans attached to a goal. */
listIntentions(goalId?: string): Intention[];
upsertIntention(i: { id?: string; goalId: string; trigger: string; action: string; createdAt?: string }): Intention;
deleteIntention(id: string): boolean;
```

### 3.6 `src/lib/core/vector.ts` + `src/lib/core/embedder.ts` — retrieval

`Embedder` stays as it is (`id`, `dim`, `embed`). `EMBED_DIM` **must stay 384**:
existing `vector` BLOBs are 384-wide and the column is not being migrated.

```ts
// src/lib/core/embedder.ts
export interface ResolvedEmbedder { embedder: Embedder; changed: boolean }
/** Picks from settings; always returns something usable, never throws. */
export function resolveEmbedder(): ResolvedEmbedder;
```

A new `embedding_model` column records which embedder wrote each row. Rows whose
recorded model differs are re-embedded on read. The default embedder stays
`localEmbedder` for this pass — swapping to a downloaded model is opt-in and must
never be required for the app to start or for `npm run check` to pass.

### 3.7 `src/lib/derived/memory.ts` — retrieval (edit, additive)

```ts
/** Hybrid retrieval: lexical (FTS5/BM25) + dense, fused by RRF, then decayed. */
export function searchMemoriesHybrid(
  query: string,
  limit: number,
  store?: XanaStore,
): Array<{ memory: MemoryRecord; score: number; because: "lexical" | "semantic" | "both" }>;

/** Extraction write path. Must refuse to store a validation/flattery. */
export function rememberConversation(
  turn: { userText: string; xanaText: string; sessionId: string },
  store?: XanaStore,
): MemoryRecord[];
```

`rememberConversation` is **pure-local by default**: it may call the model only
when one is configured, and must return `[]` rather than throw when it is not.
It must never store a sentence whose content is agreement, praise or validation —
that is the sycophancy feedback loop the research named. Encode that as a
rejection filter with tests, not as prompt advice alone.

### 3.8 `src/lib/mind/persona.ts` + `voice.ts` + `casual.ts` — conversation

```ts
// persona.ts
/** The built-in persona. Settings may override entirely (unchanged behaviour). */
export function defaultPersona(): string;

// casual.ts
/** True when the utterance is talk rather than a request to change something. */
export function isCasual(text: string): boolean;
/** A conversational system prompt, used when nothing matched and no action ran. */
export function conversationalSystemPrompt(o: { userName?: string; location?: string; today: string; partOfDay: string }): string;

// voice.ts — pure, testable, no I/O
export function stripMarkdown(text: string): string;              // moved from mind/index.ts
export function shapeForModality(text: string, modality?: "text" | "voice"): string;
export function soundsSycophantic(text: string): boolean;
```

`DEFAULT_PERSONA` in `settings/types.ts` stays exported and stays the stored
default; `persona.ts` becomes its source of truth and `settings/types.ts`
re-exports it. Coordinate with the Lead before that edit lands.

### 3.9 `src/lib/derived/goals.ts` + `intentions.ts` + `mind/plan.ts` — goals

```ts
// intentions.ts
export interface Intention { id: string; goalId: string; trigger: string; action: string; createdAt: string }
export function intentionFor(goalId: string, store?: XanaStore): Intention | undefined;

// plan.ts
export interface MilestoneProposal { title: string; due?: string; order: number }
/** Model proposes structure. Offline default returns a deterministic skeleton. */
export async function decomposeGoal(input: { title: string; why?: string; targetDate?: string; horizon: GoalHorizon }): Promise<MilestoneProposal[]>;
/** Deterministic verification of a model's proposal. Drops anything invalid. */
export function validateMilestones(proposals: MilestoneProposal[], targetDate?: string): MilestoneProposal[];
```

`validateMilestones` must reject: empty titles, duplicate titles, dates after the
goal's target date, more than 8 proposals, and any non-integer order. It is the
thing that lets a model help with planning without being believed.

### 3.10 `src/lib/derived/proactive.ts` + `src/app/api/schedule/route.ts` — goals

```ts
export interface ProactiveCandidate {
  kind: "briefing" | "reflection" | "goal-drift" | "intention" | "nudge";
  text: string;
  /** 0..1 — how likely this is relevant right now. */
  relevance: number;
  /** 0..1 — how much it costs to interrupt now. */
  interruptionCost: number;
}
export interface ProactiveDecision { candidate: ProactiveCandidate; utility: number; deliver: boolean; reason: string }
/** E[U] = P(relevant)·benefit − (1−P(relevant))·cost, with quiet hours and budgets. */
export function decideProactive(candidates: ProactiveCandidate[], now: Date, opts?: { quietHours?: [number, number]; budgetPerDay?: number; deliveredToday?: number }): ProactiveDecision[];
```

Timing must use `src/lib/core/zone.ts` helpers, never bare `new Date()` for
"today" or "7am" — that is the documented off-by-one-day bug class.

---

## 4. Verification requirements

Every writer adds a `scripts/check-*.ts` suite in the house style (see
`scripts/check-energy.ts`): a `check(label, condition, detail?)` helper, section
headings, and a final `N passed, M failed` line, exiting non-zero on failure. It
must run with **no network and no API key**.

Add your suite to `package.json` `scripts` as `verify:<name>` and insert it into
the `check` chain. `package.json` is edited by the Lead — send the exact line you
want added and where, and the Lead will land it, so two writers never collide on
one file.

The suites must prove the *negative* cases, not just the happy path:

- a malformed tool call is refused, not executed;
- a write proposed from untrusted content is refused;
- a duplicate idempotency key does not write twice;
- an embedder swap does not corrupt existing rows;
- a model-proposed milestone set containing a bad date is rejected;
- a sycophantic memory candidate is not stored;
- with no API key configured, every one of the above still holds and the app
  still answers.

---

## 5. Definition of done for this pass

1. `npm run check` green, including every new suite.
2. With **no** API key: `npm run demo` and `npm run smoke` behave exactly as before.
3. With a key: an utterance that used to produce "I didn't follow that" now either
   performs the right action or answers conversationally.
4. `MEMORY.md` and `DESIGN.md` updated where they became wrong; `docs/REFERENCE.md`
   describes every new setting, table and endpoint.
5. Every new number that reaches the UI is measured here, not quoted from a blog.
