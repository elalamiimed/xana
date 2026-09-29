/**
 * Adapter contract.
 *
 * Every life-data source Xana reads from is an `LifeAdapter`. The contract is
 * deliberately small so a new integration is one file:
 *
 *   fetch(snapshot) -> merge what you own into `snapshot`, report your status.
 *
 * Three rules every adapter follows:
 *  1. NEVER throw. A dead integration degrades to `offline`/`synthetic`, it does
 *     not take the day down with it.
 *  2. Only touch your own slice of the snapshot. Adapters never depend on each
 *     other's output — the merge order is therefore irrelevant.
 *  3. Report how you got the data (`mode`) so the UI can be honest about it.
 */

import type {
  AdapterStatus,
  CalendarEvent,
  FinanceSignal,
  HealthSample,
  MailSignal,
  MediaContext,
  Note,
  Task,
  WeatherSnapshot,
} from "../core/types";
import { credential } from "../settings/store";

/** The accumulators each adapter family writes into. */
export interface LifeSnapshot {
  tasks: Task[];
  events: CalendarEvent[];
  weather?: WeatherSnapshot;
  health: HealthSample[];
  notes: Note[];
  media?: MediaContext;
  finance: FinanceSignal[];
  mail: MailSignal[];
  statuses: AdapterStatus[];
}

export function emptySnapshot(): LifeSnapshot {
  return {
    tasks: [],
    events: [],
    health: [],
    notes: [],
    finance: [],
    mail: [],
    statuses: [],
  };
}

/**
 * The adapter shape. `fetch` merges its slice into `snapshot` and reports how
 * the read went.
 *
 * Two extra methods matter for the write-back path:
 *  - `state()` exposes the last-known status without doing any I/O, so the
 *    cheap presence loop can report freshness without paying for a refresh.
 *  - `invalidate()` drops the cached slice, so a write-back is visible on the
 *    very next read rather than whenever the TTL happens to lapse.
 */
export interface LifeAdapter {
  readonly id: string;
  readonly label: string;
  fetch(snapshot: LifeSnapshot): Promise<AdapterStatus>;
  state(): AdapterStatus | undefined;
  invalidate(): void;
}

/* ------------------------------------------------------------------ */
/* TTL caching                                                         */
/* ------------------------------------------------------------------ */

/**
 * Merge an adapter-owned slice into the shared snapshot. Arrays concatenate so
 * multiple adapters can contribute to the same collection (e.g. local events
 * plus an ICS feed); anything else overwrites.
 */
function mergeSlice<T>(snapshot: LifeSnapshot, data: T): void {
  if (data === null || data === undefined || typeof data !== "object") return;
  const target = snapshot as unknown as Record<string, unknown>;
  for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
    if (val === undefined) continue;
    const current = target[key];
    if (Array.isArray(val) && Array.isArray(current)) {
      current.push(...(val as unknown[]));
    } else {
      target[key] = val;
    }
  }
}

/**
 * Build an adapter whose reads are cached on a TTL, whose state is reportable
 * without I/O, and whose cache can be dropped on demand after a write-back.
 *
 * `empty` is the slice shape used before the first successful read.
 */
export function defineAdapter<T>(config: {
  id: string;
  label: string;
  ttlMs: number;
  empty: T;
  produce: () => Promise<{ data: T; status: AdapterStatus }>;
}): LifeAdapter {
  let at = 0;
  let value: T | undefined;
  let last: AdapterStatus | undefined;

  return {
    id: config.id,
    label: config.label,
    async fetch(snapshot: LifeSnapshot): Promise<AdapterStatus> {
      if (value !== undefined && last !== undefined && Date.now() - at < config.ttlMs) {
        mergeSlice(snapshot, value);
        return last;
      }
      const { data, status } = await config.produce();
      value = data;
      at = Date.now();
      last = status;
      mergeSlice(snapshot, data);
      return status;
    },
    state: () => last,
    invalidate() {
      // Force the next fetch to re-read. Without this, a write-back would not
      // appear until the adapter's TTL happened to expire.
      at = 0;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Uniform status builder so every adapter reports consistently. */
export function status(
  id: string,
  label: string,
  state: AdapterStatus["state"],
  mode: AdapterStatus["mode"],
  detail?: string,
  durationMs?: number,
): AdapterStatus {
  return { id, label, state, mode, detail, durationMs };
}

export interface Credential {
  value: string;
  present: boolean;
}

/**
 * Read a credential.
 *
 * Delegates to the settings layer, so a value configured in the UI wins
 * over one from the environment, and neither needs a restart to take
 * effect. Adapters call this rather than reading `process.env` directly,
 * which is what makes "paste your key into Settings" work without also
 * having to edit a dotfile.
 *
 * The first name that resolves to a non-blank value answers. A key set to
 * an empty string is treated as absent, so clearing a field in Settings
 * correctly falls through to the environment rather than masking it.
 */
export function cred(...names: string[]): Credential {
  const found = credential(...names);
  return { value: found.value, present: found.present };
}

/**
 * `fetch` with a hard timeout. Integration hosts are often slow or
 * unreachable; Xana must not hang waiting on a calendar provider.
 */
export async function httpJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 4500, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function httpText(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<string> {
  const { timeoutMs = 4500, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.name === "AbortError" ? "timed out" : err.message;
  }
  return String(err);
}
