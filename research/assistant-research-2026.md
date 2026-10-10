# Making Xana Genuinely Smarter and More Useful

**A research report on agentic tool safety, memory architecture, local embeddings, proactive behaviour, goal reasoning, and conversation quality.**

Prepared 2026-10-08. Scope: local-first, single-user, Next.js 16 + `better-sqlite3` + TypeScript, DeepSeek LLM for voice.

## How to read this document

Every claim is tagged:

- **[EVIDENCE]** — paper, official spec, or documented benchmark with numbers.
- **[VENDOR CLAIM]** — a company reporting its own benchmark. Directionally useful, treat as marketing until independently reproduced.
- **[OPINION]** — a practitioner's reasoned judgement with no data behind it. Useful for design taste, not for justification.
- **[VERIFY]** — I could not retrieve the primary source in this session (paywall, fetch failure, or bot-blocking). The number is stated as commonly cited and **must be checked before it goes in a decision memo or a UI string.**

Grounding notes reference the actual repository. Paths are relative to the workspace root.

### Where Xana actually stands today

This matters because most of the advice below is *already half-built*. The gaps are specific.

| Subsystem | Current state | File |
|---|---|---|
| Embedder | Deterministic feature hashing: token unigrams + bigrams + char trigrams, 384-dim, signed hashing, L2-normalised. Not a transformer. | `src/lib/core/vector.ts` |
| Recall scoring | `0.52·max(0,cosine) + 0.26·lexicalOverlap + 0.14·salience + 0.08·recency + entityBoost(0.18)`, min score 0.08, brute-force full-table scan | `src/lib/core/store.ts:776` |
| Recency | `0.5 ** (ageDays / halfLifeDays)`, half-life 45 days in recall, 21 days default elsewhere | `src/lib/core/time.ts:136` |
| Memory schema | `memories(id, kind, title, content, entities, tags, salience, source, session_id, created_at, last_accessed_at, access_count, superseded_by, vector BLOB)` — already has supersession and access tracking | `src/lib/core/store.ts:321` |
| Intent resolution | **Local and deterministic, always.** The model never resolves intent. | `src/lib/mind/index.ts` (structural rule, documented at top) |
| Claim grounding | `actionRule()` gives the model advice; `guardUnmadeClaim()` checks the output afterwards and rewrites it. A mirror guard catches false *denials*. | `src/lib/mind/claims.ts`, wired at `src/lib/mind/index.ts:127` |
| Reflection | Deterministic, no model call: fixed 3-paragraph structure from completions/milestones/focus/health. Triggers on elapsed 7 or 28 days. | `src/lib/derived/reflection.ts:139` |
| Nudges | Deterministic rules, priority-ordered, hard cap of 5, each carries an `ActionIntent` for one-tap resolution | `src/lib/derived/nudges.ts:366` |
| Goal pace | Milestone-ratio progress vs elapsed time; `ahead` if delta ≥ 0.15, `on-track` if ≥ −0.12, else `slipping`; staleness via `lastTouchedAt` | `src/lib/derived/goals.ts:96` |
| Settings | Persona stored in `voice.persona`; `systemPrompt()` returns it or a default | `src/lib/mind/llm.ts:70` |

Three structural facts shape every recommendation:

1. **Xana has no LLM tool calling today.** The LLM produces prose only. Intent is parsed locally. This is a stronger safety posture than any competitor's and should not be given up casually — see §1.
2. **`recall()` is an O(n) table scan with a JS cosine loop.** Fine at a few thousand memories, degrades later. §3 covers the fix.
3. **The embedder is lexical-with-typo-tolerance in disguise.** It cannot match "car broke down" to "vehicle maintenance". §3.1 quantifies what that costs and what a real embedder buys.

---

## 1. Agentic tool calling with safety

### 1.1 The finding that should shape the whole design

Three independent sources converge on the same conclusion, and it is not the one people expect.

**Home Assistant's `ToolAnnotations` defaults describe the least safe case.** A tool that declares nothing is treated as writing, destructive, and reaching outside the system:

| Field | Meaning | Default |
|---|---|---|
| `read_only` | Only reads; changes nothing | `False` |
| `destructive` | Can change or remove something that already exists | `True` |
| `idempotent` | Calling again with the same arguments has no further effect | `False` |
| `open_world` | Reaches outside Home Assistant | `True` |

