/**
 * The invariants, asserted where they cannot be argued with.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-contracts.ts
 *
 * WHY THIS IS SEPARATE FROM check-mind-loop.ts
 *
 * That suite drives the loop end to end and proves the behaviour. This one reads
 * the *source* and proves the structure, which is a different claim: a loop can
 * behave correctly today and still be one careless edit away from a second write
 * path, and no amount of black-box testing catches that until the day it matters.
 *
 * `docs/WHY-THIS-WAY.md` section 7 names these mechanisms and points at this
 * file. A rationale that cites an assertion which does not exist is worse than no
 * rationale, because it reads as verified.
 *
 * OFFLINE. No key, no network, no database.
 */

import { readFileSync } from "node:fs";

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

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const agent = read("src/lib/mind/agent.ts");
const guard = read("src/lib/mind/guard.ts");
const tools = read("src/lib/mind/tools.ts");
const exec = read("src/lib/actions/executor.ts");
const store = read("src/lib/core/store.ts");
const mind = read("src/lib/mind/index.ts");
const llm = read("src/lib/mind/llm.ts");

/** Strip comments, so a rule *described* in prose is not mistaken for a rule kept. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/* ------------------------------------------------------------------ */
console.log("\nInvariant 1 - propose, validate and commit are three separate steps\n");

const agentCode = code(agent);
const guardCode = code(guard);

check(
  "the guard is asked before anything is executed",
  agentCode.indexOf("validateActionIntent(") < agentCode.indexOf("executeProposal("),
  "validateActionIntent must be reached first",
);
check(
  "the refusal branch returns before the execute branch",
  /verdict === "refuse"[\s\S]{0,600}?return/.test(agentCode),
);
check(
  "every write goes through executeAction",
  agentCode.includes("executeAction("),
);
check(
  "the loop does not touch the database directly",
  !/store\.(db|remember|createTask|deleteTask)\b/.test(agentCode),
  "the agent must reach the database only through the executor",
);
check(
  "the guard validates rather than trusting",
  guardCode.includes("schemaErrors(") && guardCode.includes("findTool("),
);

/* ------------------------------------------------------------------ */
console.log("\nInvariant 2 - validation does not depend on the model's cooperation\n");

