/**
 * Grant the network-facing connections their capabilities, one at a time.
 *
 * This exists as a script rather than a curl command for a reason that is the
 * whole point of the permission system: it goes through `POST /api/connections`
 * with one `{ id, action }` per connection, which is the same call the Allow
 * button makes. A blanket write of `{"net.read": true}` into the settings file
 * would produce the same field value and a completely different audit trail —
 * and the trail is what a revocation is based on.
 *
 * Order matters twice:
 *
 *  - **Capabilities accumulate.** Granting `net.read` for `markets` also
 *    satisfies `crypto`, which is why a connection that needs two capabilities
 *    may read as blocked after its first grant and ready after the second.
 *  - **Weather before Google Calendar**, because weather is what grants
 *    `location`, and Google's `account` arrives with the weather grant only for
 *    `net.read`. The loop runs twice for exactly this reason: the second pass
 *    picks up whatever the first pass unblocked.
 *
 *   node scripts/grant-connections.mjs [id ...]
 */

const BASE = process.env.XANA_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? "4310"}`;

/** Everything that has a network half, plus the folder readers that do not. */
const ALL = [
  "calendar",
  "tasks",
  "notes",
  "health",
  "media",
  "mail",
  "markets",
  "crypto",
  "weather",
  "google-calendar",
];

async function connections() {
  const response = await fetch(`${BASE}/api/connections`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`GET /api/connections answered ${response.status}`);
  return response.json();
}

async function grant(id) {
  const response = await fetch(`${BASE}/api/connections`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, action: "grant" }),
    signal: AbortSignal.timeout(30_000),
  });
  return response.json();
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const targets = wanted.length > 0 ? wanted : ALL;

const before = await connections();
console.log(
  `before  ${before.groups.map((g) => `${g.label} ${g.ready}/${g.plugins.length}`).join("  |  ")}`,
);

/**
 * Two passes. The first grants everything asked for; the second re-grants only
 * what is still blocked, which is how a connection needing two capabilities
 * (`weather`: net.read + location) gets its second one without a third pass.
 * A third pass would be dead code — no connection here needs three.
 */
for (let pass = 1; pass <= 2; pass++) {
  const state = await connections();
  const blocked = state.plugins.filter((p) => targets.includes(p.id) && p.missing.length > 0);
  if (blocked.length === 0) {
    if (pass === 1) console.log("nothing to do: every requested connection already has its capabilities");
    break;
  }
  console.log(`\npass ${pass}`);
  for (const plugin of blocked) {
    const result = await grant(plugin.id);
    console.log(
      `  ${result.ok ? "granted" : "FAILED "} ${plugin.id.padEnd(16)} was missing ${plugin.missing.join(", ")}`,
    );
  }
}

const after = await connections();
console.log(`\nafter   ${after.groups.map((g) => `${g.label} ${g.ready}/${g.plugins.length}`).join("  |  ")}`);
console.log(`grants  ${JSON.stringify(after.grants)}`);
console.log(`still blocked: ${after.plugins.filter((p) => p.missing.length > 0).map((p) => p.id).join(", ") || "none"}`);
console.log(`missing a setting: ${after.plugins.filter((p) => p.missingConfig.length > 0).map((p) => `${p.id} (${p.missingConfig.join(", ")})`).join(", ") || "none"}`);
