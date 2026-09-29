/**
 * Reproduce the key-save path exactly as the panel performs it.
 *
 *   node scripts/debug-key.mjs [baseUrl]
 *
 * The backend has been shown to store a key correctly, so if a key goes
 * missing it is lost between the panel and the request. This walks the
 * orderings a user actually performs and reports what the server saw after
 * each one.
 */

const base = process.argv[2] ?? "http://127.0.0.1:4310";

async function getSettings() {
  const res = await fetch(`${base}/api/settings`, { cache: "no-store" });
  return (await res.json()).settings;
}

async function put(settings) {
  const res = await fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body.settings;
}

function report(label, settings) {
  const k = settings.model.apiKey;
  console.log(
    `  ${label.padEnd(46)} present=${String(k.present).padEnd(5)} from=${k.from.padEnd(8)} active=${settings.effective.active}`,
  );
}

/** Exactly what the panel builds. `apiKey` is omitted when the field is empty. */
function panelPatch({ enabled, provider, model, baseUrl, temperature, apiKey, clearApiKey }) {
  return {
    model: {
      enabled,
      provider,
      model,
      baseUrl,
      temperature,
      ...(clearApiKey ? { clearApiKey: true } : apiKey ? { apiKey } : {}),
    },
  };
}

async function main() {
  console.log(`Reproducing the key-save path at ${base}\n`);

  console.log("0. baseline");
  report("current state", await getSettings());

  console.log("\n1. the reported failure: type a key, press Save (no Test first)");
  const typed = "sk-flowtest-SAVE-without-test";
  let s = await put(
    panelPatch({
      enabled: true,
      provider: "openai",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
      temperature: 0.7,
      apiKey: typed,
    }),
  );
  report("after save", s);

  // Read it straight back, the way reopening the panel would.
  s = await getSettings();
  report("after re-reading settings", s);

  console.log("\n2. the other order: type a key, Test, then Save");
  const second = "sk-flowtest-TEST-then-save";
  const probe = await fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      settings: {
        ...panelPatch({
          enabled: true,
          provider: "openai",
          model: "deepseek-chat",
          baseUrl: "https://api.deepseek.com/v1",
          temperature: 0.7,
          apiKey: second,
        }),
        testModel: true,
      },
    }),
  });
  const probeBody = await probe.json();
  console.log(`  probe ran: ${probeBody.probe ? "yes" : "no"} (ok=${probeBody.probe?.ok})`);
  console.log(`  probe message: ${probeBody.probe?.message?.slice(0, 90)}`);

  // A probe must not persist anything.
  s = await getSettings();
  report("after the probe alone", s);
  const stillFirst = s.model.apiKey.masked.endsWith(typed.slice(-4));
  console.log(
    `  ${stillFirst ? "ok  " : "BUG "} the probe did not overwrite the stored key`,
  );

  console.log("\n3. save the second key, which is what the panel does next");
  s = await put(
    panelPatch({
      enabled: true,
      provider: "openai",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
      temperature: 0.7,
      apiKey: second,
    }),
  );
  report("after save", s);
  console.log(
    `  ${s.model.apiKey.masked.endsWith(second.slice(-4)) ? "ok  " : "BUG "} the stored key is the newest one`,
  );

  console.log("\n4. save again with the field left empty (must keep, not clear)");
  s = await put(
    panelPatch({
      enabled: true,
      provider: "openai",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
      temperature: 0.7,
      apiKey: "",
    }),
  );
  report("after an empty-field save", s);
  console.log(
    `  ${s.model.apiKey.present ? "ok  " : "BUG "} an empty field kept the stored key`,
  );

  console.log("\n5. a literal KEEP_KEY must never become the stored value");
  s = await put(
    panelPatch({
      enabled: true,
      provider: "openai",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com/v1",
      temperature: 0.7,
      apiKey: "__xana_keep__",
    }),
  );
  report("after sending the sentinel", s);
  const leaked = s.model.apiKey.masked.includes("keep");
  console.log(`  ${leaked ? "BUG " : "ok  "} the sentinel was not stored as a key`);

  console.log("\n6. restore a clean state");
  await put(panelPatch({ enabled: true, provider: "openai", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", temperature: 0.7, clearApiKey: true }));
  report("after clear", await getSettings());
}

main().catch((err) => {
  console.error(`\nReproduction failed: ${err.message}`);
  process.exitCode = 1;
});
