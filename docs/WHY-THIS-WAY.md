# Why this way

The rationale for the "smarter" pass: what it decided, what it refused to do,
which numbers may be trusted, and which may not. `docs/UPGRADE-CONTRACTS.md` is
the interface contract and `docs/AGENT-CONTRACT.md` is the frozen testable
detail. This file is the reasoning those two rest on.

It exists because the interesting part of this change is not the feature. It is
the line between "the model may now do things" and the property in `MEMORY.md`
section 1, which is the single most valuable thing in the project.

---

## 0. How to read a claim in this file

Every factual claim carries one of these tags. The tags are not decoration: a
claim with the wrong tag is a defect in this document.

| Tag | Means |
|---|---|
| **[MEASURED]** | Reproduced against a live system on a stated date, with the probe named. The strongest kind of claim here. |
| **[EVIDENCE]** | A primary source read directly - a paper, an official spec, vendor documentation. |
| **[VENDOR CLAIM]** | A company reporting its own benchmark or its own product's behaviour. Directionally useful, marketing until independently reproduced. |
| **[UNVERIFIED NUMBER]** | Commonly cited, primary source NOT retrieved. May be used to motivate a question. May NOT be used to justify a decision, and may NOT reach a UI string. |
| **[OPINION]** | Reasoned judgement with no data behind it. Useful for design taste, not for justification. |

The rule that follows from the table: **an [UNVERIFIED NUMBER] never enters a
user-facing sentence, and never decides anything.** Research that motivated this
pass is in `research/assistant-research-2026.md`, which uses a compatible legend
and flags the soft claims itself.

---

## 1. The decision

Three sentences:

1. **Local intent resolution stays first and stays authoritative.** `localMind()`
   runs on every turn, before any model call, exactly as `MEMORY.md` section 1
   requires. If it produces an outcome or a card, the model is not asked to
   decide anything.
2. **The model may propose, but only from a closed typed catalog.** When the
   local engine matches nothing, the model is offered a fixed list of tool
   definitions (`READ_TOOLS` + `WRITE_TOOLS`) and may select one. It cannot
   compose a new operation, cannot write SQL, cannot fetch a URL, and cannot
   name a record by id.
3. **Every write lands in one audited path.** A proposal becomes an
   `ActionIntent` only by passing `validateActionIntent()`, and an intent becomes
   a database change only through `executeAction()`, which writes the effect and
   its `action_log` row in one transaction.

What did NOT change, and this is the point: the model still does not decide what
happens. It chooses from operations that were already deterministic and already
existed. The set of things Xana can do is still a closed set written by a human;
the model got a vote on *which* member of that set applies, and nothing else.

### The four invariants a change must not break

1. **Propose, validate, commit are three separate steps.** No code path may go
   from a tool call to a database write without both a `Verdict` and
   `executeAction` in between.
2. **Validation does not depend on the model's cooperation.** `guard.ts` is
   deterministic code that reads the proposal, not prose asking the model to
   behave. Advice is not a mechanism.
3. **Failure is closed.** Unknown tool, unparseable arguments, a missing
   required field, an unresolvable name, or an untrusted source all produce a
   refusal. There is no "best effort" branch that executes something adjacent.
4. **No key means no loop.** With no model configured, the loop is not entered,
   no request is made, and the local engine's sentence is byte-identical to what
   it was before this pass.

Invariants 1 to 3 are asserted in `scripts/check-contracts.ts`. All four are
driven end to end in `scripts/check-mind-loop.ts`.

---

## 2. What this buys, and what it costs

**Bought:** the ceiling that `MEMORY.md` section 1 created. An utterance the
local engine did not match used to produce one sentence - "I didn't follow that"
- no matter what it was. Now it either resolves to a catalog operation the model
selected, or it is answered conversationally. The trust property is unchanged
because everything the model can *do* is a member of a set that was already
auditable.

**[OPINION]** The cost is real and should be stated: the catalog is still the
ceiling. This pass does not make Xana open-ended; it moves the ceiling from
"phrasings the intent parser knows" to "operations a human wrote down". A user
who asks for something not in the catalog still gets a refusal or a
conversational answer. That is the intended trade, not a shortfall to be fixed by
widening the catalog carelessly.

**[OPINION]** The second cost is latency and spend: an unmatched turn now costs
up to `MAX_TOOL_ROUNDS` (4) model round trips plus their thinking tokens. It is
bounded deliberately. `MAX_TOOL_ROUNDS` is a budget, not a suggestion.

