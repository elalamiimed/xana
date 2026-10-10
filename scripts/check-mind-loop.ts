/**
 * The agent loop, end to end, with a model that is not a model.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-mind-loop.ts
 *
 * WHAT THIS IS FOR
 *
 * The "smarter" pass lets a model propose writes. Everything that makes that
 * safe is deterministic code around the model: a closed catalog of typed tools,
 * a validator that fails closed, one commit path, a server-derived idempotency
 * key, and an audit row written with the effect. None of that depends on the
 * model being intelligent or cooperative, which means all of it is testable
 * with no network and no API key. So it is tested here.
 *
 * The cases below are the negative ones on purpose. A suite that shows a
 * well-behaved tool call landing is worth very little; the thing that has to be
 * true is that a malformed call, an invented tool name, a second copy of the
 * same call, and a write proposed from untrusted content all fail closed and
 * write nothing.
 *
 * HOW THE MODEL IS STUBBED
 *
 * `runAgentTurn()` calls `llmComplete()` directly - there is deliberately no
 * injectable model seam (`docs/AGENT-CONTRACT.md` section 1). The transport is
 * stubbed instead: a real `http.createServer` on 127.0.0.1 answers the
 * configured `model.baseUrl`, and the real `fetch` in the real client hits it.
 * That exercises request building, the tool-call plumbing and the response
 * parser for real, which an injected fake would not.
 *
 * WHAT THIS DOES NOT PROVE
 *
 * That a real provider's response parses. That needs a key and stays on the
 * list. Everything on this side of the wire is ours and is asserted here.
 *
 * AND IT NEVER TOUCHES THE REAL DATABASE
 *
 * `XANA_DATA_DIR` points at a copy under `data/scratch/`, and the last section
 * asserts the real `data/xana.db` is byte-for-byte untouched. The pattern comes
 * from `scripts/check-trash.ts`, which learned the hard way why the guard is
 * not decoration.
 */

import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";

// Type-only, so it is erased at runtime and cannot pull the settings layer in
// before `XANA_DATA_DIR` is set below.
import type { LifeState } from "../src/lib/core/types";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ""}`);
  }
}

async function group(title: string, run: () => void | Promise<void>): Promise<void> {
  console.log(`\n${title}\n`);
  try {
    await run();
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${title} threw - ${err instanceof Error ? err.message : String(err)}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* The scratch world                                                   */
/* ------------------------------------------------------------------ */

const PROJECT_ROOT = process.cwd();
const REAL_DB = path.join(PROJECT_ROOT, "data", "xana.db");
const SCRATCH = path.join(PROJECT_ROOT, "data", "scratch", `mind-loop-${process.pid}`);

/**
 * The real database is copied, never used. A copy rather than a fresh empty
 * store so the schema and any migrations run against a database that has the
 * shape a user's does - and because a test that only ever sees an empty
 * database is a test that has never met a real one.
 */
const realBefore = existsSync(REAL_DB) ? statSync(REAL_DB) : undefined;
mkdirSync(SCRATCH, { recursive: true });
if (realBefore) copyFileSync(REAL_DB, path.join(SCRATCH, "xana.db"));

// Read at module scope by the settings layer, so it has to be set before any
// application module is imported. Every import below is dynamic for that reason.
process.env.XANA_DATA_DIR = SCRATCH;

/* ------------------------------------------------------------------ */
/* The stub provider                                                   */
/* ------------------------------------------------------------------ */

interface StubRequest {
  url: string;
  body: {
    model?: string;
    messages?: Array<{ role: string; content?: string; tool_calls?: unknown[]; tool_call_id?: string }>;
    tools?: Array<{ function: { name: string } }>;
    tool_choice?: unknown;
    thinking?: unknown;
    stream?: unknown;
  };
}

const requests: StubRequest[] = [];
let script: Array<{ status: number; payload: unknown }> = [];

/** The OpenAI-compatible envelope, exactly as a provider sends it. */
function shaped(
  content: string,
  toolCalls?: Array<{ id: string; name: string; args: string }>,
  finishReason = toolCalls?.length ? "tool_calls" : "stop",
): unknown {
  return {
    id: "chatcmpl-stub",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "stub-model",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
          ...(toolCalls?.length
            ? {
                tool_calls: toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.args },
                })),
              }
            : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    let body: StubRequest["body"] = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as StubRequest["body"];
    } catch {
      body = {};
    }
    requests.push({ url: req.url ?? "", body });

    const next = script.shift() ?? {
      status: 200,
      payload: shaped("Understood."),
    };
    res.writeHead(next.status, { "content-type": "application/json" });
    res.end(JSON.stringify(next.payload));
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const BASE_URL = `http://127.0.0.1:${port}/v1`;

