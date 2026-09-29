/**
 * Why is a reply coming from the local engine when a model is configured?
 *
 *   node scripts/debug-engine.mjs [baseUrl]
 *
 * `llmAvailable()` is false in exactly three situations, and they look
 * identical from the chat window: no key is visible, the model is switched
 * off, or the resolved endpoint is unusable. This asks the server which one
 * it is at each step, so the answer does not have to be inferred from a
 * reply's metadata line.
 */

const base = process.argv[2] ?? "http://127.0.0.1:4310";

function line(label, value) {
  console.log(`  ${label.padEnd(34)} ${value}`);
}

async function settings() {
  return (await (await fetch(`${base}/api/settings`, { cache: "no-store" })).json()).settings;
}

async function state() {
  return (await (await fetch(`${base}/api/state`, { cache: "no-store" })).json());
}

async function put(patch) {
  const res = await fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: patch }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(body)}`);
  return body.settings;
}

async function ask(message) {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, sessionId: "engine-debug" }),
  });
  return (await res.json()).message;
}

console.log(`Diagnosing the engine at ${base}\n`);

/* ---------------- 1. what the server currently thinks ---------------- */
console.log("1. current state");
const s = await settings();
line("model.enabled (stored)", s.model.enabled);
line("model.provider", s.model.provider);
line("model.model", s.model.model);
line("model.baseUrl (stored)", s.model.baseUrl || "(empty)");
line("apiKey.present", s.model.apiKey.present);
line("apiKey.from", s.model.apiKey.from);
line("apiKey.masked", s.model.apiKey.masked || "(none)");
line("effective.active", s.effective.active);
line("effective.baseUrl", s.effective.baseUrl);
const st = await state();
line("/api/state engine", st.engine);

console.log("\n  what this means:");
if (!s.model.apiKey.present) {
  console.log("    -> No key is visible to the server. Nothing can call out.");
} else if (!s.model.enabled) {
  console.log("    -> A key is stored but the model is SWITCHED OFF.");
  console.log("       llmConfig() returns undefined when enabled is false,");
  console.log("       so every reply comes from the local engine.");
} else if (!s.effective.active) {
  console.log("    -> enabled and key are set but active is false; endpoint issue.");
} else {
  console.log("    -> The server believes a model is active. If replies still");
  console.log("       say 'local', the model call is failing and falling back.");
}

/* ---------------- 2. a real turn, and who answered it ---------------- */
console.log("\n2. a real turn right now");
const before = await ask("what's my day look like");
line("engine", before.engine);
line("latencyMs", before.latencyMs);
line("text", `${before.text?.slice(0, 70)}`);

/* ---------------- 3. with a key and the switch on ---------------- */
console.log("\n3. after storing a key AND switching the model on");
const secret = `sk-engine-debug-${Date.now().toString(36)}`;
const saved = await put({
  model: {
    enabled: true,
    provider: "openai",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com/v1",
    temperature: 0.7,
    apiKey: secret,
  },
});
line("apiKey.present", saved.model.apiKey.present);
line("model.enabled", saved.model.enabled);
line("effective.active", saved.effective.active);
line("/api/state engine", (await state()).engine);

const after = await ask("what's my day look like");
line("engine", after.engine);
line("latencyMs", after.latencyMs);
line("text", `${after.text?.slice(0, 90)}`);
console.log(
  `\n  ${after.engine === "llm" ? "-> the model is being called" : "-> STILL LOCAL: the call is failing or being skipped"}`,
);

/* ---------------- 4. the key-only case, which is the trap ---------------- */
console.log("\n4. with a key stored but the switch OFF (the likely trap)");
const off = await put({ model: { enabled: false, apiKey: secret } });
line("apiKey.present", off.model.apiKey.present);
line("model.enabled", off.model.enabled);
line("effective.active", off.effective.active);
const offTurn = await ask("hello");
line("engine for a plain hello", offTurn.engine);
console.log(
  `  ${offTurn.engine === "local" ? "-> reproduces: key stored, switch off, local answers" : "-> unexpected"}`,
);

/* ---------------- 5. leave it switched on with a key ---------------- */
console.log("\n5. leaving it configured and switched on");
const finalState = await put({ model: { enabled: true, apiKey: secret } });
line("model.enabled", finalState.model.enabled);
line("effective.active", finalState.effective.active);
console.log("\n  (clear it with: --clear)");

if (process.argv.includes("--clear")) {
  await put({ model: { clearApiKey: true } });
  console.log("  key cleared");
}