---

## 3. Rejected, and why

Each of these was seriously on the table. The reasons matter more than the
verdicts, because the same proposals will come back.

### 3.1 No generic SQL, HTTP or shell operation

**The proposal.** One `run_sql` or `http_request` tool would make the assistant
open-ended for a fraction of the code.

**Why rejected.** It collapses the entire safety design in one line. The catalog
is the safety argument: every operation is typed, its arguments are validated
against a declared schema, `resolves` forces names to match real records, safety
classes drive the confirmation gate, and the audit row names the tool. A generic
operation has none of those properties - the "arguments" are an arbitrary
language, there is nothing to validate against, and the audit row would record
`run_sql` with a string nobody can review. **[EVIDENCE]** the research pass
reached the same conclusion from the incident literature: "do not give the model
a generic `run_sql` or `http_request` operation. That single decision collapses
the entire safety design" (`research/assistant-research-2026.md`, section 1.3).

**What would change the answer.** Nothing available today. A future read-only
SQL tool restricted to a fixed set of views, with the query built server-side
from named parameters rather than accepted as text, is a different proposal and
could be argued on its own merits. "Let the model write SQL" is not.

### 3.2 No web-fetch tool

**The proposal.** `web_fetch` would let Xana read a link the user pasted.

**Why rejected.** This is the lethal trifecta, quoted directly:
**[EVIDENCE]** Simon Willison, 16 June 2025 - "Any time you grant an LLM-based
system access to private data, exposure to untrusted content, and the ability to
externally communicate you have a nasty security hole"
(https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/).

Xana today holds exactly one leg: private data, the whole SQLite brain.
`MEMORY.md` documents how much of the user's life that is. A fetch tool adds the
second leg - untrusted content, since a fetched page is written by someone else -
and the third leg already exists in latent form, because anything the model can
write can later be spoken, exported, or read back by another integration. The
incident catalogue on that tag page is not hypothetical: the pattern recurs
across MCP servers, Copilot (CVE-2025-32711), GitLab Duo, Google Antigravity and
Claude's own `web_fetch`, whose first version allowed URLs found *inside* fetched
pages and was the hole.

**What would change the answer.** A properly argued design that removes one leg:
fetch only URLs the user typed or a search tool returned, never URLs found in
fetched content; keep fetched text in a channel that can never reach a write
tool; and confine the network egress so an injected instruction has nowhere to
send data. That is a project, not a tool definition. It is out of scope here,
and the correct state of the code is that no such tool exists.

### 3.3 No model-written goal progress

**The proposal.** Let the model set `progressOverride` on a goal, because it can
read the milestones and the user's messages and judge how far along they are.

**Why rejected.** Progress is a *measured* quantity. `src/lib/derived/goals.ts`
computes it from milestone ratios against elapsed time, and it is deterministic,
which means two people looking at the same data see the same number and the
number does not change because the model had a bad day. A model-written override
would be unauditable in exactly the way this project refuses: the user could not
tell whether "you are 80% there" came from their own completed milestones or from
a sentence that sounded plausible.

The model's role in planning is deliberately narrower: it proposes *structure*
(milestone titles), and `validateMilestones()` in `src/lib/mind/plan.ts` accepts
or drops each proposal deterministically - empty titles, duplicates, dates after
the target, more than 8 proposals and non-integer order are all rejected. The
model may suggest steps. It may not grade them.

**[OPINION]** This is also the honest limit: a goal's progress bar being
unexciting is better than it being wrong in a way the user cannot check.

### 3.4 No new native dependency

**The proposal.** Add `sqlite-vec` (or a transformer-runtime package) for real
vector search.

**Why rejected.** The measured arithmetic does not justify it. **[OPINION, but
based on arithmetic that can be checked]** 384 dimensions at 4 bytes is about
1.5 KB per memory; 20,000 memories is roughly 30 MB, and a JavaScript cosine loop
over 20,000 rows is single-digit milliseconds. Xana's recall path is already an
O(n) scan and is not the bottleneck at this scale.

