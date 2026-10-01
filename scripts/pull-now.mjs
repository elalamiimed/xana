/**
 * Force a real read of every connection and report what each one managed.
 *
 * `?force=1` rather than the ordinary read: the ambient `/api/state` poll serves
 * a cached assembly, and a status row that is four seconds old is exactly the
 * thing that makes "did my grant do anything" unanswerable. The forced read
 * rebuilds the state from every adapter, so every row below is what the network
 * actually returned just now.
 *
 *   node scripts/pull-now.mjs
 */

const BASE = process.env.XANA_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? "4310"}`;

const started = Date.now();
const response = await fetch(`${BASE}/api/context?force=1`, { signal: AbortSignal.timeout(120_000) });
if (!response.ok) {
  console.error(`/api/context answered ${response.status}`);
  process.exit(1);
}
const { lifeState } = await response.json();

const rows = lifeState.sources ?? [];
console.log(`pulled in ${Date.now() - started} ms\n`);
const width = Math.max(...rows.map((r) => r.id.length));
for (const row of rows) {
  const mark = row.state === "connected" ? "ok  " : row.state === "blocked" ? "hold" : "    ";
  console.log(
    `${mark} ${row.id.padEnd(width)}  ${String(row.state).padEnd(9)} ${String(row.provenance ?? row.mode).padEnd(9)} ${row.detail ?? ""}`,
  );
}

const data = {
  weather: lifeState.weather
    ? `${lifeState.weather.location ?? "?"} · ${lifeState.weather.temperatureC}°C · ${lifeState.weather.condition}${lifeState.weather.synthetic ? " (synthetic)" : ""}`
    : "(none)",
  finance: (lifeState.finance ?? []).map((f) => `${f.label} ${f.value}`).join(" | ") || "(none)",
  calendar: `${lifeState.calendar?.today?.length ?? 0} today, ${lifeState.calendar?.freeMinutes ?? 0} min free`,
  tasks: `${lifeState.tasks?.openCount ?? 0} open (${lifeState.tasks?.focus?.length ?? 0} in focus)`,
  health: `${lifeState.health?.sleepAvgHours?.toFixed(1) ?? "?"}h sleep avg, debt ${lifeState.health?.sleepDebtHours?.toFixed(1) ?? "?"}h, ${lifeState.health?.moodTrend?.length ?? 0} mood days`,
  memory: `${lifeState.memory?.length ?? 0} recalled`,
  focus: `${lifeState.focus?.sessionsThisWeek?.length ?? 0} sessions, ${lifeState.focus?.totalMinutes ?? 0} min this week`,
  patterns: `${lifeState.patterns?.length ?? 0} detected`,
  nudges: `${lifeState.nudges?.length ?? 0}`,
  media: lifeState.media ? `${lifeState.media.title ?? "?"} — ${lifeState.media.artist ?? "?"}` : "(none)",
  mail: `${lifeState.mail?.length ?? 0} signals`,
};

console.log("");
for (const [key, value] of Object.entries(data)) console.log(`  ${key.padEnd(9)} ${value}`);

const connected = rows.filter((r) => r.state === "connected").length;
console.log(`\n${connected}/${rows.length} connected, ${rows.filter((r) => r.state === "error").length} errored, ${rows.filter((r) => r.state === "blocked").length} blocked`);
