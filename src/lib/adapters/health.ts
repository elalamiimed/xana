/**
 * Health adapter — sleep, activity and mood.
 *
 * There is no honest way to read Apple Health or Google Fit without OAuth, so
 * Xana does the next best thing: she ingests exported data. Apple Health
 * exports XML, Google Fit exports JSON, and both are one-time drops into a
 * folder. Point `XANA_HEALTH_DIR` at it and Xana reads every `.json`/`.jsonl`
 * sample there, newest wins.
 *
 * Also seeds from SQLite so the demo works with no files at all.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AdapterStatus, HealthSample, MoodLabel } from "../core/types";
import { getStore } from "../core/store";
import { cred, defineAdapter, status, type LifeAdapter } from "./types";

const MOODS: MoodLabel[] = ["low", "flat", "good", "bright"];

function asMood(v: unknown): MoodLabel | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.toLowerCase().trim();
  if ((MOODS as string[]).includes(s)) return s as MoodLabel;
  // Numeric-ish mood labels from various exporters.
  const n = Number(s);
  if (!Number.isNaN(n)) return MOODS[Math.min(3, Math.max(0, Math.round((n / 10) * 3)))];
  return undefined;
}

function num(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Accept several plausible key spellings so exports from different tools load. */
function normalize(raw: Record<string, unknown>): HealthSample | undefined {
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (raw[k] !== undefined && raw[k] !== null) return raw[k];
    }
    return undefined;
  };
  const dateRaw = pick("date", "day", "startDate", "start", "timestamp");
  if (typeof dateRaw !== "string") return undefined;
  const day = dateRaw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;

  const sample: HealthSample = {
    date: day,
    sleepHours: num(pick("sleepHours", "sleep_hours", "sleep", "asleepHours", "hoursAsleep")),
    sleepQuality: num(pick("sleepQuality", "sleep_quality", "sleepScore")),
    steps: num(pick("steps", "stepCount", "step_count")),
    activeMinutes: num(pick("activeMinutes", "active_minutes", "exerciseMinutes", "activityMinutes")),
    restingHeartRate: num(pick("restingHeartRate", "resting_heart_rate", "restingHr", "rhr")),
    mood: asMood(pick("mood", "moodLabel", "mood_label")),
    source: "import",
  };
  const hasAnything =
    sample.sleepHours !== undefined || sample.steps !== undefined ||
    sample.activeMinutes !== undefined || sample.mood !== undefined ||
    sample.restingHeartRate !== undefined;
  return hasAnything ? sample : undefined;
}

/** Parse either a JSON array, a JSONL stream, or a `{samples:[...]}` wrapper. */
export function parseHealthFile(text: string): HealthSample[] {
  const trimmed = text.trim();
  const out: HealthSample[] = [];

  const pushAll = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (item && typeof item === "object") {
        const s = normalize(item as Record<string, unknown>);
        if (s) out.push(s);
      }
    }
  };

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) pushAll(parsed);
      else if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        pushAll(obj.samples ?? obj.health ?? obj.data ?? obj.records);
        if (out.length === 0) {
          const single = normalize(obj);
          if (single) out.push(single);
        }
      }
      if (out.length > 0) return out;
    } catch {
      /* not a single JSON document — try JSONL below */
    }
  }

  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (!l || l.startsWith("//")) continue;
    try {
      const parsed = JSON.parse(l) as Record<string, unknown>;
      const s = normalize(parsed);
      if (s) out.push(s);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** Newest sample per day wins, so re-importing never double-counts. */
export function mergeByDay(samples: HealthSample[]): HealthSample[] {
  const map = new Map<string, HealthSample>();
  for (const s of samples) {
    const prev = map.get(s.date);
    if (!prev) {
      map.set(s.date, s);
      continue;
    }
    map.set(s.date, {
      date: s.date,
      sleepHours: s.sleepHours ?? prev.sleepHours,
      sleepQuality: s.sleepQuality ?? prev.sleepQuality,
      steps: s.steps ?? prev.steps,
      activeMinutes: s.activeMinutes ?? prev.activeMinutes,
      restingHeartRate: s.restingHeartRate ?? prev.restingHeartRate,
      mood: s.mood ?? prev.mood,
      source: prev.source === s.source ? s.source : `${prev.source}+${s.source}`,
    });
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function readHealthDir(dir: string): HealthSample[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  const walk = (d: string, depth = 0) => {
    if (depth > 3) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith(".")) continue;
      const full = path.join(d, e);
      try {
        if (existsSync(full) && readdirSafe(full)) walk(full, depth + 1);
        else if (/\.(json|jsonl|ndjson)$/i.test(e)) files.push(full);
      } catch {
        /* skip */
      }
    }
  };
  walk(dir);

  const all: HealthSample[] = [];
  for (const f of files.slice(0, 50)) {
    try {
      all.push(...parseHealthFile(readFileSync(f, "utf8")));
    } catch {
      /* skip unreadable */
    }
  }
  return mergeByDay(all);
}

function readdirSafe(p: string): boolean {
  try {
    readdirSync(p);
    return true;
  } catch {
    return false;
  }
}

export function healthAdapter(): LifeAdapter {
  const dir = cred("XANA_HEALTH_DIR");
  const id = "health";
  const label = dir.present ? "Health (import)" : "Health";

  const read = async (): Promise<{ data: { health: HealthSample[] }; status: AdapterStatus }> => {
    const t0 = Date.now();
    const store = getStore();
    const local = store.healthSamples(30);

    if (!dir.present) {
      return {
        data: { health: local },
        status: status(
          id, label, "local", "local",
          `${local.length} days · set XANA_HEALTH_DIR to import Apple Health / Google Fit exports`,
          Date.now() - t0,
        ),
      };
    }

    try {
      const imported = readHealthDir(dir.value);
      const merged = mergeByDay([...local, ...imported]);
      return {
        data: { health: merged },
        status: status(
          id, label, imported.length ? "connected" : "error",
          imported.length ? "live" : "local",
          imported.length ? `${imported.length} days imported` : "no readable health samples in folder",
          Date.now() - t0,
        ),
      };
    } catch {
      return {
        data: { health: local },
        status: status(id, label, "error", "local", "import folder unreadable", Date.now() - t0),
      };
    }
  };

  return defineAdapter<{ health: HealthSample[] }>({
    id,
    label,
    ttlMs: 5 * 60_000,
    empty: { health: [] },
    produce: read,
  });
}