Against that, `sqlite-vec` needs native extension loading. `better-sqlite3`
permits it, but on Windows it adds a build and ABI dependency to the one thing
the project promises above all: a zero-configuration local install that works
without a toolchain. **[EVIDENCE]** the research pass reached the same
conclusion and flagged its own uncertainty honestly (section 3.2, item 4:
"**[VERIFY]** ... I could not confirm current production-readiness claims or
exact `distance_metric` syntax. At Xana's scale the honest answer is that you
probably do not need it: ... Measure first.").

**What would change the answer.** A measurement on a real database showing the
scan is slow enough to feel, at which point the fix is chosen against that
number. Not before.

---

## 4. Trust boundaries, stated once

- **Names, never ids.** A model that can supply an id can supply the *wrong* id,
  and a wrong id is a silent edit to the wrong record. Every tool that acts on an
  existing record declares `resolves`, the argument is matched server-side
  against the life state, and an unmatched name is a refusal. This is why
  `complete_task` takes `{"task": "review the Aurora deck"}`.
- **Untrusted content is data, not instruction.** `ToolContext.untrustedSource`
  is set when a proposal originated in content Xana did not write. Any non-read
  tool proposed while it is set is refused. Fail-closed: the absence of a marker
  is not evidence of trust, it is the default that the read/write split protects
  independently.
- **Destructive means confirm, and little else does.** `confirm` fires only for
  `spec.safety === "destructive"` (`delete_task`, `forget_memory`). Everything
  reversible goes straight through. This is deliberate:
  **[EVIDENCE, with a caveat]** a third-party evaluation commissioned by
  Anthropic (Trajectory Labs, July 2026, reported across 1,053 paid testers) found
  that when one permission prompt was swapped for a clearly dangerous command,
  only 13.6% of humans refused it, while the automated mode blocked 89%. The
  study's existence and its numbers are evidence; the generalisation is a
  **[VENDOR CLAIM]** and the eval was self-commissioned. Its implication is used
  here only in the weak direction: a blanket "confirm everything" gate trains
  people to click through, so confirmation must be rare and reserved for the
  irreversible.
- **Refusals are visible.** A refusal is fed back to the model as a `role: "tool"`
  message with `ok: false` and the reason, and it is recorded. A silent refusal
  is indistinguishable from a bug.

---

## 5. API facts that contradict the documentation

Measured live against `api.deepseek.com` by the Lead on **2026-10-08**. These
contradict the vendor documentation, so they are recorded here with their
[MEASURED] tag and the probe date: anyone who re-derives them from the docs will
get them wrong, and anyone who "fixes" the code to match the docs will break it.

| Claim in the docs | What the live probe shows | What this project does |
|---|---|---|
| Replaying `reasoning_content` on a follow-up request that carries `tools` is required, or the API returns 400 | Omitting it returned **HTTP 200**. The docs are wrong | `LlmMessage.reasoning_content` is captured for logging and deliberately **not** replayed. Nothing may be built on replaying it |
| `parallel_tool_calls` is not in the documented request schema | `parallel_tool_calls: true` was **accepted, HTTP 200**, though undocumented | Not relied on. It is not sent; a catalog of one-action-per-turn does not need it |
| `tool_choice: "required"` is a normal OpenAI-style option | Returns **HTTP 400 in thinking mode**: "Thinking mode does not support this tool_choice". With thinking disabled it works | `buildRequest` in `src/lib/mind/llm.ts` downgrades `"required"` to `"auto"` rather than spending a round trip to learn it. Never send `required` with thinking on |
| `deepseek-chat` and `deepseek-reasoner` were retired on 2026-07-24 | Both **still return HTTP 200** as of 2026-10-08 | The default moves to **`deepseek-flash`**. The legacy names still answer, which is why a stale config has not visibly broken yet - and why this is a silent trap rather than a loud one |

Two consequences worth stating separately:

- **A retired-name config fails silently, not loudly.** A user on a key
  configured months ago sees no error today. The default moving to
  `deepseek-flash` is a correctness fix, not a preference.
- **Tool arguments are a JSON string and may be malformed.** The provider's own
  documentation warns the model "does not always generate valid JSON, and may
  hallucinate parameters". `parseToolArguments()` is therefore defensive and a
  parse failure is a refusal. This is the documented-for-once case where the docs
  and reality agree.

**What this file does not claim.** The probes above were run by the Lead with a
real key. The verification suites in this repository do **not** re-run them: they
run with no key and no network, on purpose. If you need to re-confirm the table,
it takes one live request per row and a key, and that is a deliberate manual act,
not part of `npm run check`.

---

## 6. Numbers we are not allowed to use

The research pass flagged three families of numbers as unverified. They are
recorded here so that nobody quietly promotes them into a justification.

| Number | Status | Where it came from | Rule |
|---|---|---|---|
| MTEB scores for `all-MiniLM-L6-v2`, `bge-small`, `gte-small`, `nomic`, `EmbeddingGemma` | **[UNVERIFIED NUMBER]** - search summaries only, and MTEB scores are not comparable across MTEB versions (v1 vs v2 differ in task set, language coverage and aggregation) | `research/assistant-research-2026.md` sections 3.1 and the source table | Not a reason to swap the embedder. The default stays `localEmbedder`; a downloaded model is opt-in |
| BM25 average nDCG@10 across BEIR, commonly cited as ~0.44 | **[UNVERIFIED NUMBER]** - corroborated at 0.426 by a later paper (arXiv:2412.14405) and directionally supported by the BEIR paper's headline finding, but the paper's own tables were not read | same | The *decision* to fuse lexical and dense retrieval rests on the BEIR paper's qualitative finding (BM25 is a strong zero-shot baseline; dense models generalise worse out of domain). The *number* may not be quoted in the UI or in a decision |
| Locke & Latham goal-setting effect sizes; Harkin et al. 2016 monitoring effect size and moderators; Iqbal & Bailey breakpoint effect size | **[UNVERIFIED NUMBER]** - abstracts or citations only, effect sizes not retrieved | same, section 5 and section 4 | The *direction* (specific goals beat vague ones; monitoring progress helps; interrupting at natural breakpoints is cheaper) motivates the feature. No effect size is displayed anywhere |

The rule, once more, because it is the one that gets broken: **an unverified
number may motivate a question; it may not justify a decision and it may not
appear in a sentence the user reads.** `docs/UPGRADE-CONTRACTS.md` section 5 puts
it in the definition of done: every new number that reaches the UI is measured
here, not quoted from a blog.

Related, and worth keeping honest in the other direction: the "confirmation gates
are weak" finding is real evidence (13.6% refusal) with a vendor-commissioned
caveat, and the Home Assistant `ToolAnnotations` defaults - `read_only: False`,
`destructive: True`, `idempotent: False`, `open_world: True`, i.e. a tool that
declares nothing is treated as the least safe case - are **[EVIDENCE]** from
vendor documentation that this project chose to follow, because following it is
the fail-closed direction.

---

## 7. How this stays true

The rationale above is worth nothing if the code drifts. These are the
mechanisms, and each one is tested:

| Invariant | Mechanism | Test |
|---|---|---|
| Local first, always | `think()` calls `localMind()` before any model call; the loop needs no outcome and no cards | `check-mind-loop.ts` "no model attached" section; `check-contracts.ts` |
| Proposals are typed | `validateActionIntent()` over a closed catalog | `check-contracts.ts`, `check-mind-loop.ts` |
| Failure is closed | unknown tool / bad JSON / missing required / unresolvable name / untrusted source all refuse | `check-mind-loop.ts` "malformed" and "untrusted" sections |
| One write path | every write goes through `executeAction`, effect and audit row in one transaction | `check-mind-loop.ts` counts `action_log` rows and the task rows |
| At most once | server-derived idempotency key; duplicate returns `action.duplicate` without a second write | `check-mind-loop.ts` "duplicate key" section |
| Honest speech | `guardUnmadeClaim()` replaces a claimed-but-unmade change | `check-mind-loop.ts`, importing the real guard; `check-edit-voice.ts` |
| No key, no loop | `llmAvailable()` gate; zero requests; `engine: "local"` | `check-mind-loop.ts` "no model attached" section |

Two things the suites deliberately do **not** prove, because they cannot:
that a real provider's response parses (that needs a key, and it is on the
list in `research/assistant-research-2026.md`), and that the model's *judgement*
about which tool to use is good. The harness proves the guard rails hold when
the model is wrong, which is the property that matters and the only one that can
be proven without a live model.

### If you are about to change this

1. Adding a tool? It must be typed, must declare `safety`, must declare
   `resolves` if it names an existing record, and must not execute anything
   itself - it returns an `ActionIntent` for `executeAction`.
2. Adding a field to `ToolContext` or `AgentTurnInput`? Ask whether it widens what
   the model can reach. `untrustedSource` narrows; a `fetchUrl` would not.
3. Tempted to let the model skip validation "because the arguments look fine"?
   That is the whole argument of this file, and the answer is no.
4. Adding a number to a UI string? Tag it first. If it is not [MEASURED] or
   [EVIDENCE], it does not ship.