/** Queue the replies the stub will give, in order, one per request. */
function nextReplies(...replies: Array<{ status?: number; payload: unknown }>): void {
  script = replies.map((reply) => ({ status: reply.status ?? 200, payload: reply.payload }));
}

async function useModel(enabled: boolean): Promise<void> {
  writeFileSync(
    path.join(SCRATCH, "settings.json"),
    JSON.stringify(
      {
        model: {
          enabled,
          provider: "openai",
          baseUrl: BASE_URL,
          model: "stub-model",
          apiKey: enabled ? "stub-key-not-a-real-secret" : "",
          temperature: 0.3,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  // The settings store memoises on mtime, and this write can land in the same
  // millisecond as the last read.
  await sleep(40);
}

/* ------------------------------------------------------------------ */
/* The app, with settings pointed at the stub                          */
/* ------------------------------------------------------------------ */

if (process.env.DEEPSEEK_API_KEY) delete process.env.DEEPSEEK_API_KEY;
if (process.env.OPENAI_API_KEY) delete process.env.OPENAI_API_KEY;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("XANA_LLM_")) delete process.env[key];
}

await useModel(true);

const { think } = await import("../src/lib/mind/index");
const { llmAvailable } = await import("../src/lib/mind/llm");
const { getStore } = await import("../src/lib/core/store");
const { localMind } = await import("../src/lib/mind/local");
const { guardUnmadeClaim, NOTHING_CHANGED, looksLikeChangeRequest, claimsAChange } = await import(
  "../src/lib/mind/claims"
);

const store = getStore();

/** A life state with nothing in it, hand-built so no adapter is consulted. */
function emptyState(): LifeState {
  return {
    generatedAt: new Date().toISOString(),
    partOfDay: "evening",
    headline: "",
    energy: { score: 50, band: "steady", note: "", windows: [] },
    calendar: { today: [], tomorrow: [], next: undefined, freeMinutes: 0 },
    tasks: { focus: [], overdue: [], openCount: 0, completedThisWeek: 0 },
    habits: [],
    goals: [],
    health: { latest: undefined, sleepAvgHours: undefined, sleepDebtHours: 0 },
    memory: [],
    patterns: [],
    nudges: [],
    finance: [],
    mail: [],
    sources: [],
  } as unknown as LifeState;
}

/* ------------------------------------------------------------------ */
/* The transport is real                                               */
/* ------------------------------------------------------------------ */

await group("The stub is a real provider on the wire", async () => {
  check("the settings point the client at the stub", llmAvailable() === true);
  check("the stub is listening on loopback", BASE_URL.startsWith("http://127.0.0.1:"), BASE_URL);

  const before = requests.length;
  nextReplies({ payload: shaped("Ready.") });
  const { llmComplete } = await import("../src/lib/mind/llm");
  const completion = await llmComplete([{ role: "user", content: "Say ready." }], { maxTokens: 16, thinking: false });

  check("a real round trip answers", completion.text === "Ready.", JSON.stringify(completion.text));
  check("exactly one request was made", requests.length === before + 1, `${before} -> ${requests.length}`);
  check(
    "it went to the chat-completions path, not somewhere invented",
    requests.at(-1)?.url.endsWith("/chat/completions") === true,
    requests.at(-1)?.url,
  );
  check(
    "and carried the configured model name",
    requests.at(-1)?.body.model === "stub-model",
    String(requests.at(-1)?.body.model),
  );
});

/* ------------------------------------------------------------------ */
/* Criterion 6 - the claim guard still fires                           */
/* ------------------------------------------------------------------ */

await group("A model that claims a change it did not make is replaced", async () => {
  check("the guard is the real one, not a copy of it", typeof guardUnmadeClaim === "function");

  const lie = 'Done. The task is now titled "2pm Budget review."';
  const request = "rename the garbled thing to 2pm Budget review";
  check("the sentence is a change request", looksLikeChangeRequest(request) === true, request);
  check("the reply does claim a change", claimsAChange(lie) === true, lie);

  const replaced = guardUnmadeClaim(lie, { text: request, acted: false });
  check("it is replaced", replaced.replaced === true);
  check("with the module's own honest line", replaced.text === NOTHING_CHANGED, replaced.text.slice(0, 80));
  check(
    "and nowhere does it still say the task was renamed",
    !/renamed|now titled/i.test(replaced.text),
    replaced.text.slice(0, 120),
  );

  // The guard is narrow in both directions: an action that DID run is left
  // alone, and a reply that merely discusses a change is not touched.
  check(
    "an action that ran is left alone",
    guardUnmadeClaim(lie, { text: request, acted: true }).replaced === false,
  );
  const discussion = "Nothing is scheduled at two, so the afternoon is free.";
  check(
    "a reply that only discusses the day is left alone",
    guardUnmadeClaim(discussion, { text: "what does my afternoon look like", acted: false }).text === discussion,
  );

  /*
   * And through the real wiring, not only the pure function. This is the half
   * that matters: `think()` builds the prompt, the stub answers with the exact
   * lie from the incident, and the reply the user receives must be the honest
   * line. A guard that is correct in isolation and not called is no guard.
   */
  const state = emptyState();
  const candidate = "rename the garbled thing to 2pm Budget review";
  const local = localMind({ text: candidate, lifeState: state, sessionId: "guard-e2e" });
  /*
   * What the guard keys on is `acted = Boolean(local.outcome?.ok)`, so the
   * precondition is "no action succeeded", not "no outcome exists". The
   * distinction is the incident's exact shape: the local engine answered that
   * it could not find the task (an outcome with ok: false), and the model
   * still said it had renamed it.
   */
  const acted = Boolean(local.outcome?.ok);
  check(
    "no action succeeded, so the guard's `acted` is false",
    acted === false,
    local.outcome ? `it resolved to ${local.outcome.effect} ok=${local.outcome.ok}` : "no outcome",
  );

  nextReplies({ payload: shaped(lie) });
  const turn = await think({ message: candidate, sessionId: "guard-e2e" }, state);
  check("the model path was the one taken", turn.message.engine === "llm", String(turn.message.engine));
  check(
    "the user is given the honest line, not the lie",
    turn.message.text === NOTHING_CHANGED,
    JSON.stringify(turn.message.text.slice(0, 120)),
  );
});

/* ------------------------------------------------------------------ */
/* Criterion 5 - no key configured: the loop is never entered          */
/* ------------------------------------------------------------------ */

await group("With no model configured, nothing is asked and nothing changes", async () => {
  await useModel(false);

  check("the client reports no model", llmAvailable() === false);

  const state = emptyState();
  const text = "tell me a story about the sea";
  const local = localMind({ text, lifeState: state, sessionId: "no-key" });
  check(
    "the utterance is one the local engine itself does not resolve",
    local.outcome === undefined && !local.cards?.length,
    local.outcome ? `effect ${local.outcome.effect}` : `cards ${local.cards?.length ?? 0}`,
  );

  const before = requests.length;
  const turn = await think({ message: text, sessionId: "no-key" }, state);

  check("the turn still answers", turn.message.text.trim().length > 0, turn.message.text.slice(0, 120));
  check("it is the local engine that answered", turn.message.engine === "local", String(turn.message.engine));
  check(
    "with the local engine's own sentence, unchanged",
    turn.message.text === local.text,
    `${JSON.stringify(local.text.slice(0, 80))} vs ${JSON.stringify(turn.message.text.slice(0, 80))}`,
  );
  check("no request reached the provider", requests.length === before, `${before} -> ${requests.length}`);
});

/* ------------------------------------------------------------------ */
/* Criterion 7 - a tool call written as text is recovered, not shown    */
/* ------------------------------------------------------------------ */

await group("A tool call written into the reply is recovered, not printed", async () => {
  /**
   * Turn the model back on, explicitly.
   *
   * The group above deliberately switches it off, and the only thing that
   * switched it back on was `think()` being called again - which meant this
   * section silently ran with no model at all: no loop, no recovery, no
   * warning, and a failure that looked like a recovery bug rather than a
   * missing stub. Spending one line to state the precondition is cheaper than
   * debugging that twice.
   */
  await useModel(true);
  check("the model is configured for this section", llmAvailable() === true);

  const { recoverTextToolCalls, stripToolMarkup, looksLikeToolMarkup } = await import(
    "../src/lib/mind/tools"
  );
  const { announcesToolUse } = await import("../src/lib/mind/agent");

  /*
   * The exact shape observed live on a real turn: asked to compare two corners
   * of her own data, the model put its intended call into the text channel. It
   * reached the user as machine syntax with no tool run and no guard tripped,
   * because a guard looks for a false *claim* and library syntax is not one.
   */
  const observed = `<||DSML||tool_calls>
<||DSML||invoke name="get_goals">
</||DSML||invoke>
<||DSML||invoke name="get_tasks">
</||DSML||invoke>
</||DSML||tool_calls>`;
  const recovered = recoverTextToolCalls(observed);
  check("both intended calls are recovered", recovered.calls.length === 2, JSON.stringify(recovered.calls));
  check("with the right names", recovered.calls.map((c) => c.name).join(",") === "get_goals,get_tasks");
  check("and nothing of the markup survives into the reply", !/DSML|invoke/.test(recovered.cleaned), JSON.stringify(recovered.cleaned));

  const withArgs = recoverTextToolCalls(
    '<|tool_calls|><|invoke name="create_task"><|parameter name="title">Buy milk</|parameter><|parameter name="due">2026-10-16</|parameter></|invoke></|tool_calls|>',
  );
  check("arguments are recovered", withArgs.calls.length === 1 && withArgs.calls[0].name === "create_task", JSON.stringify(withArgs.calls));
  check("string arguments stay strings", withArgs.calls[0]?.args.title === "Buy milk", JSON.stringify(withArgs.calls[0]?.args));
  check("and a date is not mangled into a number", withArgs.calls[0]?.args.due === "2026-10-16", JSON.stringify(withArgs.calls[0]?.args));

  const numeric = recoverTextToolCalls(
    '<|invoke name="start_focus"><|parameter name="minutes">45</|parameter></|invoke>',
  );
  check("a numeric argument is coerced back to a number", numeric.calls[0]?.args.minutes === 45, JSON.stringify(numeric.calls[0]?.args));

  /*
   * The THIRD observed spelling: full-width pipes, U+FF5C, not ASCII U+007C.
   *
   * Indistinguishable from the ASCII form in a terminal and in review, which is
   * exactly why it cost four wasted rounds live - the patterns were built from
   * ASCII and matched nothing while looking like they should have matched
   * everything. Built here from codepoints so no editor can normalise the test
   * into agreement with a broken implementation.
   */
  const P = "\uFF5C";
  const fullWidth =
    `<${P}${P}DSML${P}${P} calls>\n<${P}${P}DSML${P}${P} invoke name="get_goals">\n</${P}${P}DSML${P}${P} invoke>\n</${P}${P}DSML`;
  const fw = recoverTextToolCalls(fullWidth);
  check("full-width fences are detected", looksLikeToolMarkup(fullWidth) === true);
  check("and the call inside is recovered", fw.calls.length === 1 && fw.calls[0].name === "get_goals", JSON.stringify(fw.calls));
  check("and nothing of it survives", stripToolMarkup(fullWidth) === "", JSON.stringify(stripToolMarkup(fullWidth)));

  /* The common case: an ordinary reply must pass through untouched. */
  const ordinary = "You have two things open and nothing on the calendar.";
  const untouched = recoverTextToolCalls(ordinary);
  check("an ordinary reply is not touched", untouched.calls.length === 0 && untouched.cleaned === ordinary);
  check("no markup in, no calls out", recoverTextToolCalls("").calls.length === 0);

  /*
   * The SECOND observed spelling, from a later run of the same question: the
   * model wrote `<tool_call>get_goals</tool_call>` that time. Both arrived live,
   * which is why the recognizer matches the shape rather than one string.
   */
  const secondForm = recoverTextToolCalls("<tool_call>get_goals</tool_call>");
  check("the bare tag form is recovered", secondForm.calls.length === 1 && secondForm.calls[0].name === "get_goals", JSON.stringify(secondForm.calls));
  check("and nothing of it survives", !/tool_call/i.test(secondForm.cleaned), JSON.stringify(secondForm.cleaned));

  const fnForm = recoverTextToolCalls('<tool_call>create_task{"title":"Buy milk"}</tool_call>');
  check("a name with a JSON body is recovered", fnForm.calls[0]?.name === "create_task", JSON.stringify(fnForm.calls));
  check("with its arguments", fnForm.calls[0]?.args.title === "Buy milk", JSON.stringify(fnForm.calls[0]?.args));

  const multi = recoverTextToolCalls(
    "<tool_call>get_goals</tool_call>\n<tool_call>get_health</tool_call>",
  );
  check("several bare calls are all recovered", multi.calls.length === 2, JSON.stringify(multi.calls.map((c) => c.name)));

  /* The net: anything left over is stripped, parseable or not. */
  check("the detector sees markup", looksLikeToolMarkup(observed) === true);
  check("and does not fire on a sentence", looksLikeToolMarkup(ordinary) === false);
  const debris = stripToolMarkup('<|invoke name="get_goals">\n<|invoke name="get_tasks">\n</|invoke>');
  check("unparseable debris is stripped anyway", !/invoke|tool_call/i.test(debris), JSON.stringify(debris));
  check("stripping is idempotent", stripToolMarkup(debris) === debris);
  check("a clean sentence survives stripping unchanged", stripToolMarkup(ordinary) === ordinary);

  /*
   * The FOURTH variant, and the one with no markup at all: the model told the
   * user what it was about to do and stopped. Both of these arrived live.
   */
  check("an announcement is recognised", announcesToolUse("(calling get_goals)") === true);
  check("and the other spelling of it", announcesToolUse("Calling: get_goals") === true);
  check("a real answer that mentions a tool name is not an announcement", announcesToolUse("I checked get_tasks and you have two open.") === false);
  check("a normal sentence is not an announcement", announcesToolUse("Nothing is scheduled at two.") === false);
  check("an answer with a number is not an announcement", announcesToolUse("get_goals shows nothing, and 3 tasks open") === false);

  /* Through the loop: the recovered call must actually run. */
  const state = emptyState();
  nextReplies({ payload: shaped('<|invoke name="get_tasks"></|invoke>') });
  const recoveredTurn = await think({ message: "what is on my list right now", sessionId: "recover-e2e" }, state);
  check("the turn still answers", recoveredTurn.message.text.trim().length > 0, recoveredTurn.message.text.slice(0, 120));
  check(
    "and the user never sees the markup",
    !/DSML|invoke|parameter/i.test(recoveredTurn.message.text),
    recoveredTurn.message.text.slice(0, 160),
  );

  /* And when the model answers with markup that is NOT recoverable, the reply
   * the user reads still contains none of it. */
  nextReplies({ payload: shaped('Here is the plan.<||DSML||tool_calls>\n<||DSML||invoke name="') });
  const debrisTurn = await think({ message: "compare my goals with my list", sessionId: "debris-e2e" }, state);
  check(
    "unrecoverable markup never reaches the user",
    !looksLikeToolMarkup(debrisTurn.message.text),
    debrisTurn.message.text.slice(0, 160),
  );

  /* An announcement mid-loop makes the loop ask again rather than showing it. */
  nextReplies(
    { payload: shaped("(calling get_goals)") },
    { payload: shaped("You have no goals on the board.") },
  );
  const announcedTurn = await think({ message: "compare my year against my list", sessionId: "announce-e2e" }, state);
  check(
    "an announced call is not shown as the answer",
    !/calling get_goals/i.test(announcedTurn.message.text),
    announcedTurn.message.text.slice(0, 160),
  );

  /*
   * THE ORDERING, which cost four live rounds when it was backwards.
   *
   * The full-width DSML form contains a tool name, so an announcement check
   * running *before* recovery matches it and asks the model to try again - four
   * times - instead of recovering the call sitting in the text, and the turn
   * ends in a refusal. This asserts recovery is reached first, by giving the
   * loop the ambiguous input and requiring that it be RECOVERED rather than
   * re-asked.
   */
  const ambiguous = `<${P}${P}DSML${P}${P} calls>\n<${P}${P}DSML${P}${P} invoke name="get_goals">\n</${P}${P}DSML${P}${P} invoke>`;
  check("the ambiguous input is what recovery expects", recoverTextToolCalls(ambiguous).calls.length === 1, JSON.stringify(recoverTextToolCalls(ambiguous).calls));
  nextReplies({ payload: shaped(ambiguous) }, { payload: shaped("You have no goals on the board.") });
  const orderedTurn = await think({ message: "compare my year against my list", sessionId: "order-e2e" }, state);
  check(
    "the full-width DSML call is recovered, not treated as an announcement",
    orderedTurn.message.text === "You have no goals on the board.",
    JSON.stringify(orderedTurn.message.text.slice(0, 120)),
  );
  check(
    "and no markup reached the user either way",
    !looksLikeToolMarkup(orderedTurn.message.text) && !/DSML/i.test(orderedTurn.message.text),
    orderedTurn.message.text.slice(0, 120),
  );
});

/* ------------------------------------------------------------------ */
/* The real database was never touched                                  */
/* ------------------------------------------------------------------ */

await group("The real database was never touched", () => {
  if (!realBefore) {
    check("there was no real database to protect", true);
    return;
  }
  const realAfter = statSync(REAL_DB);
  check("its size is unchanged", realAfter.size === realBefore.size, `${realBefore.size} -> ${realAfter.size}`);
  check(
    "its modification time is unchanged",
    realAfter.mtimeMs === realBefore.mtimeMs,
    `${realBefore.mtimeMs} -> ${realAfter.mtimeMs}`,
  );
  check(
    "and this suite ran against the copy",
    process.env.XANA_DATA_DIR === SCRATCH,
    String(process.env.XANA_DATA_DIR),
  );
});

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed\n`);

store.close();
server.close();
rmSync(SCRATCH, { recursive: true, force: true });
process.exitCode = failed === 0 ? 0 : 1;