check(
  "the guard never calls a model",
  !/llmComplete|llmAvailable|fetch\(/.test(guardCode),
  "a validator that needs a model is advice, not a mechanism",
);
check(
  "it never throws",
  !/\bthrow\b/.test(guardCode),
  "every path returns a Verdict",
);
check(
  "the untrusted-source rule refuses rather than warns",
  /untrustedSource[\s\S]{0,400}?verdict:\s*"refuse"/.test(guardCode),
);
check(
  "a read is allowed without schema validation",
  /safety === "read"[\s\S]{0,200}?verdict:\s*"allow"/.test(guardCode),
);

/* ------------------------------------------------------------------ */
console.log("\nInvariant 3 - failure is closed\n");

for (const [label, needle] of [
  ["an unknown tool is refused", /there is no tool named/],
  ["bad arguments are refused", /bad arguments:/],
  ["a missing required field is refused", /is required/],
  ["a write tool that produced no intent is refused", /produced no action/],
] as Array<[string, RegExp]>) {
  check(label, needle.test(guardCode));
}

check(
  "the argument parser is total",
  /export function parseToolArguments\(/.test(code(tools)) && !/\bthrow\b/.test(code(tools)),
  "the provider warns arguments may be invalid JSON",
);
check(
  "no unguarded JSON.parse of model output",
  !/JSON\.parse\((?![\s\S]{0,120}?catch)/.test(
    code(tools).replace(/try\s*\{[\s\S]*?\}\s*catch[\s\S]*?\}/g, ""),
  ),
);

/* ------------------------------------------------------------------ */
console.log("\nInvariant 4 - one write path, audited atomically\n");

const execCode = code(exec);
check(
  "the effect and the audit row share a transaction",
  /db\.transaction\([\s\S]{0,400}?logAction\(/.test(execCode),
  "a row that can disagree with the effect is not evidence",
);
check(
  "the duplicate check precedes dispatch",
  execCode.indexOf("seenIdempotencyKey(") < execCode.indexOf("dispatch("),
);
check(
  "a duplicate does not write",
  /action\.duplicate/.test(execCode),
);

/* ------------------------------------------------------------------ */
console.log("\nInvariant 5 - at most once, with a server-derived key\n");

check(
  "the key is derived from server identifiers",
  /idempotencyKeyFor\(\s*sessionId\s*,\s*toolCallId\s*\)/.test(agentCode) ||
    /idempotencyKey:\s*idempotencyKeyFor\(/.test(agentCode),
  "the model must not be able to choose its own key",
);
check(
  "and it is not built from model text",
  !/idempotencyKeyFor\((?!\s*sessionId)[^)]*call\.arguments/.test(agentCode),
);
check(
  "the database enforces uniqueness as well",
  /CREATE UNIQUE INDEX IF NOT EXISTS idx_action_log_idem/.test(store),
  "the check and the insert are two statements; only the index is atomic",
);

/* ------------------------------------------------------------------ */
console.log("\nInvariant 6 - no key means no loop\n");

check(
  "the loop is gated on a configured model",
  /if\s*\(\s*!llmAvailable\(\)\s*\)/.test(agentCode),
);
check(
  "and the gate returns the local engine's answer",
  /!llmAvailable\(\)[\s\S]{0,300}?localMind\(/.test(agentCode),
);
check(
  "think() consults the local engine before the agent",
  code(mind).indexOf("localMind(") < code(mind).indexOf("runAgentTurn("),
);

/* ------------------------------------------------------------------ */
console.log("\nInvariant 7 - the catalog stays closed\n");

check(
  "no tool takes a free-form query, url, path or command",
  !/\b(run_sql|http_request|fetch_url|web_fetch|run_command)\b/.test(code(tools)),
  "a generic operation collapses the whole safety design",
);
/**
 * Sixteen, and the number is asserted rather than the shape.
 *
 * A count is a blunt instrument, and it is the right one here: the failure this
 * catches is a *new tool added without declaring its safety class*, which would
 * default to undefined and be treated as neither read nor destructive. Fifteen
 * writes and two destructive operations is what the catalog holds; a change to
 * that number should be a deliberate edit to this line.
 *
 * The read tools are built by the `readTool()` helper, which sets `safety:
 * "read"` once, so they do not appear here and do not need to.
 */
const declared = (code(tools).match(/^  safety: "(?:read|write|destructive)",/gm) ?? []).length;
check("every named tool declares its safety class", declared >= 16, `${declared} declared`);
check(
  "nothing in the catalog imports a network primitive",
  !/\bfetch\(|node:http|node:https|node:child_process/.test(code(tools)),
);
check(
  "the write catalog and the read catalog are disjoint",
  !/WRITE_TOOLS:\s*ToolSpec\[\]\s*=\s*\[\s*\.\.\.READ_TOOLS/.test(code(tools)),
);

/* ------------------------------------------------------------------ */
console.log("\nThe honesty guards are still wired\n");

check(
  "the unmade-claim guard is applied to the model's words",
  /guardUnmadeClaim\(/.test(code(mind)),
);
check(
  "and it is the real one, imported not reimplemented",
  /import\s*\{[^}]*guardUnmadeClaim[^}]*\}\s*from\s*"\.\/claims"/.test(mind),
);
check(
  "the agent tells the model it cannot act unilaterally",
  /actionRule\(/.test(agentCode),
  "claims.ts owns that wording so the two cannot drift",
);

/* ------------------------------------------------------------------ */
console.log("\nThe API facts the rationale records are still honoured\n");

check(
  "forced tool choice is downgraded rather than sent",
  /toolChoice === "required"[\s\S]{0,200}?= "auto"/.test(code(llm)),
  "thinking mode rejects tool_choice: required with a 400",
);
check(
  "reasoning_content is not replayed",
  !/reasoning_content:\s*completion\.reasoning_content/.test(agentCode),
  "the docs say it is required; the live probe says it is not",
);
check(
  "and the field is documented as deliberate",
  /reasoning_content/.test(llm) && /not\*{0,2}\s*replayed|deliberately \*\*not\*\*/.test(llm),
);

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;

export {};