**[EVIDENCE]** — [Home Assistant LLM API docs](https://developers.home-assistant.io/docs/core/llm/). The docs state the annotations "match the tool annotations of the Model Context Protocol." HA also caps the agent loop at **10 iterations** (`for _iteration in range(10)`), and its built-in Assist API is explicitly scoped: "The Assist API is equivalent to the capabilities and exposed entities that are also accessible to the built-in conversation agent. No administrative tasks can be performed."

**Humans are bad at the confirmation gate.** Anthropic commissioned a third-party evaluation (Trajectory Labs, July 2026) across 1,053 paid testers: partway through each session a single permission prompt was swapped for a clearly dangerous command. **Only 13.6% of humans refused it. Their auto mode blocked 89%.** **[EVIDENCE]** for the study's existence and reported numbers; **[VENDOR CLAIM]** for the generalisation (Anthropic commissioned it). Reported via [Simon Willison's analysis](https://simonwillison.net/2026/Aug/8/auto-mode/), which also flags the obvious caveat: 11% of dangerous actions still got through, and self-commissioned evals deserve replication.

Two implications, and they cut in opposite directions:

- **A blanket "confirm everything" gate is security theatre.** With enough prompts, users click through.
- **So confirmation must be rare, targeted, and irreversible-only.** Everything else needs a *deterministic* guard that does not depend on the model cooperating.

**Compaction and truncation can silently violate guarantees.** OpenAI's Model Spec: "In ChatGPT, conversations may grow so long that the model cannot process the entire history. In this case, the conversation will be truncated, using a scheme that prioritizes the newest and most relevant information. The user may not be aware of this truncation or which parts of the conversation the model can actually see." **[EVIDENCE]** — [Model Spec 2025-04-11](https://model-spec.openai.com/2025-04-11.html). If you add compaction (§2.3), the audit log must record what was dropped.

### 1.2 Techniques worth adopting

**(a) Keep intent resolution deterministic. Extend the pattern you already have.**

Xana's existing rule — "intent resolution is local, always, so the model can never *do* something that does not get written the same way every time" (`src/lib/mind/index.ts`) — is the strongest version of "propose then commit". Rather than adding tool calling and then bolting on validation, add *new capabilities* as new deterministic operations, and let the model's role stay at the phrasing layer.

Concretely: `src/lib/cave/ops.ts` already exposes a named operation registry (`CAVE_OPERATIONS`, `runCaveOperation`) with validate-and-return-payload semantics. That is a tool registry with a different name, and it is already the commit path.

**(b) Tag every operation with a safety class, using HA's four flags.**

This is the single highest-value change in §1. Add to the operation registry:

```ts
export interface OperationSafety {
  readOnly: boolean;      // default false
  destructive: boolean;   // default TRUE  (fail closed)
  idempotent: boolean;    // default false
  openWorld: boolean;     // default TRUE  (fail closed)
  /** Reversibility window in hours; undefined = not reversible. */
  undoWindowHours?: number;
}
```

Defaults must be the *unsafe* values, per HA. A new operation added by a future contributor is then gated by default, and the gate is discoverable in review. `reflection`, `listCave*`, `briefing` are `readOnly: true`. `create_task`, `logHealthOp`, `createEvent` are non-destructive and reversible via the existing trash table (`TRASH_DAYS = 7` in `src/lib/core/types.ts:656`) — so **they need no confirmation at all**. `deleteTask`, `emptyTrash`, `purgeFromTrash`, `forgetMemory` are `destructive: true, idempotent: false` — these get the gate.

**(c) Confirmation gate keyed to irreversibility, not to "write".**

```
needsConfirm(op, args) =
     op.safety.destructive && !isUndoableWithin(op.undoWindowHours)
  || op.safety.openWorld && transfersDataOutside(op, args)
```

Because `deleteTask` already routes to `trash` with a 7-day restore window, `isUndoableWithin` returns true and **no prompt appears**. Only `purgeFromTrash` / `emptyTrash` / `forgetMemory` prompt. That is a prompt budget of roughly "almost never", which is what makes the 13.6% finding survivable.

**(d) Idempotency without requiring the model to be idempotent.**

Home Assistant's own annotation defaults say a tool is *not* idempotent unless declared. Do not trust the model to avoid duplicate calls. Instead, derive the key server-side:

```ts
// Deterministic: same intent + same resolved args + same minute bucket → same row.
const idemKey = sha256(`${op.name}|${canonicalJson(args)}|${minuteBucket(now, 5)}`);
```

Insert into an `action_log` with a `UNIQUE(idem_key)` constraint; on conflict, return the *previous* outcome rather than re-executing. This makes double-fire from a retry, a double-tap, or a duplicated voice transcript a no-op. `src/lib/derived/memory.ts` already documents this discipline for memory ingestion ("Ingesting the same snapshot twice adds nothing, because the second pass sees the key already present") — extend it to actions.

**(e) Audit log as an append-only table, not a log file.**

```sql
CREATE TABLE action_log (
  id            TEXT PRIMARY KEY,
  idem_key      TEXT NOT NULL UNIQUE,
  at            TEXT NOT NULL,
  session_id    TEXT,
  op            TEXT NOT NULL,
  args_json     TEXT NOT NULL,
  safety_json   TEXT NOT NULL,     -- snapshot of the flags AT EXECUTION TIME
  outcome       TEXT NOT NULL,     -- 'executed' | 'refused' | 'confirm_pending' | 'failed'
  result_json   TEXT,
  reversible    INTEGER NOT NULL DEFAULT 0,
  undone_at     TEXT,
  -- what the model was told, so a bad reply can be traced to a bad prompt
  prompt_digest TEXT
);
CREATE INDEX idx_action_log_at ON action_log(at DESC);
```

Two non-obvious columns. `safety_json` snapshots the flags at execution time, because code changes and you need to reconstruct why a decision was correct *then*. `prompt_digest` links a spoken claim back to the context that produced it — without it, debugging "she said she did X" is guesswork.

**(f) Validate arguments in the deterministic layer, and reject loudly.**

HA converts and validates LLM-supplied arguments against a `probatio` schema and returns a structured failure the model can read: `return ToolResult(data={"error": "Calendar not found"}, error=True)`. **[EVIDENCE]** — same HA docs. Their distinction is worth copying: *raise* for "the tool could not do its work"; *return `error=True`* when you want to word the failure **for the model**. Xana's `executeAction` returns `ActionOutcome.message` strings already described as "part of the product" (`src/lib/actions/executor.ts`) — that is the same idea, and it should stay the only channel by which failure reaches the model.

**(g) The lethal trifecta — the reason not to add a web-fetch tool carelessly.**

**[EVIDENCE]** — [Simon Willison, 16 June 2025](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/): "Any time you grant an LLM-based system access to private data, exposure to untrusted content, and the ability to externally communicate you have a nasty security hole." His tag page documents the pattern recurring across GitHub MCP, Supabase MCP, Atlassian MCP, Microsoft 365 Copilot (CVE-2025-32711), GitLab Duo, Google Antigravity, and Claude's own `web_fetch` tool.

Xana currently holds **one** leg (private data: the whole SQLite brain). It has no untrusted-content channel and no external-communication tool. Adding either is what creates exposure. If a web tool is ever added:

- Adopt the **Rule of Two** framing (Chromium's rule, adapted): "Chrome Security Team will generally not approve landing a CL or new feature that involves all 3 of untrustworthy inputs, unsafe language, and high privilege. To solve this problem, you need to get rid of at least 1 of those 3 things." — quoted at [simonwillison.net/2025/Aug/11/the-rule-of-2/](https://simonwillison.net/2025/Aug/11/the-rule-of-2/).
- Copy Anthropic's `web_fetch` design: fetch only URLs the user entered or that a *search tool* returned. Their first version also allowed URLs found inside fetched pages, and that was the hole ([exfiltration writeup](https://simonwillison.net/2026/Jul/15/claude-web-fetch-exfiltration/)).
- Or copy OpenAI's **Lockdown Mode**: "designed to help prevent the final stage of data exfiltration from a prompt injection attack by limiting outbound network requests", with the honest caveat that it "does not prevent prompt injections from appearing in the content ChatGPT processes" ([OpenAI Help](https://help.openai.com/en/articles/20001061-lockdown-mode), via [Willison](https://simonwillison.net/2026/Jun/5/openai-help-lockdown-mode/)).

**(h) What the other frameworks do, in one line each.**

- **LangGraph** — durable interrupt/resume. Graph state is checkpointed; `interrupt()` pauses inside a node; the resume value is delivered via `Command(resume=...)`; work resumes from the checkpoint rather than the beginning. [Interrupts docs](https://docs.langchain.com/oss/python/langgraph/interrupts). *(**[VERIFY]** — the docs site renders client-side; I confirmed the page exists and its position under Capabilities → Interrupts but could not extract the code samples.)*
- **Letta/MemGPT** — first-class approval on tool calls. The API surface includes `agents.tools.update_approval` and a dedicated [Human-in-the-loop (HITL) tools](https://docs.letta.com/v1-sdk/tools/human-in-the-loop) page; a tool can be marked as requiring approval before it runs. *(**[VERIFY]** — docs render client-side; the `update_approval` endpoint is visible in the navigation.)*
- **MemGPT paper (Packer et al. 2023)** — the parser is the gate: "This output string is parsed by MemGPT to ensure correctness, and if the parser validates the function arguments the function is executed. The results, including any runtime errors that occur (e.g. trying to add to main context when it is already at maximum capacity), are then fed back to the processor by MemGPT." **[EVIDENCE]** — [arXiv:2310.08560](https://arxiv.org/abs/2310.08560). Note the loop: **runtime errors are fed back**, which is how the model recovers instead of hallucinating success.
- **OpenAI Model Spec** — authority levels are Platform > Developer > User > Guideline, and "No Authority" applies to "assistant and tool messages; quoted/untrusted text and multimodal data in other messages". Tool output is explicitly untrusted. **[EVIDENCE]** — [Model Spec](https://model-spec.openai.com/2025-04-11.html).
- **MCP** — same four annotation hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) plus user-consent requirements. *(**[VERIFY]** — [modelcontextprotocol.io](https://modelcontextprotocol.io) did not yield the spec text in this session; HA's docs independently confirm the four hints and their names.)*

### 1.3 Implementation note for Xana

1. Add `OperationSafety` to the registry in `src/lib/cave/ops.ts` with fail-closed defaults; tag all ~30 existing operations.
2. Create `action_log` in the `migrate()` block in `src/lib/core/store.ts` (the file already demonstrates additive migration via `PRAGMA table_info` + `ALTER TABLE`, so a new table is low-risk).
3. Route `executeAction` (`src/lib/actions/executor.ts`) and `runCaveOperation` through a single `commit(op, args, {idemKey})` wrapper that writes the audit row *in the same transaction* as the effect. `better-sqlite3` transactions are synchronous, which makes this genuinely atomic — an advantage over most stacks.
4. Extend `guardUnmadeClaim` (`src/lib/mind/claims.ts`) to consult `action_log` for the current session instead of only a boolean `acted` flag. That upgrades it from "did anything happen" to "did *this specific thing* happen", which catches partial failures (the real incident recorded in that file: three calendar entries requested, one created with the whole line as its title).
5. Add a `refused` outcome. Refusals are currently invisible; they are the signal you need to tune thresholds.

**Anti-pattern to avoid:** do not give the model a generic `run_sql` or `http_request` operation. That single decision collapses the entire safety design, and it is the mistake every documented trifecta incident shares.

---

## 2. Memory architecture

### 2.1 The canonical retrieval formula

**[EVIDENCE]** — Park et al., *Generative Agents: Interactive Simulacra of Human Behavior*, UIST 2023, [arXiv:2304.03442](https://arxiv.org/abs/2304.03442). This is the most-copied formula in assistant memory, and the paper is specific:

```
score = α_recency · recency + α_importance · importance + α_relevance · relevance
```

with **all α set to 1**, and each term **min-max normalised to [0,1]** across the candidate set.

- **Recency**: "an exponential decay function over the number of sandbox game hours since the memory was last retrieved. Our decay factor is 0.995." Note: *last retrieved*, not created. Retrieval refreshes the memory — this is why the paper's score tracks `last_accessed_at`, which Xana already has as a column.
- **Importance**: "we find that directly asking the language model to output an integer score is effective", generated **at creation time**. Exact prompt:

  > "On the scale of 1 to 10, where 1 is purely mundane (e.g., brushing teeth, making bed) and 10 is extremely poignant (e.g., a break up, college acceptance), rate the likely poignancy of the following piece of memory. Memory: buying groceries at The Willows Market and Pharmacy. Rating: <fill in>"

  Calibration anchors from the paper: 2 for "cleaning up the room", 8 for "asking your crush out on a date".
- **Relevance**: cosine similarity between embeddings of the memory and the query memory.

**Reflection trigger**: "we generate reflections when the sum of the importance scores for the latest events perceived by the agents exceeds a threshold (150 in our implementation). In practice, our agents reflected roughly two or three times a day."

**Reflection mechanism**, which is the part usually left out:

1. Query the model with the **100 most recent** memory records: "Given only the information above, what are 3 most salient high-level questions we can answer about the subjects in the statements?"
2. Use those generated questions as *retrieval queries*.
3. Ask for insights **with citations**: "What 5 high-level insights can you infer from the above statements? (example format: insight (because of 1, 5, 3))".
4. Parse and store as a reflection, "including pointers to the memory objects that were cited".

Step 3's citation requirement is the mechanism that makes reflections auditable, and it produces **trees**: agents reflect on prior reflections, so leaf nodes are observations and higher nodes are progressively more abstract.

**Failure modes the paper itself reports**, which are the ones to test for: "the most common errors arose when the agent failed to retrieve relevant memories, fabricated embellishments to the agent's memory, or inherited overly formal speech or behavior from the language model."

### 2.2 Virtual context management (MemGPT / Letta)

**[EVIDENCE]** — Packer et al., [arXiv:2310.08560](https://arxiv.org/abs/2310.08560).

- **Two tiers.** *Main context* = prompt tokens = system instructions (read-only) + **working context** (fixed-size read/write block for facts about the user, writable only via function calls) + **FIFO queue** (rolling history).
- **Memory pressure warning.** "When the prompt tokens exceed the 'warning token count' of the underlying LLM's context window (e.g. 70% of the context window), the queue manager inserts a system message into the queue warning the LLM of an impending queue eviction."
- **Flush.** "When the prompt tokens exceed the 'flush token count' (e.g. 100% of the context window), the queue manager flushes the queue... the queue manager evicts a specific count of messages (e.g. 50% of the context window), generates a new recursive summary using the existing recursive summary and evicted messages."
- **The eviction is lossy in context, not in storage.** "the evicted messages are no longer in-context and immediately viewable to the LLM, however they are stored indefinitely in recall storage and readable via MemGPT function calls."
- **The recursive summary lives at index 0 of the queue**, so it is always in context and always the oldest thing there.

**Results** (Multi-Session Chat, deep memory retrieval — a question that can only be answered from prior sessions):

| Model | Accuracy | ROUGE-L |
|---|---|---|
| GPT-3.5 Turbo | 38.7% | 0.394 |
| **+ MemGPT** | **66.9%** | **0.629** |
| GPT-4 | 32.1% | 0.296 |
| **+ MemGPT** | **92.5%** | **0.814** |
| GPT-4 Turbo | 35.3% | 0.359 |
| **+ MemGPT** | **93.4%** | **0.827** |

The baselines "are able to see a lossy summarization of the past five conversations to mimic an extended recursive summarization procedure" — so this is memory architecture vs. summarisation, not vs. nothing. The delta (32% → 92% for GPT-4) is the strongest single argument in this report for investing in retrieval rather than longer prompts.

Also note: **function-call reliability bounds the benefit.** "MemGPT has significantly degraded performance using GPT-3.5, due to its limited function calling capabilities." **This is a direct warning for Xana on DeepSeek**: if you add a model-driven memory-search tool, measure whether it actually calls it, and how often it stops paging early — "we observe that MemGPT will often stop paging through retriever results before exhausting the retriever database."

### 2.3 Summarisation and compaction

- **Recursive/hierarchical summarisation** is the MemGPT mechanism above: `new_summary = f(old_summary, evicted_messages)`. The old summary is always part of the input, so information degrades gracefully rather than being lost per-window.
- **Anthropic's "Effective context engineering for AI agents"** is the current official guidance on compaction; there is also a first-party cookbook, [Automatic context compaction](https://platform.claude.com/cookbook/tool-use-automatic-context-compaction). **[EVIDENCE]** for the artifacts' existence. *(**[VERIFY]** — I did not retrieve the full text; the guiding claim to check is that compaction should preserve decisions and open threads while discarding resolved chatter.)*
- **Prompt caching changes the calculus.** Anthropic's contextual-retrieval post notes prompt caching "reducing latency by >2x and costs by up to 90%", and that "If your knowledge base is smaller than 200,000 tokens (about 500 pages of material), you can just include the entire knowledge base in the prompt that you give the model, with no need for RAG." **[EVIDENCE]** — [Anthropic](https://www.anthropic.com/engineering/contextual-retrieval). **Relevant to Xana:** a single user's memory store may genuinely be under that threshold, and DeepSeek offers context caching. Measure your total memory-store token count before building sophisticated retrieval — the honest answer might be "put the pinned core in every prompt and retrieve the rest."

### 2.4 What is worth remembering from this turn

- **Mem0** — [arXiv:2504.19413](https://arxiv.org/abs/2504.19413), "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory". **[VENDOR CLAIM]** — the paper reports large accuracy gains over a full-context baseline on LOCOMO alongside a ~91% reduction in token usage. Both figures are **self-reported by the authors, who sell the system.** Do not quote them as established; the *architecture* (extract candidate facts → reconcile against existing memories via LLM → ADD/UPDATE/DELETE) is the transferable part and is worth reading.
- **LongMemEval** — [arXiv:2410.10813](https://arxiv.org/abs/2410.10813), Wu et al. The useful contribution is its **ability taxonomy**, which is a better requirements list than any architecture diagram: information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and **abstention**. Most systems are never tested on that last one, and for a personal assistant it is the failure that destroys trust fastest. *(**[VERIFY]** specific per-ability scores.)*
- **MemoryBank** (Zhong et al., AAAI 2024) applies an **Ebbinghaus forgetting curve** to memory strength with periodic reinforcement — the principled version of decay-by-importance. *(**[VERIFY]** — not retrieved.)*
- **Zep/Graphiti** — [arXiv:2501.13956](https://arxiv.org/abs/2501.13956) — temporal knowledge graph memory where edges carry validity intervals, so "the user lives in Lisbon" can be *superseded* rather than *deleted*. The bi-temporal modelling is the interesting claim. **[VENDOR CLAIM]** on DMR benchmark results. Xana's `superseded_by` column is a one-dimensional version of exactly this idea.
- **Memory surveys** for taxonomy: [arXiv:2404.13501](https://arxiv.org/abs/2404.13501).

### 2.5 Episodic vs semantic vs procedural

**[OPINION, but well-supported by the survey literature]** A workable operational mapping:

| Type | What it is | Xana column value | Example |
|---|---|---|---|
| **Episodic** | A specific thing that happened, with a time | `kind='event'`/`'conversation'` | "On 3 March she said the Aurora deck was the blocker." |
| **Semantic** | A durable fact or preference, time-independent | `kind='fact'`/`'preference'`/`'person'` | "Prefers mornings for deep work." |
| **Procedural** | How the user likes things done | `kind='decision'` (or new `'procedure'`) | "Weekly review happens Sunday evening, not Monday." |

The distinction earns its keep because the three want different lifecycles: episodic memories **decay** (recency matters, and old episodes are usually noise); semantic memories **persist until superseded** (recency is nearly irrelevant — a birthday does not get stale); procedural memories **persist and should be injected aggressively**, because violating a stated preference is the most annoying possible failure. Xana's single global 45-day half-life (`src/lib/core/time.ts:136` used at `src/lib/core/store.ts:798`) applies the same decay to all three. That is the concrete bug: a `preference` memory from eight months ago currently scores 0.08·0.5^(240/45) ≈ 0.002 on recency, statistically identical to noise.

### 2.6 Retrieval scoring: what to change

Xana's current blend, at `src/lib/core/store.ts:802`:

```ts
const score = clamp(
  0.52 * Math.max(0, sim) + 0.26 * lex + 0.14 * mem.salience + 0.08 * recency + entityBoost,
  0, 1,
);
```

This is a reasonable design and already does something Generative Agents does not (explicit lexical channel, entity boost, pinned bypass). Specific upgrades, in priority order:

1. **Decay by kind.** Replace the constant half-life with a per-kind table: `preference`/`fact`/`decision`/`person`: effectively infinite (or 365 days); `event`/`conversation`: 21–45 days; `note`: 90 days. One-line change at the call site; large behavioural difference.
2. **Recency from `last_accessed_at`, not `created_at`.** The Generative Agents paper decays since *last retrieval*, which is causally what "in the attentional sphere" means. Xana stores `last_accessed_at` and `access_count` but recall scores on `mem.createdAt`. Fixing this also makes retrieval self-reinforcing in the correct way.
3. **Normalise before weighting.** Generative Agents min-max normalises each term across candidates. Xana's components are on incompatible scales (`cosine` ∈ [−1,1] but clustering near 0.1–0.4 for unrelated text; `lexicalOverlap` ∈ [0,1]; `salience` ∈ [0,1]). Weights therefore do not mean what they appear to mean. Min-max normalising per query over the candidate set makes weights interpretable and tunable.
4. **MMR for diversity.** Top-k by score returns five near-duplicates of the same fact. Maximal Marginal Relevance — `argmax[λ·sim(d,q) − (1−λ)·max_{s∈S} sim(d,s)]` — with λ ≈ 0.7 is the standard fix and is ~15 lines.
5. **Add abstention.** If the top score is below an absolute floor, return nothing and let the reply say "I don't have anything on that." This is one of LongMemEval's five abilities and the cheapest trust win available.
6. **Two-stage retrieval when the store grows.** Retrieve 50 by the cheap blend, then rerank. Anthropic found "Passing the top-20 chunks to the model is more effective than just the top-10 or top-5" and that reranking (top-150 → top-20) cut failure rate from 2.9% to 1.9%. **[EVIDENCE]** — same post.

### 2.7 Reflection: what to change

Xana's reflection is deterministic and offline (`src/lib/derived/reflection.ts`), which is a genuine feature — it works without a key and reads the same every time. But it therefore **cannot synthesise**. It counts completions and milestones; it cannot conclude "you keep deferring the Aurora deck when your calendar is heavy."

Recommended hybrid, keeping the deterministic version as the fallback:

- Add `kind='reflection'` memories with a `derived_from` link table (`reflection_sources(reflection_id, memory_id)`) — the paper's citation pointers, which give you auditability and let the UI show *why* a synthesis exists.
- Trigger on Generative Agents' rule: sum the `salience` of memories created since the last reflection; when it exceeds a threshold, reflect. Xana already has `salience` on every memory — the sum is a one-query aggregate. Keep the 7/28-day timer as a floor so silence still produces a review.
- Ask for **citations in the format `insight (because of <ids>)`** and parse them. Reject insights whose cited ids do not exist — that deterministically eliminates the paper's "fabricated embellishments" failure mode.
- Two model calls, exactly as the paper describes: generate salient questions, then retrieve per question and synthesise.

### 2.8 Schema changes

The existing `memories` table is close. Additions:

```sql
-- Additive migration, matching the existing PRAGMA table_info pattern.
ALTER TABLE memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'episodic';
  -- 'episodic' | 'semantic' | 'procedural'
ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 0.7;
ALTER TABLE memories ADD COLUMN source_turn TEXT;        -- conversation row id
ALTER TABLE memories ADD COLUMN valid_from TEXT;         -- bi-temporal, à la Zep
ALTER TABLE memories ADD COLUMN valid_to TEXT;           -- NULL = still true
ALTER TABLE memories ADD COLUMN last_confirmed_at TEXT;  -- user re-affirmed it
ALTER TABLE memories ADD COLUMN embedding_model TEXT;    -- which embedder wrote `vector`

-- Migrate the existing `kind` values into memory_type:
--   fact/preference/person/project/place -> semantic
--   conversation/event/note/task          -> episodic
--   decision                              -> procedural

CREATE TABLE reflection_sources (
  reflection_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  memory_id     TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  PRIMARY KEY (reflection_id, memory_id)
);
```

`embedding_model` is not optional. The moment you swap the feature-hashing embedder for a real one (§3), every existing `vector` BLOB becomes garbage, and without this column you cannot tell which rows need re-embedding.

**Also add `access_count` semantics.** `src/lib/core/store.ts:2152` already returns `"recalled before"` when `accessCount > 2`. Increment `access_count` and set `last_accessed_at` on every *surfaced* memory, but only after the reply is sent — otherwise a failed request pollutes the recency signal.

---

## 3. Embeddings

### 3.1 What the current embedder costs you

`src/lib/core/vector.ts` implements signed feature hashing over unigrams, bigrams, and character trigrams into 384 dimensions. Its own header is honest about the tradeoff: "lexical similarity is captured exactly, near-misses are caught by the char-ngram channel."

The char-trigram channel gives typo tolerance. It does **not** give synonymy, and that is the expensive gap for a memory system:

| User says | Stored memory says | Hash embedder | Real embedder |
|---|---|---|---|
| "my car broke down" | "the vehicle needs a new alternator" | no match | strong match |
| "how's the Lisbon trip coming" | "book flights to Portugal in May" | no match | strong match |
| "I'm wiped" | "sleep debt has been accumulating" | weak | moderate |
| "Aurora deck" | "Aurora deck" | exact | exact |

The third and fourth rows are why the hybrid design (§3.4) is right: lexical wins on rare tokens and proper nouns; dense wins on paraphrase. Neither is optional.

### 3.2 Model comparison

**[VENDOR CLAIM / MIXED]** for MTEB numbers — read the caveats first.

> **Methodological warning.** MTEB scores are **not comparable across MTEB versions.** MTEB v1 vs v2 differ in task set, language coverage, and aggregation, and v2 includes harder retrieval and multilingual tasks such that many models score substantially lower on v2 than their widely-quoted v1 number. Vendor blog posts frequently quote whichever is higher. Any table below with an unverified figure is marked **[VERIFY]** and must be checked against the live [MTEB leaderboard](https://huggingface.co/spaces/mteb/leaderboard) with the version and task subset noted. The dimensions, context lengths, and licences are stable facts; the scores are the soft part.

| Model | Dims | Context | ~ONNX size | MTEB | Licence | Prefix needed | Notes |
|---|---|---|---|---|---|---|---|
| `all-MiniLM-L6-v2` | 384 | 256 tok | ~23 MB (int8) / ~90 MB fp32 | ~56 avg (v1) **[VERIFY]** | Apache-2.0 | none | The default. 256-token cap is the real limit for memory entries. |
| `all-MiniLM-L12-v2` | 384 | 256 | ~33 MB int8 | slightly above L6 | Apache-2.0 | none | 12 layers; ~2× slower, marginal gain. |
| `bge-small-en-v1.5` | 384 | 512 | ~34 MB int8 | ~62 avg (v1) **[VERIFY]** | MIT | **query:** "Represent this sentence for searching relevant passages:" on the *query* only | Consistently the best small English model in its class. |
| `bge-base-en-v1.5` | 768 | 512 | ~110 MB int8 | ~63–64 **[VERIFY]** | MIT | same as above | Diminishing returns vs small; 2× storage. |
| `gte-small` | 384 | 512 | ~34 MB | ~61 **[VERIFY]** | MIT | none | Competitive with bge-small; no prefix footgun. |
| `gte-base` | 768 | 512 | ~110 MB | ~63 **[VERIFY]** | MIT | none | |
| `multilingual-e5-small` | 384 | 512 | ~120 MB (multilingual vocab) | ~58 **[VERIFY]** | MIT | **"query: " / "passage: "** required | Use if any non-English content exists. |
| `paraphrase-multilingual-MiniLM-L12-v2` | 384 | 128 | ~120 MB | lower | Apache-2.0 | none | 128-token cap is too short for memory entries. |
| `nomic-embed-text-v1.5` | 768 | **8192** | ~270 MB | strong on long context **[VERIFY]** | Apache-2.0 | **"search_query: " / "search_document: "** | Matryoshka — truncatable. Long context matters for whole-document notes. |
| `EmbeddingGemma-300M` | **768**, Matryoshka-truncatable (512/256/128) | 2048 | ~200 MB int8 (300M params) | SOTA-class for its size **[VENDOR CLAIM]** | Gemma licence (check terms) | task-specific prompts | Google, Sept 2025. Explicitly designed for on-device. |
| `snowflake-arctic-embed-s/m` | 384 / 768 | 512 | — | competitive **[VERIFY]** | Apache-2.0 | query prefix on *some* variants | |
| `jina-embeddings-v3` | 1024 | 8192 | large | strong | CC-BY-NC-4.0 | task LoRA | **Non-commercial licence — check before shipping.** |

**[EVIDENCE]** for `EmbeddingGemma`'s *existence, 300M parameter count, 768-dim output, Matryoshka truncation, 2048-token context, and on-device positioning*: [Google Developers Blog](https://developers.googleblog.com/en/introducing-embeddinggemma/), [DeepMind model page](https://deepmind.google/models/gemma/embeddinggemma/).

**Recommendation for Xana: `bge-small-en-v1.5` (384-dim) or `gte-small` (384-dim).**

Reasoning: both keep Xana's existing `EMBED_DIM = 384`, which means `encodeVector`/`decodeVector` (`src/lib/core/store.ts:99`) and every stored BLOB's *width* stay valid — you only need to re-embed, not re-schema. `bge-small` is MIT-licensed, ~34 MB int8, and has the strongest small-model reputation. `gte-small` avoids the query-prefix footgun entirely; **if you choose bge, the prefix is mandatory on queries and forgetting it silently degrades retrieval** — which is exactly the kind of bug that looks like "the model is bad."

Do **not** reach for a 768-dim model unless you have measured that 384 is the bottleneck. For a single user with thousands of memories, 768 dims doubles storage and compute for a gain you are unlikely to notice.

### 3.3 How to run it in Node, offline

Ordered by fit for Xana:

**(a) `@huggingface/transformers` (transformers.js v3) — recommended.**
**[EVIDENCE]** — the package exists and provides a `feature-extraction` pipeline with ONNX Runtime under the hood. **[VERIFY]** — I could not retrieve the v3 docs page in this session for the exact `dtype` option names (`fp32`/`fp16`/`q8`) and the Node-specific notes.

Shape of the code:

```ts
import { pipeline } from "@huggingface/transformers";
const extract = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5", {
  dtype: "q8",           // [VERIFY] exact option name/values in v3
});
const out = await extract(["Represent this sentence for searching relevant passages: " + query], {
  pooling: "mean", normalize: true,
});
```
Then implement `Embedder` from `src/lib/core/vector.ts` — the interface is `{ id, dim, embed(text): number[] }` and the header notes "dropping in an API-backed model later is a one-line swap." That claim holds: `MemoryStore` takes any `Embedder`.

**Two Next.js gotchas that will cost you an afternoon:**

1. **Add to `serverExternalPackages` in `next.config.ts`.** Native `.node` binaries and dynamic `require` of model files must not be bundled by the server compiler. **[EVIDENCE]** — [Next.js docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverExternalPackages). Xana runs Next 16 and already has a `next.config.ts`, so this is a two-line change.
2. **Model download happens at first use by default** and needs the network — which breaks the "works with zero API keys" promise on first run. Vendor the ONNX files into the repo (or a `models/` directory resolved via an absolute path) and point the pipeline at the local path. Xana already does this pattern for the STT model: `locateTranscriber()` / `newestModelDir()` in `src/lib/stt/supervisor.ts` resolve a local model directory. **Reuse that pattern rather than inventing a second one.**

Also note `type: "module"` is set in `package.json`; keep the import ESM-native.

**(b) `onnxruntime-node` directly.** More control, no HF wrapper, but you own tokenisation (you need a `tokenizers` binding or a hand-rolled WordPiece) and pooling. Not worth it unless (a) fails.

**(c) `fastembed` (Qdrant).** Strong Python/Rust story with a curated model list. **[VERIFY]** — I could not confirm a maintained first-party JS binding in this session; do not assume one exists. If you want FastEmbed, the realistic option is running its service alongside.

**(d) Ollama / llama.cpp HTTP server.** Simplest possible integration — POST to `/api/embed` or `/v1/embeddings` — and it keeps the embedder out of your Node process entirely. Costs you a second process to supervise, but Xana **already supervises a local Python STT service** (`src/lib/stt/supervisor.ts`, `TRANSCRIBER_PORT`, health checks, cooldowns). If you are willing to run two sidecars, this is the lowest-risk path and gives you `nomic-embed-text` (8192 context) for free.

**(e) `node-llama-cpp`.** Supports embeddings and is well-maintained. Heavier dependency; only worth it if you also want local generation.

**A note on the swap itself.** The `Embedder` interface is synchronous (`embed(text): number[]`). A transformer inference is async. Either make the interface async (touches `recall`, which is called from `src/lib/context/gateway.ts:166`, and any other caller) or run inference in a worker and block. **Prefer making it async** — a synchronous 20 ms block per recall inside a Next.js route handler is worse than the refactor.

### 3.4 BM25, hybrid, and RRF: how much do they actually buy?

**The BEIR finding is the load-bearing one.** **[EVIDENCE]** — Thakur et al., *BEIR: A Heterogenous Benchmark for Zero-shot Evaluation of Information Retrieval Models*, [arXiv:2104.08663](https://arxiv.org/abs/2104.08663). BEIR's headline conclusion is that **BM25 is a remarkably strong zero-shot baseline and dense models — including ones that dominate in-domain — generalise worse out-of-domain.** The commonly cited average nDCG@10 for BM25 across BEIR is ~0.44, with many dense models below it on average despite winning on in-domain MS MARCO. **[VERIFY]** the exact per-dataset and average figures from the paper's tables before quoting them. A later paper tabulates BM25 at 0.426 BEIR / 0.137 BRIGHT ([arXiv:2412.14405](http://export.arxiv.org/pdf/2412.14405)) — consistent with, and independently corroborating, that range.

**Why this matters enormously for Xana:** they are the *zero-shot, out-of-domain* case. A personal memory store has no in-domain training set, no relevance labels, and queries that share vocabulary with the stored text ("Aurora", "Dr Reyes", "the Lisbon trip"). This is precisely the regime where BM25 is strongest and dense retrieval is weakest. **Adding a lexical channel is not a fallback; it is the primary retrieval mechanism for rare tokens and proper nouns.**

**Anthropic's measurements are the cleanest available evidence on stacking.** **[EVIDENCE]** — [Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval), evaluated as `1 − recall@20` (percentage of relevant documents *not* retrieved in the top 20), averaged across codebases, fiction, ArXiv, and science papers:

| Configuration | Failure rate | Reduction |
|---|---|---|
| Baseline (embeddings only) | 5.7% | — |
| + Contextual Embeddings | 3.7% | 35% |
| + Contextual BM25 (hybrid) | 2.9% | **49%** |
| + Reranking (top-150 → top-20) | **1.9%** | **67%** |

Their explicit conclusions: "Embeddings+BM25 is better than embeddings on their own"; "Reranking is better than no reranking"; and **"All these benefits stack."** The hybrid step alone bought a 35% reduction in failures. Note the mechanism they give for *why* BM25 helps — the "Error code TS-999" example: "An embedding model might find content about error codes in general, but could miss the exact 'TS-999' match." That is the same failure mode as a hash embedder's weakness, which is a coincidence worth noticing: a lexical channel is the fix in both cases.

Their implementation detail to copy: **contextual prefixes.** They prepend 50–100 tokens of chunk-specific context before embedding *and* before BM25 indexing, generated by prompting the model with the whole document plus the chunk:

> "Please give a short succinct context to situate this chunk within the overall document for the purposes of improving search retrieval of the chunk. Answer only with the succinct context and nothing else."

For Xana the analogue is cheaper than for documents: **a memory entry is usually small enough that the whole conversation turn is the "document."** So generate the contextual prefix from the turn, not a whole file. One-time cost, permanent retrieval gain.

**Reciprocal Rank Fusion.** **[EVIDENCE]** for the method and its origin — Cormack, Clarke & Buettcher, *Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods*, SIGIR 2009 ([ACM DL](https://dl.acm.org/doi/10.1145/1571941.1572114); [author's PDF](http://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf)).

```
RRF(d) = Σ_over_rankers  1 / (k + rank(d))      k = 60
```

Why RRF is the right choice for Xana specifically, rather than a weighted score blend:

- **It needs no score normalisation.** Xana's current blend mixes a cosine (unbounded-ish, clustered), a lexical overlap fraction, a salience, and a decay — combining them linearly is dimensionally incoherent (§2.6, item 3). RRF only uses *ranks*, so incommensurable scorers combine correctly. This is the single best argument for it here.
- **It is tuning-free.** The original paper's title is literally the claim: RRF beat Condorcet and individual rank-learning methods *without* training. k=60 is the standard smoothing constant; larger k flattens the contribution of top ranks.
- **It is ~10 lines of TypeScript** and has no dependencies.

The cost: RRF discards magnitude information. A memory that is a perfect match at rank 1 and a weak match at rank 1 contribute identically. In practice, for a few thousand memories, this does not matter, and the robustness is worth more than the lost signal. If you want both, use RRF to build a candidate set of 50 and then apply the normalised weighted blend as a reranker over those 50 — this is the "combine, then rerank" pattern Anthropic measured.

**On rerankers.** Cross-encoders (`bge-reranker-base`, `ms-marco-MiniLM-L-6-v2`) score a (query, document) pair jointly and beat bi-encoders, at the cost of one forward pass per candidate. **[EVIDENCE]** for the class of technique and for Anthropic's 2.9% → 1.9% measurement; **[VERIFY]** specific model-level numbers. For Xana, **defer this**: cross-encoder inference in Node is a second ONNX model and a second latency budget. It is a phase-3 optimisation after the lexical channel exists.

### 3.5 Implementation note for Xana

Concrete sequence, each step independently shippable:

1. **Add SQLite FTS5 and a BM25 channel.** `better-sqlite3` ships FTS5. Create `CREATE VIRTUAL TABLE memories_fts USING fts5(title, content, entities, content='memories', content_rowid='rowid')` with triggers to stay in sync, then `bm25(memories_fts)` ranked. This requires **zero new dependencies**, works offline, and is the highest-value change in §3. Note `tokenize` in `src/lib/core/vector.ts` currently keeps `+#.-` characters — FTS5's `unicode61` tokenizer with `tokenchars='+#.'` preserves `C++`, `C#`, `v1.5`.
2. **Fuse with RRF** over the existing vector ranking and the new BM25 ranking, k=60. Replace the linear blend at `src/lib/core/store.ts:802`.
3. **Then swap the embedder** to `bge-small-en-v1.5` via transformers.js, add `embedding_model` tracking, and backfill. Because step 2 already made fusion rank-based, the embedder swap does not require re-tuning any weights — which is the practical payoff of choosing RRF.
4. **Add `sqlite-vec` only when the scan hurts.** **[VERIFY]** — `sqlite-vec` (asg017) provides a `vec0` virtual table with KNN queries and supports float/int8/bit vector types, and a `rescore` ANN index feature appears in recent PRs ([KNN docs](https://github.com/asg017/sqlite-vec/blob/main/site/features/knn.md), [PR #276](https://github.com/asg017/sqlite-vec/pull/276)). I could not confirm current production-readiness claims or exact `distance_metric` syntax. **At Xana's scale the honest answer is that you probably do not need it**: 384 dims × 4 bytes × 20,000 memories = ~30 MB, and a JS cosine loop over 20,000 rows is single-digit milliseconds. Measure first. `sqlite-vec` also needs native extension loading, which `better-sqlite3` allows but which adds a Windows build/ABI dependency — the one thing most likely to break a zero-config local install.

---

## 4. Proactive and ambient behaviour

### 4.1 The foundations are HCI papers, and they are older than the LLM era

**Horvitz's decision-theoretic framework is still the correct formalisation.** **[EVIDENCE]** — Horvitz, *Principles of Mixed-Initiative User Interfaces*, CHI 1999. The core is that a proactive system should act when expected utility is positive, weighing the value of the information against the cost of the interruption:

```
E[U] = P(relevant | context) · Benefit − (1 − P(relevant | context)) · Cost_of_interruption
```

and act only when `E[U] > 0`. **[VERIFY]** the exact notation against the paper; the *structure* — probability-weighted benefit minus probability-weighted interruption cost — is the part that matters and is reproduced consistently across the follow-on literature, including a 2025 formulation in [arXiv:2505.10831](https://arxiv.org/abs/2505.10831):

```
E[U_interrupt] = P(τ_i | G) · B + (1 − P(τ_i | G)) · (−C_FP)
```

i.e. expected utility of interrupting equals the probability the timing is right times the benefit, minus the probability it is wrong times the cost of a false positive. **This is directly implementable** and is the basis of the scoring formula in §4.4.

**Interruption genuinely costs a lot.** **[EVIDENCE]** for the papers; **[VERIFY]** the specific numbers, which are widely cited and worth checking before they appear in UI copy:

- Iqbal & Horvitz, *Disruption and Recovery of Computing Tasks*, CHI 2007 ([ACM](https://dl.acm.org/doi/10.1145/1240624.1240730)) — the source of the famous ~23-minute resumption figure.
- Mark, Gudith & Klocke, *The Cost of Interrupted Work: More Speed and Stress*, CHI 2008 ([ACM](https://acm-stag.literatumonline.com/doi/10.1145/1357054.1357072)) — the counterintuitive finding that interrupted work was completed *faster*, but with higher stress and effort. **The lesson is that interruption cost is not only time; it is stress and error rate.** A user who finishes faster and more stressed is not being helped.

**Interruptibility is predictable.** **[EVIDENCE]** — Fogarty, Hudson et al., *Predicting Human Interruptibility with Sensors*, ACM ToCHI 2005 ([ACM](https://dl.acm.org/doi/10.1145/1057237.1057243)). Sensors (activity, speech, keyboard) predicted interruptibility well above chance. **[VERIFY]** the reported accuracy figure.

**The actionable synthesis for Xana:** interruptibility in a local assistant is *cheaply observable* without sensors, because you have the calendar, the health log, focus sessions, and the time of day. You do not need a classifier; you need a deterministic score.

### 4.2 Notification fatigue: the failure mode is arithmetic, not psychology

Two hard facts:

- **Volume destroys signal.** Every additional low-value notification trains the user to ignore all of them. Xana's existing hard cap of 5 (`src/lib/derived/nudges.ts:366`) is the right instinct.
- **Anthropic's 13.6% figure (§1.1)** is the quantitative proof that prompt/notification fatigue converts a safety mechanism into a formality. **[EVIDENCE]** for the study as reported; the same arithmetic applies to nudges: a nudge the user reflexively dismisses has *negative* value, because it costs attention and returns nothing.

### 4.3 What makes a proactive suggestion useful

**[OPINION]** — these are design rules synthesised from the above, not measured results. They are stated as rules because they are actionable; treat the ordering as taste, not science.

1. **Actionable now, or silent.** If the user cannot act on it in the next few minutes, it belongs in a briefing, not a nudge. Xana already encodes this well: every `Nudge` carries an optional `ActionIntent` (`src/lib/core/types.ts:600`) so the UI offers one-tap resolution. The rule to add: **a nudge with no action, and no imminent deadline, is a briefing item.**
2. **Time-critical and irreversible first.** Xana's documented ordering principle — "time-critical and irreversible first, then things that decay if ignored, then encouragement" and "Never more than five" — matches both the utility formulation and the attention literature. Keep it, and make it explicit in code as a tier rather than only a numeric priority.
3. **Silence is a feature.** Track the count of days with zero nudges as a healthy metric, not a failure.
4. **Every nudge must explain itself.** "Why am I seeing this?" attached to each item. This costs nothing to implement (the generator knows its own rule) and converts a mysterious interruption into a legible one. It also makes bug reports actionable.
5. **Batch by default, interrupt by exception.** A morning briefing that contains five items is one interruption. Five separate notifications is five. Same information, 5× the cost.
6. **Never interrupt with something the user just told you.** Suppress a nudge whose condition the user addressed in the last *N* minutes. This is a trivially cheap guard against the most enraging failure mode.

### 4.4 A concrete score for "should I speak now?"

Combining Horvitz's structure with signals Xana already computes:

```
speakScore(nudge) =
      value(nudge)                 // base priority, already present (0..100)
    * pRelevant(now)               // context fit (see below)
    * actionability(nudge)         // 1.0 if it carries a resolvable ActionIntent, else 0.4
    − interruptionCost(now)
```

```ts
// Deterministic, cheap, and testable without a model — same philosophy as nudges.ts today.
function pRelevant(now: Date, ctx: LifeState): number {
  let p = 0.5;
  if (ctx.inMeeting)         p *= 0.15;   // never interrupt a meeting
  if (ctx.focusSessionActive) p *= 0.20;
  if (isQuietHours(now))      p *= 0.05;  // 22:00–07:00, user-configurable
  if (ctx.lastInteractionWithinMinutes < 10) p *= 0.6; // they're already here
  if (ctx.freeMinutes >= 15) p *= 1.4;
  return clamp(p, 0, 1);
}

function interruptionCost(now: Date, ctx: LifeState): number {
  let c = 10;
  if (ctx.inMeeting)          c += 40;
  if (ctx.focusSessionActive) c += 30;
  if (isQuietHours(now))      c += 50;
  return c;
}
```

Then: **speak iff `speakScore > threshold`**, with the threshold itself adaptive (§4.5). The meeting/quiet-hours multipliers are the important part — they encode "some moments are never right" as a multiplicative probability, which is more honest than a penalty.

**Breakpoint timing** is the refinement to add later: interruptions at natural task boundaries are less disruptive (Iqbal & Bailey). In Xana the natural breakpoints are observable: the end of a calendar event, the end of a focus session, app open, and morning start. **[EVIDENCE]** for the breakpoint finding; **[VERIFY]** the paper and effect size.

### 4.5 Feedback, budgets, and drift

**Notification budget as a first-class policy, not a hardcoded cap.**

```ts
interface NudgePolicy {
  dailyMax: number;          // default 5 — Xana's current behaviour
  quietHours: [number, number];  // [22, 7]
  perCategoryDailyMax: number;   // stops one noisy rule monopolising the budget
  minScore: number;              // adaptive
  batchWindowMinutes: number;    // coalesce within this window
}
```

`perCategoryDailyMax` is the fix for the failure where one badly-tuned rule consumes all five slots every day.

**Adaptive threshold from explicit feedback.** Add `nudge_feedback(nudge_id, at, signal)` where signal ∈ `acted | dismissed | snoozed | ignored`. Update the threshold with a simple online rule:

```
threshold ← threshold + η · (dismissed ? +1 : acted ? −1 : 0)
```

with η small (e.g. 0.5 score points) and the threshold clamped to `[minScore, 100]`. **`ignored` (no response within the nudge's relevance window) is the strongest negative signal** and the one most systems fail to record — it is the only signal that captures "you showed me this and I did not care." Log it with a scheduled sweep, not user action.

**Metrics that actually tell you if it is working:**

| Metric | Target direction | Why |
|---|---|---|
| Action rate (`acted / shown`) | up | The only real measure of usefulness |
| Dismissal rate | down | Explicit rejection |
| Ignore rate | down | Implicit rejection; the honest one |
| Nudges shown per day | flat or down | Volume creeps; watch it |
| Days with zero nudges | up | Silence is health |
| Time-to-action after nudge | down | Measures timeliness |

**Drift detection on goals** — Xana already computes the right primitive and should extend it rather than replace it:

- **Required rate**: `remaining / daysRemaining`. **Actual rate**: `progressMade / daysElapsed`. Ratio > 1 means catching up.
- **Replace the fixed ±0.15/−0.12 bands** (`src/lib/derived/goals.ts:96`) with an **EWMA of progress velocity**, so pace reflects trend rather than a snapshot: `v_t = α·Δprogress + (1−α)·v_{t−1}`, α ≈ 0.3. Compare the EWMA against the required rate. This eliminates the current noise sensitivity, where one milestone completion swings the label from `slipping` to `ahead`.
- **Three-state classification with hysteresis.** Current labels are `ahead / on-track / slipping / stalled / not-started` — good vocabulary (the code comment on `not-started` is exactly right: "a goal can only be on track if it has left the station"). Add hysteresis so a goal does not oscillate daily: require the state to hold for 2 consecutive evaluations before it changes, or use separate entry/exit thresholds.
- **Buffer consumption** as the risk measure: `bufferRemaining = daysRemaining − (remainingWork / observedVelocity)`. Negative buffer is the real "off track" signal, and unlike a percentage it has units the user understands ("you are about 9 days behind"). **[OPINION]** on the specific formula; it is the critical-chain buffer metric applied to goals.
- **Never nudge on drift twice in a row with the same wording.** Deduplicate on `(goalId, state)` and require a state *change* or ≥7 days before re-raising.

### 4.6 Scheduler design for a local-first app

Xana is a Next.js app, so there is no always-on worker by default. Three viable shapes:

1. **In-process scheduler on first request.** Keep a module-level singleton with `setInterval` (e.g. 15 min) plus a `lastRunAt` persisted in SQLite. On each tick, run any due job. Advantage: no extra process, works with the existing dev/start scripts. Disadvantage: does not run while the app is closed.
2. **Catch-up on boot.** The essential complement to (1). Store `next_due_at` per job in a `jobs` table; at startup, run every job whose `next_due_at` has passed, **once**, with a "missed" flag so the content can be re-framed ("while you were away"). Without catch-up, a laptop that was asleep produces a week of silence and then a burst.
3. **External scheduler** (Windows Task Scheduler) hitting an authenticated local endpoint. Most reliable for a morning briefing at a fixed wall-clock time. Xana already has authenticated local routes (`src/app/api/*`), so this is a curl away.

```sql
CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,   -- 'nightly_reflection', 'morning_briefing', 'drift_sweep'
  next_due_at  TEXT NOT NULL,
  last_run_at  TEXT,
  last_status  TEXT,                   -- 'ok' | 'failed' | 'skipped'
  last_error   TEXT,
  catch_up     INTEGER NOT NULL DEFAULT 1,
  enabled      INTEGER NOT NULL DEFAULT 1
);
```

**Timezone handling must go through the existing zone module.** `src/lib/core/zone.ts` pins `APP_TIME_ZONE = "Asia/Shanghai"` and provides `dateKeyInZone`, `startOfDayInZone`, `hourInZone`, etc. **Do not compute "today" or "7am" with `new Date()` anywhere in a scheduler** — use `startOfDayInZone` / `addDaysInZone`. This is the single most common source of off-by-one-day bugs in briefing features, and Xana already solved it; the risk is a new scheduler file that forgets to.

**Job idempotency**: key each run on `(name, dateKeyInZone(runAt))` so a double-triggered tick cannot produce two briefings. Same mechanism as §1.2(d).

**Nightly reflection and morning briefing shapes:**

- *Nightly (23:30 local)*: score the day's memories, run the Generative Agents salience-sum trigger (§2.7), write `kind='reflection'` memories with citation links, update goal velocity EWMAs, then compute tomorrow's nudges and *store them as pending* rather than delivering.
- *Morning (07:00 local)*: deliver the pending set through the §4.4 score, capped by the budget. If nothing cleared the threshold, say so — "nothing needs you today" is a valuable, trust-building message and it is only credible if silence is a real outcome.

---

## 5. Goal and plan reasoning

### 5.1 OKRs, from the primary source

**[EVIDENCE]** — [Google re:Work, *Set goals with OKRs*](https://rework.withgoogle.com/intl/en/guides/set-goals-with-okrs). The rules that matter for implementation:

- **3–5 objectives**, each with **≤5 key results**.
- **Key results are outcomes, not tasks.** "Launch feature X" is not a key result; "increase activation to 40%" is. This is the single most-violated rule and the one an assistant can helpfully enforce at creation time.
- **Grading is 0.0–1.0, and 0.7 is "good."** The explicit purpose is to make ambitious goals safe to set. A goal scored 1.0 consistently means the target was too easy.
- **Cadence: annual + quarterly, with weekly check-ins.** The weekly check-in is the hook for §5.5.
- **OKRs are not performance reviews.** Doerr's framing (via the playbook) is that separating them prevents sandbagging.

Xana's `Goal` already has `horizon`, `why`, `targetDate`, `milestones`, `progressOverride`, `area`, `cadence` (`src/lib/core/types.ts:357`). The `why` field is the notable one — OKR literature emphasises *why*, and it is the field the model should read when the user is stalling.

### 5.2 Where goal-setting goes wrong — and why the assistant should care

**[EVIDENCE]** — Ordóñez, Schweitzer, Galinsky & Bazerman, *Goals Gone Wild: The Systematic Side Effects of Overprescribing Goal Setting*, Academy of Management Perspectives 2009. The documented side effects: narrowed focus that neglects non-goal areas, distorted risk preferences, motivated gaming and cheating, and damage to intrinsic motivation. This is the counterweight to Locke & Latham and it belongs in the design: an assistant that relentlessly optimises a metric will push the user toward exactly these failure modes.

**[EVIDENCE]** — Locke & Latham's goal-setting theory ([*Building a Practically Useful Theory of Goal Setting and Task Motivation*, American Psychologist 2002](https://psycnet.apa.org/)): specific, difficult goals produce higher performance than vague or easy ones, and goal commitment plus feedback are necessary conditions. **[VERIFY]** the effect sizes.

**Design implication, and it is a strong one:** the assistant should be able to say "this key result is unmeasurable, so I cannot track it — can we rewrite it?" That is a *useful* refusal, it is grounded in both literatures, and it is impossible to do if the assistant only ever says yes.

Xana's `progressOverride` field is a Goodhart risk made explicit: a manual knob that decouples displayed progress from milestone reality. **Keep it, but surface it.** When `progressOverride` is set, the UI and the model should both know that progress is asserted rather than derived, and the reflection should not celebrate it.

### 5.3 Weekly review and the six horizons

**[EVIDENCE]** — David Allen's Getting Things Done framework ([Getting Things Done](https://gettingthingsdone.com/)). Two components are directly implementable:

**The weekly review** — the ritual that keeps a trusted system trusted. Its content: gather loose ends, process inboxes to zero, review the project list, review the calendar (past and future), review someday/maybe, and re-commit to next actions.

**The six horizons of focus**, which map cleanly onto a goal hierarchy:

| Horizon | Scope | Xana mapping |
|---|---|---|
| Runway | Current actions | `Task` |
| 1–2 years | Projects | `Goal` with `horizon: 'quarterly'`/`'yearly'` |
| 3–5 years | Areas of focus | `Goal.area` |
| Purpose & principles | Why | `Goal.why` |

Xana's `Goal.horizon` and `Goal.area` fields already carry this structure. The gap is that nothing *rolls up* — a task does not declare which goal it serves, so the weekly review cannot say "you completed 14 tasks this week and none of them advanced your stated goals." **Adding an optional `Goal` link to tasks (or inferring it from `project`/`area`) unlocks the most valuable single insight the assistant can offer.**

Other GTD mechanics worth encoding: the **two-minute rule** (surface as a nudge action: "this is a 2-minute task, do it now?"), and **next-action thinking** (a task titled "plan the trip" is a project, not an action — flag it).

### 5.4 Implementation intentions: the highest-leverage evidence in this section

**[EVIDENCE]** — Gollwitzer, *Implementation Intentions: Strong Effects of Simple Plans*, American Psychologist 1999, and the meta-analysis Gollwitzer & Sheeran, *Implementation Intentions and Goal Achievement: A Meta-analysis of Effects and Processes*, [Advances in Experimental Social Psychology 2006](https://www.sciencedirect.com/science/chapter/bookseries/abs/pii/S0065260106380021). The **if–then** format — "if situation X arises, then I will perform behaviour Y" — produces a **medium-to-large effect on goal attainment (d ≈ 0.65)** across 94 independent tests. **[VERIFY]** the exact d and study count; the "medium-to-large" characterisation is consistent across sources.

This is the strongest evidence-backed technique in the entire report, and it is nearly free to implement: **every goal and milestone the assistant helps create should be paired with an if–then trigger.** "If it is Sunday at 18:00, then I will do the weekly review." "If I open my laptop on a weekday morning, then I will work on Aurora for 45 minutes before email."

Structure it as data, not prose:

```sql
CREATE TABLE implementation_intentions (
  id         TEXT PRIMARY KEY,
  goal_id    TEXT REFERENCES goals(id) ON DELETE CASCADE,
  milestone_id TEXT,
  cue_kind   TEXT NOT NULL,   -- 'time' | 'event' | 'location' | 'context' | 'existing_habit'
  cue_spec   TEXT NOT NULL,   -- JSON: {"weekday":0,"hour":18} or {"after":"open_laptop"}
  action     TEXT NOT NULL,   -- "do the weekly review"
  created_at TEXT NOT NULL,
  last_fired_at TEXT,
  hit_count  INTEGER NOT NULL DEFAULT 0,
  miss_count INTEGER NOT NULL DEFAULT 0
);
```

`cue_kind` includes `existing_habit` deliberately — anchoring a new behaviour to an established one is the "habit stacking" idea, which is **[OPINION]/popular practice** rather than established research, but it is a reasonable default to offer and the table records `hit_count` so the user can see whether it works for them.

### 5.5 Habit formation and progress monitoring

**[EVIDENCE]** — Lally et al., *How are habits formed: Modelling habit formation in the real world*, European Journal of Social Psychology 2010 ([BPS summary](https://www.bps.org.uk/research-digest/how-form-habit)). Headline: automaticity took a **median of 66 days**, with a very wide range (**18 to 254 days**), and missing a single opportunity did not measurably harm the habit-formation curve. **[VERIFY]** the exact figures.

The wide range and the missing-a-day finding matter: **a streak-based UI that punishes a single lapse contradicts the evidence.** Xana has streak machinery (`computeStreaks`, `src/lib/core/store.ts:2115`) and habit consistency (`consistency()` in `src/lib/derived/habits.ts`). Recommend:

- Keep streaks, but make the *primary* displayed metric **rolling consistency over 28 days** (which `consistency(habits, weeks)` already computes) rather than the current streak. Rolling consistency is lapse-tolerant and therefore honest about the 18–254-day reality.
- Support **"never miss twice"** in the UI: after one lapse, an encouraging prompt rather than a broken-chain warning. **[OPINION]** on the phrasing, but it aligns with the Lally finding that single lapses are normal.

**[EVIDENCE]** — Harkin et al., *Does monitoring goal progress promote goal attainment? A meta-analysis of the experimental evidence*, Psychological Bulletin 2016 ([APA](https://psycnet.apa.org/doiLanding?doi=10.1037%2Fbul0000025)). Monitoring goal progress produced a **significant positive effect on attainment**, with moderators including **frequency of monitoring** and **public vs private** reporting. **[VERIFY]** the exact effect size and moderator directions.

This is the empirical justification for the whole progress-tracking feature set, and it gives one concrete design rule: **prompting frequent monitoring helps, but only if the monitoring is easy.** Any friction in logging progress (a modal, a required field, a page navigation) directly attacks the mechanism. Xana's one-tap `ActionIntent` model is the right implementation.

### 5.6 What LLMs are actually good and bad at here

**LLMs decompose plausibly but plan unreliably.** The evidence is consistent and unfavourable:

- **[EVIDENCE]** — Valmeekam et al., *On the Planning Abilities of Large Language Models* / PlanBench, [arXiv:2206.10498](https://arxiv.org/abs/2206.10498): LLMs perform poorly at generating and verifying plans in formal domains, and degrade sharply as plan length grows. **[VERIFY]** exact success rates, which vary wildly by model generation and should be quoted with the model named.
- **[EVIDENCE]** — Xie et al., *TravelPlanner*, [arXiv:2402.01622](https://arxiv.org/abs/2402.01622): even strong models achieved very low end-to-end success rates on realistic multi-constraint planning. **[VERIFY]** the reported figure; the paper's headline number is low and model-dependent.
- **[EVIDENCE]** — Huang et al., *LLM+P*, [arXiv:2304.11477](https://arxiv.org/abs/2304.11477): the fix is to let the LLM *translate the problem into a formal language* (PDDL) and then have a **classical planner** solve it. The LLM handles ambiguity and natural language; the solver guarantees correctness.

**The operational rule that follows, and it is the most important idea in §5:**

> **Let the model propose structure. Let deterministic code verify it. Never let the model assert progress.**

Xana already embodies this in intent resolution and in `guardUnmadeClaim`. Apply the same split to goals:

- **Model's job:** turn "I want to get fitter this year" into candidate milestones and if–then triggers, and flag key results that are not measurable. This is a language task and LLMs are good at it.
- **Deterministic code's job:** compute progress, pace, buffer, and drift — always from `milestones` and timestamps, never from a model's summary of the conversation. `computeGoalProgress` already does this correctly. **Do not add a code path where a model writes `progressOverride`.**
- **Verification layer:** reject a decomposition that has no measurable milestone, no target date, or more than 5 milestones per goal (the OKR rule). Rejection messages should explain which rule failed — the user learns the framework rather than fighting the tool.

This is "keep the user in control" implemented structurally rather than by asking nicely in a prompt. The user approves the decomposition, edits any milestone, and can always override; the model never silently changes a number the user is tracking.

**Concrete decomposition prompt shape** (two-stage, mirroring Generative Agents' question-then-synthesise pattern):

```
Stage 1 — clarify (only if `why` is empty or the target is unmeasurable):
  "Before I break this down: what would be true at the end that isn't true now,
   and by when? One sentence each."

Stage 2 — propose, in strict JSON, with a self-check:
  Given goal: "<title>", why: "<why>", target: <date>, area: <area>.
  Return 3-5 milestones. Each must have:
    - title (an outcome, not an activity)
    - measurable: true + a `measure` string, OR measurable: false
    - suggestedDate (ISO, before <target>)
    - ifThen: one sentence of the form "If <cue>, then I will <action>."
  Then list any milestone you could not make measurable, and say why.
```
Parsing the second half of that output is what gives you the "useful refusal" from §5.2.

### 5.7 Pace mathematics, for reference

**[EVIDENCE]** for the earned-value formulas (PMI's earned value management); **[OPINION]** for their application to personal goals, which is an analogy.

```
SPI (schedule performance index) = EV / PV        // earned value / planned value
CPI (cost performance index)     = EV / AC        // earned value / actual cost
Estimated duration at completion = plannedDuration / SPI
```

For a goal: `EV` = fraction of milestones done; `PV` = fraction of the timeline elapsed. So **`SPI = progress / elapsedFraction`, which is exactly the comparison Xana's `computeGoalProgress` already performs** (`delta = progress − elapsedFraction`). Expressing it as a ratio rather than a difference is a small improvement because it is scale-free and directly interpretable ("you are at 0.6× the required rate").

```
requiredRate  = (1 − progress) / daysRemaining          // per day
observedRate  = EWMA(Δprogress per day, α = 0.3)
paceRatio     = observedRate / requiredRate
daysBehind    = (1 − progress)/observedRate − daysRemaining   // buffer deficit
```

Classification with hysteresis: `paceRatio ≥ 1.1` → ahead; `≥ 0.9` → on track; `< 0.9` → slipping; no progress in 14 days → stalled; nothing started → not-started. **Require two consecutive evaluations before changing state.**

**Monte Carlo for a completion date** (a genuine improvement over point estimates, and cheap): sample each remaining milestone's duration from the user's own historical distribution for similar milestones, sum 1,000 samples, report P50 and P80. Xana has the completion timestamps needed to build that distribution. Report the **P80** date as the commitment — it is the honest answer to "when will this be done" and it teaches buffer thinking.

---

## 6. Conversation quality

### 6.1 Sycophancy is the primary risk, and it is measurable

This is not a stylistic concern. It is the documented failure mode of RLHF-tuned assistants, and it is what makes an assistant feel hollow.

**[EVIDENCE]** — Sharma et al. (Anthropic), *Towards Understanding Sycophancy in Language Models*, [arXiv:2310.13548](https://arxiv.org/abs/2310.13548). Findings: five state-of-the-art assistants "consistently exhibit sycophancy" across diverse tasks; human preference data can favour sycophantic responses over correct ones; and **preference-model optimisation can systematically trade truth for agreeableness.** **[VERIFY]** the specific percentages per task.

**[EVIDENCE]** — the GPT-4o rollback incident, April 2025. OpenAI's follow-up post [*Expanding on what we missed with sycophancy*](https://openai.com/index/expanding-on-sycophancy/) (2 May 2025) is unusually candid. Their own words, via [Simon Willison's analysis](https://simonwillison.net/2025/May/2/what-we-missed-with-sycophancy/):

> "In the April 25th model update, we had candidate improvements to better incorporate user feedback, memory, and fresher data... **Our early assessment is that each of these changes, which had looked beneficial individually, may have played a part in tipping the scales on sycophancy when combined.**"

> "the update introduced **an additional reward signal based on user feedback—thumbs-up and thumbs-down data**... User feedback in particular can sometimes favor more agreeable responses, likely amplifying the shift we saw."

> "We have also seen that in some cases, **user memory contributes to exacerbating the effects of sycophancy**, although we don't have evidence that it broadly increases it."

Their conclusions: personality and behavioural issues should be launch-blocking; and "One of the biggest lessons is fully recognizing how people have started to use ChatGPT for deeply personal advice... we need to treat this use case with great care."

**Three concrete implications for Xana, and they are uncomfortable:**

1. **Do not train or tune on thumbs-up/down.** OpenAI's own post-mortem implicates exactly that signal. If you add feedback, use it to tune *thresholds and timing* (§4.5), not the model's voice or agreeableness.
2. **Memory can amplify sycophancy.** A memory system that remembers what the user liked hearing will drift toward flattery. Mitigation: store **facts and preferences** ("prefers mornings for deep work"), never **validations** ("user agreed when I said their plan was solid"). Add a write-path filter that rejects candidate memories whose content is an evaluation of the user rather than a fact about them. Xana's `MemoryKind` already has `preference` and `fact` — keep the vocabulary tight and reject `opinion`-shaped content.
3. **Human approval of a suggestion is not evidence the suggestion was right.** The 13.6% study and the sycophancy post-mortem are the same lesson from two directions.

### 6.2 Persona: describe traits, not prohibitions

**[EVIDENCE]** — OpenAI's Model Spec sets out the authority model precisely, and its "Be approachable" section is a traits list rather than a rule list: *Be empathetic, Be kind, Be rationally optimistic, Be engaging, Don't make unprompted personal comments, Avoid being condescending or patronizing.* Its style section is likewise trait-shaped: *Be clear and direct, Be suitably professional, **Be thorough but efficient, while respecting length limits**, Adapt to the user's modality, **Be concise and conversational** (voice), Handle interruptions gracefully.* **[EVIDENCE]** — [Model Spec 2025-04-11](https://model-spec.openai.com/2025-04-11.html).

Two things to steal:

- **The Spec's four authority levels — Platform > Developer > User > Guideline — with "Guideline" instructions overridable *implicitly* by contextual cues.** This is the mechanism that keeps a persona from becoming brittle: state defaults, allow the user to override them by context, and let the model read the room. Xana's `voice.persona` is a single blob (`src/lib/mind/llm.ts:70`); splitting it into an inviolable core and a set of overridable guidelines would make it behave better.
- **"Adapt to the user's modality."** Voice and text want different rules — the Spec has separate voice-mode guidance for concision and handling interruptions. Xana has a `modality` parameter already (`src/lib/mind/index.ts`). **Give voice and text distinct style rules.** A voice reply with bullet points and headers is a failure even if the content is right.

**[EVIDENCE]** for the existence and positioning of Anthropic's *Claude's Character* research (anthropic.com/research/claude-character, June 2024): it argues for describing character traits rather than enumerating do's and don'ts, on the grounds that a long prohibition list produces an inconsistent, legalistic persona. *(**[VERIFY]** — I could not retrieve the text; the wiki mirror I attempted did not load. Check the exact trait list before quoting it.)*

### 6.3 Warmth: what is actually evidence-backed

**[EVIDENCE]** — Nass & Moon, *Machines and Mindlessness: Social Responses to Computers*, Journal of Social Issues 2000, and the broader CASA (Computers Are Social Actors) literature: people apply social rules to computers — politeness, reciprocity, gender stereotyping — even when they know the machine is not a person. This is the empirical basis for taking persona seriously at all: users will respond socially whether or not you design for it, so an undesigned persona is still a persona.

**[EVIDENCE]** — Fiske, Cuddy & Glick's **stereotype content model**: warmth and competence are the two orthogonal dimensions of social judgement, and they are judged *separately*. **[OPINION]** for the transfer to assistants, but it is a genuinely useful design lens: an assistant can be high-competence/low-warmth (a tool), low-competence/high-warmth (a toy), or high/high (a trusted assistant). **Most robotic-feeling assistants are not failing at warmth; they are failing at competence signals** — hedging when they know the answer, padding, and claiming actions they did not take.

This is where Xana's `guardUnmadeClaim` (`src/lib/mind/claims.ts`) is doing warmth work disguised as safety work. The documented incident — the reply said "Done. The task is now titled '2pm Budget review.'" when nothing had changed — is a **competence** failure that no amount of warmth would repair. The module's own reasoning is worth preserving verbatim as design guidance: *"a false completion claim is worse than a refusal, because the user only discovers it by checking, and the whole point of the thing is that they do not have to."*

**[OPINION]** — Humour calibration. I found no solid experimental literature in this session on humour calibration for assistants. **[VERIFY]** before relying on any of this. The defensible defaults: never joke about the user's failures, health, money, or relationships; self-deprecation is the safest register; if the user does not reciprocate humour within a couple of turns, stop offering it; and never let a joke delay the answer.

### 6.4 Varying response length

**[EVIDENCE]** — the Model Spec's "Be thorough but efficient, while respecting length limits" and the separate voice-mode instruction to "Be concise and conversational". **[EVIDENCE, METHODOLOGICAL]** — verbosity/length bias in LLM judges is a documented confound: LLM-as-judge evaluations favour longer responses independently of quality, which means a model tuned against such a judge will drift verbose. **[VERIFY]** the specific paper and effect size.

**The practical rule:** response length should be **a function of the request**, not a constant. A question with a one-word answer gets one word. A "help me think through this" gets prose. A procedure gets steps. Most robotic-feeling assistants have exactly one length setting.

**[OPINION]** — Formatting: prose by default, structure when the content is genuinely structured (steps, options, comparisons). Bullet-pointing a single sentence is a common tell. Anthropic's guidance to prefer prose unless the user asks for structure is the right default; **[VERIFY]** the exact wording.

### 6.5 Persona consistency across sessions

The mechanism is straightforward and Xana mostly has it: **the persona is data, injected every turn.** `systemPrompt()` reads `loadSettings().voice.persona` on every call, so consistency is structural, not emergent.

Two additions worth making:

1. **Store exemplars, not just rules.** A "voice card" containing 3–5 short messages the assistant actually sent, which the user chose as representative. Few-shot exemplars convey register (sentence length, contractions, whether it uses the user's name, how it opens) far more reliably than adjectives. OpenAI's prompting guidance on few-shot examples applies directly. **[EVIDENCE]** for few-shot effectiveness generally; **[OPINION]** for the exemplar-selection mechanism.
2. **Watch for persona drift in long contexts.** **[VERIFY]** — there is a body of work on role-play agents losing character over long conversations; I did not confirm specific papers this session. The generative-agents paper does report the adjacent failure: agents "inherited overly formal speech or behavior from the language model" ([arXiv:2304.03442](https://arxiv.org/abs/2304.03442)). The cheap mitigations: re-inject the persona (do not rely on it surviving compaction), and add a lightweight post-hoc check for tell-tale forms — this is the same shape as `guardUnmadeClaim`, and Xana already has the pattern.

### 6.6 A draft persona specification

**[OPINION]** — assembled from the sources above. Structured in two tiers on the Model Spec's model: **Core** (not overridable) and **Guidelines** (implicitly overridable by context).

```
## Core — who Xana is

You are Xana, a personal assistant who runs on the user's own machine and keeps
their data there. You have a long-term memory of them and you use it.

You are competent first and warm second, because warmth without competence is
noise. Concretely, that means: never claim you did something you did not do;
never agree with a claim you believe is wrong; say "I don't know" or "I don't
have anything on that" rather than filling the gap.

You do not flatter. You do not open with praise for the question. You do not
call a plan "great" before you have looked at it. If something is a bad idea,
you say so once, briefly, and then help with what they actually asked for.

You are on their side. Disagreeing with a plan is not disagreeing with them.

## Guidelines — defaults you may drop when the moment calls for it

Length follows the question. A question with a one-word answer gets one word.
A request to think something through gets prose, not a list. Steps get steps.

Prose by default. Reach for structure only when the content has structure.

Voice replies are shorter than typed ones and never contain markdown.

Open with the substance. No "Great question", no "I'd be happy to", no
restating what they said.

Close when you are done. No "Let me know if you need anything else."

Use their name rarely, and only when it would be strange not to.

Humour is fine when they set the tone. Never about their health, money,
relationships, or anything they are struggling with. If they don't play
along, stop.

When you disagree: state it once, plainly, and give the reason. Then do what
they asked, or say clearly that you won't and why. Do not repeat the objection.

When you are uncertain: say what you are uncertain about and what would settle
it. Hedging on everything is as unhelpful as hedging on nothing.

Match their register. Terse with a terse user. Warmer with a warm one.
```

**Two rules from the sources deserve to be non-negotiable**, because they are where measured harm lives:

1. **Never claim a change that did not happen.** Enforced structurally by `guardUnmadeClaim`; the prompt half is `actionRule`.
2. **Never agree with a factual claim you believe is false.** This is the sycophancy defense ([arXiv:2310.13548](https://arxiv.org/abs/2310.13548)) and the lesson of the April 2025 rollback.

**Test both, and test them adversarially.** Xana already has the harness pattern: `scripts/check-edit-voice.ts` drives the exact sentence that produced the false claim, with no network and no API key. Extend it with cases like: user asserts something false and asks for confirmation; user reports a change and asks the assistant to confirm it happened; user asks for validation of a plan the assistant's own data contradicts.

---

## 7. Suggested sequencing

Ordered by (value ÷ risk), with the dependencies noted.

**Phase 1 — cheap, offline, no new dependencies, no model risk**
1. `OperationSafety` flags on the existing operation registry, fail-closed (§1.2b).
2. `action_log` table written in the same transaction as the effect (§1.2e).
3. FTS5 + BM25 channel on `memories`, fused with RRF k=60 (§3.5 steps 1–2).
4. Per-kind decay half-life; recency from `last_accessed_at` (§2.6 items 1–2).
5. `embedding_model` column, before any embedder swap (§2.8).
6. Extend `guardUnmadeClaim` to consult `action_log` rather than a boolean (§1.3).

**Phase 2 — real capability, moderate risk**
7. Swap the embedder to `bge-small-en-v1.5` or `gte-small` via transformers.js, vendored model files, `serverExternalPackages` (§3.3).
8. Generative-Agents-style reflection with citation links and a salience-sum trigger, keeping the deterministic version as fallback (§2.7).
9. `jobs` table with catch-up-on-boot; nightly reflection and morning briefing (§4.6).
10. `speakScore` gating for all proactive output, with quiet hours and meeting suppression (§4.4).
11. Implementation intentions as data, generated with every goal (§5.4).
12. Goal–task linking so the weekly review can report alignment (§5.3).

**Phase 3 — measure first, then decide**
13. Adaptive nudge threshold from `acted`/`dismissed`/`ignored` feedback (§4.5).
14. EWMA goal velocity replacing fixed pace bands; Monte Carlo completion dates (§4.5, §5.7).
15. MMR diversity in recall; two-stage retrieve-then-rerank (§2.6 items 4, 6).
16. `sqlite-vec` — only if a measured scan latency problem exists (§3.5 step 4).
17. Cross-encoder reranking — only after the lexical channel has been measured (§3.4).

**Deliberately not recommended:** model-driven tool calling, a generic SQL/HTTP operation, thumbs-up/down training, sentence-transformer models above 384 dimensions, and any web-fetch tool — the last only until the lethal-trifecta analysis in §1.2(g) has been done properly.

---

## Sources

### Agentic tool calling and safety

- Home Assistant, *API for Large Language Models* — https://developers.home-assistant.io/docs/core/llm/
- Letta, *Human-in-the-loop (HITL) tools* — https://docs.letta.com/v1-sdk/tools/human-in-the-loop
- Letta, *Permissions* — https://docs.letta.com/agent-sdk/permissions
- LangGraph, *Interrupts* — https://docs.langchain.com/oss/python/langgraph/interrupts
- OpenAI, *Model Spec* (2025-04-11) — https://model-spec.openai.com/2025-04-11.html
- OpenAI, *Expanding on what we missed with sycophancy* — https://openai.com/index/expanding-on-sycophancy/
- OpenAI Help, *Lockdown Mode* — https://help.openai.com/en/articles/20001061-lockdown-mode
- Simon Willison, *The lethal trifecta for AI agents* — https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- Simon Willison, *lethal-trifecta* tag (incident catalogue) — https://simonwillison.net/tags/lethal-trifecta/
- Simon Willison, *The Rule of 2* — https://simonwillison.net/2025/Aug/11/the-rule-of-2/
- Simon Willison, *Auto mode is now the default in Claude Code* (13.6% study) — https://simonwillison.net/2026/Aug/8/auto-mode/
- Simon Willison, *Claude web_fetch exfiltration* — https://simonwillison.net/2026/Jul/15/claude-web-fetch-exfiltration/
- Simon Willison, *Expanding on what we missed with sycophancy* — https://simonwillison.net/2025/May/2/what-we-missed-with-sycophancy/
- Model Context Protocol specification — https://modelcontextprotocol.io
- OWASP, *LLM06: Excessive Agency* (Top 10 for LLM Applications) — https://genai.owasp.org/llmrisk/llm062025-excessive-agency/

### Memory architecture

- Park et al., *Generative Agents: Interactive Simulacra of Human Behavior*, UIST 2023 — https://arxiv.org/abs/2304.03442 · https://ar5iv.labs.arxiv.org/html/2304.03442
- Reference implementation — https://github.com/joonspk-research/generative_agents
- Packer et al., *MemGPT: Towards LLMs as Operating Systems* — https://arxiv.org/abs/2310.08560 · https://ar5iv.labs.arxiv.org/html/2310.08560v4
- Chhikara et al., *Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory* — https://arxiv.org/abs/2504.19413
- Wu et al., *LongMemEval* — https://arxiv.org/abs/2410.10813
- Rasmussen et al., *Zep: A Temporal Knowledge Graph Architecture for Agent Memory* — https://arxiv.org/abs/2501.13956
- *A Survey on the Memory Mechanism of Large Language Model based Agents* — https://arxiv.org/abs/2404.13501
- *Sleep-time Compute: Beyond Inference Scaling at Test-time* — https://arxiv.org/abs/2504.13171 · https://github.com/letta-ai/sleep-time-compute
- Anthropic, *Effective context engineering for AI agents* — https://www.anthropic.com/engineering/effective-context-engineering-for-agents
- Anthropic Cookbook, *Automatic context compaction* — https://platform.claude.com/cookbook/tool-use-automatic-context-compaction
- Letta docs, *Memory blocks* / *Archival memory* / *Compaction* — https://docs.letta.com/v1-sdk/memory/memory-blocks/ · https://docs.letta.com/v1-sdk/memory/archival-memory/ · https://docs.letta.com/v1-sdk/messages/compaction/
- Shinn et al., *Reflexion* — https://arxiv.org/abs/2303.11366
- Park et al., *Generative Agent Simulations of 1,000 People* — https://arxiv.org/abs/2411.10109
- *Oblivion: Self-Adaptive Agentic Memory Control through Decay-Driven Activation* — https://arxiv.org/abs/2604.00131

### Embeddings and retrieval

- Thakur et al., *BEIR: A Heterogenous Benchmark for Zero-shot Evaluation of Information Retrieval Models* — https://arxiv.org/abs/2104.08663
- Cormack, Clarke & Buettcher, *Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods*, SIGIR 2009 — https://dl.acm.org/doi/10.1145/1571941.1572114 · http://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf
- Anthropic, *Introducing Contextual Retrieval* — https://www.anthropic.com/engineering/contextual-retrieval
- Anthropic contextual embeddings cookbook — https://platform.claude.com/cookbook/capabilities-contextual-embeddings-guide
- MTEB leaderboard — https://huggingface.co/spaces/mteb/leaderboard
- Google, *Introducing EmbeddingGemma* — https://developers.googleblog.com/en/introducing-embeddinggemma/
- Google DeepMind, *EmbeddingGemma* model page — https://deepmind.google/models/gemma/embeddinggemma/
- BAAI `bge-small-en-v1.5` — https://huggingface.co/BAAI/bge-small-en-v1.5
- `sentence-transformers/all-MiniLM-L6-v2` — https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2
- Nomic `nomic-embed-text-v1.5` — https://huggingface.co/nomic-ai/nomic-embed-text-v1.5
- Alibaba-NLP `gte-small` — https://huggingface.co/Alibaba-NLP/gte-small
- Transformers.js — https://github.com/huggingface/transformers.js
- Next.js, `serverExternalPackages` — https://nextjs.org/docs/app/api-reference/config/next-config-js/serverExternalPackages
- `sqlite-vec` (asg017) — https://github.com/asg017/sqlite-vec · KNN docs: https://github.com/asg017/sqlite-vec/blob/main/site/features/knn.md
- SQLite FTS5 documentation — https://www.sqlite.org/fts5.html
- Bruch et al., *An Analysis of Fusion Functions for Hybrid Retrieval* — https://arxiv.org/abs/2210.11934
- Formal et al., *SPLADE: Sparse Lexical and Expansion Model for First Stage Ranking* — https://arxiv.org/abs/2107.05720

### Proactive and ambient behaviour

- Horvitz, *Principles of Mixed-Initiative User Interfaces*, CHI 1999 — https://dl.acm.org/doi/10.1145/302979.303030
- Horvitz et al., *Models of Attention in Computing and Communication*, CACM 2003 — https://dl.acm.org/doi/10.1145/636772.636798
- Fogarty et al., *Predicting Human Interruptibility with Sensors*, ACM ToCHI 2005 — https://dl.acm.org/doi/10.1145/1057237.1057243
- Iqbal & Horvitz, *Disruption and Recovery of Computing Tasks*, CHI 2007 — https://dl.acm.org/doi/10.1145/1240624.1240730
- Mark, Gudith & Klocke, *The Cost of Interrupted Work: More Speed and Stress*, CHI 2008 — https://dl.acm.org/doi/10.1145/1357054.1357072
- *Creating General User Models from Computer Use* (2025 interrupt-utility formulation) — https://arxiv.org/abs/2505.10831
- Thaler & Sunstein, *Nudge* — https://yalebooks.yale.edu/book/9780300262285/nudge/
- Fogg Behavior Model — https://behaviormodel.org/

### Goals, plans, and habits

- Google re:Work, *Set goals with OKRs* — https://rework.withgoogle.com/intl/en/guides/set-goals-with-okrs
- Doerr, *Measure What Matters* / OKR playbook — https://www.whatmatters.com/faqs/okr-meaning-definition-example
- Locke & Latham, *Building a Practically Useful Theory of Goal Setting and Task Motivation*, American Psychologist 2002 — https://psycnet.apa.org/record/2002-15790-003
- Ordóñez et al., *Goals Gone Wild*, Academy of Management Perspectives 2009 — https://journals.aom.org/doi/10.5465/AMP.2009.37008002
- Gollwitzer, *Implementation Intentions*, American Psychologist 1999 — https://psycnet.apa.org/record/1999-05794-001
- Gollwitzer & Sheeran, *Implementation Intentions and Goal Achievement: A Meta-analysis*, 2006 — https://www.sciencedirect.com/science/chapter/bookseries/abs/pii/S0065260106380021
- Harkin et al., *Does monitoring goal progress promote goal attainment?*, Psychological Bulletin 2016 — https://psycnet.apa.org/doiLanding?doi=10.1037%2Fbul0000025
- Lally et al., *How are habits formed*, EJSP 2010 — https://onlinelibrary.wiley.com/doi/10.1002/ejsp.674 · summary: https://www.bps.org.uk/research-digest/how-are-habits-formed
- Allen, *Getting Things Done* — https://gettingthingsdone.com/
- Valmeekam et al., *On the Planning Abilities of Large Language Models* / PlanBench — https://arxiv.org/abs/2206.10498
- Xie et al., *TravelPlanner* — https://arxiv.org/abs/2402.01622
- Liu et al., *LLM+P: Empowering Large Language Models with Optimal Planning Proficiency* — https://arxiv.org/abs/2304.11477
- Yao et al., *ReAct* — https://arxiv.org/abs/2210.03629
- Yao et al., *Tree of Thoughts* — https://arxiv.org/abs/2305.10601
- Zhou et al., *Least-to-Most Prompting* — https://arxiv.org/abs/2205.10625
- Wang et al., *Plan-and-Solve Prompting* — https://arxiv.org/abs/2305.04091
- PMI, earned value management (SPI/CPI) — https://www.pmi.org/learning/library/earned-value-management-systems-6190

### Conversation quality

- Sharma et al., *Towards Understanding Sycophancy in Language Models* — https://arxiv.org/abs/2310.13548
- Anthropic, *Claude's Character* — https://www.anthropic.com/research/claude-character
- Anthropic, *Claude 4 prompt engineering best practices* — https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/claude-4-best-practices
- Anthropic, *Giving Claude a role with a system prompt* — https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/system-prompts
- Anthropic, *Building effective agents* — https://www.anthropic.com/engineering/building-effective-agents
- Anthropic, *Writing effective tools for agents* — https://www.anthropic.com/engineering/writing-tools-for-agents
- OpenAI, *Prompt engineering guide* — https://platform.openai.com/docs/guides/prompt-engineering
- OpenAI, *Function calling guide* — https://platform.openai.com/docs/guides/function-calling
- OpenAI, *A practical guide to building agents* — https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf
- Nass & Moon, *Machines and Mindlessness: Social Responses to Computers*, JSI 2000 — https://spssi.onlinelibrary.wiley.com/doi/10.1111/0022-4537.00153
- Fiske, Cuddy & Glick, *Universal dimensions of social cognition: warmth and competence* — https://www.cell.com/trends/cognitive-sciences/abstract/S1364-6613(06)00301-1
- Google, *Gemini prompting strategies* — https://ai.google.dev/gemini-api/docs/prompting-strategies

---

## Verification checklist

Before any of these numbers go into a decision, a UI string, or a design doc:

| Claim | Where it came from | Status |
|---|---|---|
| Generative Agents decay 0.995, importance scale 1–10, reflection threshold 150, α=1 | arXiv:2304.03442, read directly | **Confirmed** |
| MemGPT DMR 32.1% → 92.5% (GPT-4); 70%/100% token thresholds; evict 50% | arXiv:2310.08560, read directly | **Confirmed** |
| Anthropic contextual retrieval 5.7% → 3.7% → 2.9% → 1.9% | Anthropic engineering post, read directly | **Confirmed** |
| HA `ToolAnnotations` four flags and their fail-safe defaults; 10-iteration loop | developers.home-assistant.io, read directly | **Confirmed** |
| OpenAI Model Spec authority levels; tool output has no authority; "Be thorough but efficient" | model-spec.openai.com, read directly | **Confirmed** |
| OpenAI sycophancy post-mortem quotes (thumbs data, memory, launch-blocking) | quoted in full by Simon Willison | **Confirmed (secondary)** |
| 13.6% of humans refused a dangerous command vs 89% for auto mode | Anthropic-commissioned study via Willison | **Confirmed as reported; self-commissioned** |
| Lethal trifecta definition and incident catalogue | Willison tag page, read directly | **Confirmed** |
| MTEB scores for all-MiniLM-L6-v2, bge-small, gte-small, nomic, EmbeddingGemma | Search summaries only | **VERIFY — version-dependent** |
| ONNX file sizes and int8 quantisation figures | Not retrieved from primary source | **VERIFY** |
| EmbeddingGemma dims 768 / Matryoshka 512-256-128 / 2048 ctx / 300M params | Google blog + DeepMind page, via search | **Likely correct — VERIFY** |
| `sqlite-vec` production-readiness and `distance_metric` syntax | Not retrieved | **VERIFY** |
| transformers.js v3 `dtype` option names; Node support specifics | Not retrieved | **VERIFY** |
| BEIR BM25 average nDCG@10 ≈ 0.44 | Search summaries; corroborated at 0.426 by arXiv:2412.14405 | **VERIFY against paper tables** |
| RRF k=60 default and "outperforms Condorcet" claim | Paper title via ACM DL; PDF fetch blocked | **Method and formula confirmed; VERIFY the k value** |
| Gollwitzer & Sheeran d ≈ 0.65, 94 tests | Multiple search summaries, no primary text | **VERIFY** |
| Lally 66-day median, 18–254 range | BPS summary, secondary | **VERIFY (secondary)** |
| Harkin 2016 monitoring effect size and moderators | APA abstract only | **VERIFY** |
| ~23-minute resumption lag (Iqbal & Horvitz) | Widely cited; paper not retrieved | **VERIFY — commonly misattributed** |
| Locke & Latham effect sizes | Not retrieved | **VERIFY** |
| PlanBench / TravelPlanner success rates | Not retrieved | **VERIFY per model version** |
| Claude's Character trait list | Fetch failed | **VERIFY** |

**The honest summary of this table:** the memory, safety, and retrieval *architectures* above rest on primary sources I read directly and are solid. The *benchmark numbers* for embedding models and the *effect sizes* for the psychology literature are the parts that need checking, and they are exactly the parts most likely to be quoted out of context. Check them.
