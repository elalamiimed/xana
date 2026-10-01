/**
 * Route-level smoke test.
 *
 * `next build` finishes compiling here but its page-data phase forks worker
 * processes, which some sandboxes deny. Rather than assume the routes work,
 * this calls the real handler modules — the same `route.ts` files Next serves —
 * and inspects the `NextResponse` they return.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/routes.ts
 *
 * It exercises exactly the four endpoints the UI consumes, over the real
 * adapters, executor and life-state assembly. The only thing it does not cover
 * is Next's own HTTP transport.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { XanaStore, setStore } from "../src/lib/core/store";
import { invalidateContext } from "../src/lib/context/gateway";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n${"─".repeat(66)}\n${title}\n${"─".repeat(66)}`);
}

/** Pull the JSON body out of a NextResponse regardless of version details. */
async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { __raw: text.slice(0, 300) };
  }
}

function jsonRequest(url: string, payload?: unknown): Request {
  return new Request(url, {
    method: payload === undefined ? "GET" : "POST",
    headers: payload === undefined ? undefined : { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "xana-routes-"));
  const store = new XanaStore(path.join(dir, "routes.db"));
  setStore(store);
  invalidateContext();

  const base = "http://127.0.0.1:4310";

  /* ---------------- dynamic imports: handlers load after the store swap --- */
  const contextRoute = await import("../src/app/xana/context/route");
  const contextAlias = await import("../src/app/api/context/route");
  const stateRoute = await import("../src/app/api/state/route");
  const chatRoute = await import("../src/app/api/chat/route");
  const actionRoute = await import("../src/app/api/action/route");
  const { getRegistry } = await import("../src/lib/plugins/registry");

  /* ---------------- GET /xana/context ---------------- */

  section("GET /xana/context — the unified gateway");

  const ctxResponse = await contextRoute.GET(jsonRequest(`${base}/xana/context`));
  check("returns 200", ctxResponse.status === 200, String(ctxResponse.status));
  const ctx = await bodyOf(ctxResponse);
  const lifeState = ctx.lifeState as Record<string, unknown> | undefined;
  check("body carries lifeState", Boolean(lifeState));
  if (lifeState) {
    check("has a generatedAt", typeof lifeState.generatedAt === "string");
    check("has a headline", typeof lifeState.headline === "string");
    check("has energy", typeof (lifeState.energy as Record<string, unknown>)?.score === "number");
    // One status row per registered connection, including the ones that are
    // switched off. The expected count comes from the register rather than a
    // literal: a literal tests the register's contents (and went stale the day
    // crypto was added) instead of the property — the UI can never lose a row.
    check(
      "reports one status row per connection",
      Array.isArray(lifeState.sources) &&
        (lifeState.sources as unknown[]).length === getRegistry().list().length,
      `${(lifeState.sources as unknown[])?.length} rows for ${getRegistry().list().length} connections`,
    );
    check("is JSON-serialisable round trip", JSON.stringify(lifeState).length > 200);
  }

  /* ---------------- GET /api/context (alias) ---------------- */

  section("GET /api/context — the UI's contracted path");

  const aliasResponse = await contextAlias.GET(jsonRequest(`${base}/api/context`));
  check("returns 200", aliasResponse.status === 200, String(aliasResponse.status));
  const alias = await bodyOf(aliasResponse);
  check("returns the same shape as /xana/context", Boolean(alias.lifeState));

  /* ---------------- GET /api/state ---------------- */

  section("GET /api/state — the ambient poll");

  const stateResponse = await stateRoute.GET();
  check("returns 200", stateResponse.status === 200, String(stateResponse.status));
  const ambient = await bodyOf(stateResponse);
  check("has presence", typeof ambient.presence === "string", String(ambient.presence));
  check("has headline", typeof ambient.headline === "string");
  check("has energy band", typeof (ambient.energy as Record<string, unknown>)?.band === "string");
  check(
    "engine is llm or local",
    ambient.engine === "llm" || ambient.engine === "local",
    String(ambient.engine),
  );
  console.log(`  payload: ${JSON.stringify(ambient)}`);

  /* ---------------- POST /api/chat ---------------- */

  section("POST /api/chat — a real conversation");

  const turns = [
    "remind me to call Mom Friday",
    "add a task to review the Aurora scheduler PR",
    "what can you do",
    "brief me",
    "flurble the womp",
  ];

  for (const turn of turns) {
    const response = await chatRoute.POST(jsonRequest(`${base}/api/chat`, { message: turn, sessionId: "smoke" }));
    const body = await bodyOf(response);
    const message = body.message as Record<string, unknown> | undefined;
    const text = typeof message?.text === "string" ? message.text : "";
    console.log(`  you  │ ${turn}`);
    console.log(`  xana │ ${text}`);
    check(`200 for "${turn}"`, response.status === 200, String(response.status));
    check(`reply is non-empty for "${turn}"`, text.length > 0);
    check(`reply carries lifeState for "${turn}"`, Boolean(body.lifeState));
  }

  /* ---------------- POST /api/chat validation ---------------- */

  section("POST /api/chat — input validation");

  const emptyResponse = await chatRoute.POST(jsonRequest(`${base}/api/chat`, { message: "   " }));
  check("rejects an empty message with 400", emptyResponse.status === 400, String(emptyResponse.status));

  const longResponse = await chatRoute.POST(jsonRequest(`${base}/api/chat`, { message: "x".repeat(5000) }));
  check("rejects an oversized message with 413", longResponse.status === 413, String(longResponse.status));

  /* ---------------- POST /api/action ---------------- */

  section("POST /api/action — one-tap write-back");

  const createResponse = await actionRoute.POST(
    jsonRequest(`${base}/api/action`, {
      action: { type: "create_task", title: "Smoke test task", priority: 2 },
    }),
  );
  const created = await bodyOf(createResponse);
  const outcome = created.outcome as Record<string, unknown> | undefined;
  check("creates a task", createResponse.status === 200 && outcome?.effect === "task.created", String(outcome?.effect));
  console.log(`  xana │ ${outcome?.message}`);

  const taskId = Array.isArray(outcome?.ids) ? String((outcome.ids as string[])[0]) : "";
  const completeResponse = await actionRoute.POST(
    jsonRequest(`${base}/api/action`, { action: { type: "complete_task", taskId } }),
  );
  const completed = await bodyOf(completeResponse);
  check(
    "completes it",
    (completed.outcome as Record<string, unknown>)?.effect === "task.completed",
    JSON.stringify(completed.outcome),
  );
  console.log(`  xana │ ${(completed.outcome as Record<string, unknown>)?.message}`);

  const badResponse = await actionRoute.POST(
    jsonRequest(`${base}/api/action`, { action: { type: "launch_missiles" } }),
  );
  check("rejects an unknown action with 400", badResponse.status === 400, String(badResponse.status));

  const missingResponse = await actionRoute.POST(
    jsonRequest(`${base}/api/action`, { action: { type: "complete_task", taskId: "does-not-exist" } }),
  );
  check("refuses an unknown task id with 422", missingResponse.status === 422, String(missingResponse.status));

  /* ---------------- Write-back visibility ---------------- */

  section("Write-back visibility — does a write show up in the next read?");

  await actionRoute.POST(
    jsonRequest(`${base}/api/action`, {
      action: { type: "create_task", title: "Visible immediately", priority: 1 },
    }),
  );
  const after = await bodyOf(await stateRoute.GET());
  const ctxAfter = await bodyOf(await contextRoute.GET(jsonRequest(`${base}/xana/context`)));
  const afterLife = ctxAfter.lifeState as Record<string, unknown>;
  const tasks = afterLife.tasks as Record<string, unknown>;
  const focus = (tasks.focus ?? []) as Array<Record<string, unknown>>;
  check(
    "the new task appears without waiting for a TTL",
    focus.some((t) => String(t.title).includes("Visible immediately")),
    focus.map((t) => t.title).join(", "),
  );
  void after;

  /* ---------------- Result ---------------- */

  section("Result");
  console.log(`  ${passed} passed, ${failed} failed\n`);

  invalidateContext();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  if (failed > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error("\nRoute smoke test failed:", err instanceof Error ? err.message : err);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exitCode = 1;
});
