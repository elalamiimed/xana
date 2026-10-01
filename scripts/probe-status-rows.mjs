/**
 * Can `/api/context` serve fewer status rows than there are connections?
 *
 * The invariant the app documents is one row per connection, always: the UI
 * cannot lose a row when something is switched off, because a missing row is
 * indistinguishable from a connection that does not exist. `verify:web` asserts
 * it, and it failed once out of four runs — which is either a flake in the test
 * or a real race in the assembly, and the two deserve different fixes.
 *
 * This hammers both endpoints and prints any sample where the counts disagree,
 * with the row ids, so a mismatch can be read rather than guessed at.
 *
 *   node scripts/probe-status-rows.mjs [samples]
 */

const BASE = process.env.XANA_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? "4310"}`;
const SAMPLES = Number(process.argv[2] ?? 25);

const expected = (await (await fetch(`${BASE}/api/connections`)).json()).plugins.map((p) => p.id);
console.log(`connections: ${expected.length} — ${expected.join(", ")}\n`);

let mismatches = 0;
for (let i = 1; i <= SAMPLES; i++) {
  const mode = i % 3 === 0 ? "?force=1" : "";
  const body = await (await fetch(`${BASE}/api/context${mode}`)).json();
  const rows = body.lifeState?.sources ?? [];
  const ids = rows.map((r) => r.id);
  const missing = expected.filter((id) => !ids.includes(id));
  const extra = ids.filter((id) => !expected.includes(id));

  if (rows.length !== expected.length) {
    mismatches++;
    console.log(
      `sample ${String(i).padStart(2)} ${mode || "(cached)"}  ${rows.length} rows, expected ${expected.length}` +
        `${missing.length ? `  missing: ${missing.join(", ")}` : ""}${extra.length ? `  extra: ${extra.join(", ")}` : ""}`,
    );
  } else if (i === 1 || i === SAMPLES) {
    console.log(`sample ${String(i).padStart(2)} ${mode || "(cached)"}  ${rows.length} rows, matches`);
  }
  // A cached read is allowed to be four seconds old; a forced one is not
  // allowed to be short at all. Pause only between cached samples so the TTL
  // can actually lapse and the race, if there is one, has a chance to show.
  if (mode === "") await new Promise((r) => setTimeout(r, 250));
}

console.log(`\n${mismatches} mismatch${mismatches === 1 ? "" : "es"} in ${SAMPLES} samples`);
