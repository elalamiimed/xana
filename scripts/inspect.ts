/**
 * Report what is actually on disk: the settings file and every table in the
 * SQLite store, with row counts.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/inspect.ts
 *
 * Read-only. This exists because "is my data saved?" should be answerable
 * without opening a SQLite browser, and because the answer needs to be
 * about *the real files* rather than about what the code intends.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

const root = process.cwd();
const settingsPath = join(root, "data", "settings.json");
const dbPath = join(root, "data", "xana.db");

function heading(text: string): void {
  console.log(`\n${"─".repeat(64)}\n${text}\n${"─".repeat(64)}`);
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

heading("Settings file");

if (!existsSync(settingsPath)) {
  console.log(`  ${settingsPath}`);
  console.log("  does not exist yet — defaults are in use");
} else {
  const stat = statSync(settingsPath);
  console.log(`  ${settingsPath}`);
  console.log(`  ${bytes(stat.size)}, modified ${stat.mtime.toISOString()}`);

  const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  const model = (raw.model ?? {}) as Record<string, unknown>;
  const identity = (raw.identity ?? {}) as Record<string, unknown>;
  const appearance = (raw.appearance ?? {}) as Record<string, unknown>;
  const sources = (raw.sources ?? {}) as Record<string, unknown>;

  console.log("\n  identity    " + (identity.name ? `name "${identity.name}"` : "unnamed") +
    (identity.location ? `, in ${identity.location}` : ""));
  console.log("  appearance  " + `theme ${appearance.theme} · rgb(${appearance.accent})`);
  console.log(
    "  model       " +
      (model.enabled
        ? `${model.provider}/${model.model}`
        : "off") +
      `, key ${typeof model.apiKey === "string" && model.apiKey.length > 0 ? `set (${model.apiKey.length} chars)` : "not set"}`,
  );
  console.log(
    "  sources     " +
      (Object.keys(sources).length > 0
        ? Object.keys(sources).join(", ")
        : "none configured"),
  );
}

/* ------------------------------------------------------------------ */
/* Database                                                           */
/* ------------------------------------------------------------------ */

heading("Life data (SQLite)");

if (!existsSync(dbPath)) {
  console.log(`  ${dbPath} does not exist yet`);
} else {
  const db = new Database(dbPath, { readonly: true });
  console.log(`  ${dbPath}`);
  console.log(`  ${bytes(statSync(dbPath).size)}`);

  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];

  console.log("");
  let total = 0;
  for (const { name } of tables) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get() as { c: number };
      total += row.c;
      if (row.c > 0) console.log(`  ${name.padEnd(24)} ${String(row.c).padStart(6)}`);
    } catch {
      console.log(`  ${name.padEnd(24)}   (unreadable)`);
    }
  }
  const empty = tables.length - tables.filter((t) => {
    try {
      return (db.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get() as { c: number }).c > 0;
    } catch {
      return false;
    }
  }).length;
  if (empty > 0) console.log(`  ${"(empty tables hidden)".padEnd(24)} ${String(empty).padStart(6)}`);
  console.log(`  ${"total rows".padEnd(24)} ${String(total).padStart(6)}`);

  /* The two things a conversation actually needs. */
  try {
    const recent = db
      .prepare("SELECT role, substr(text, 1, 60) AS text, created_at FROM conversation ORDER BY created_at DESC LIMIT 5")
      .all() as { role: string; text: string; created_at: string }[];
    if (recent.length > 0) {
      console.log("\n  most recent turns:");
      for (const row of recent.reverse()) {
        console.log(`    ${row.role.padEnd(6)} ${row.text.replace(/\s+/g, " ")}`);
      }
    }
  } catch {
    /* table name differs; the counts above still told the story */
  }

  db.close();
}

console.log("");
