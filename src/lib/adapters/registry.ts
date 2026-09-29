/**
 * Adapter registry — runs every life-data source and collects one snapshot.
 *
 * Caching lives inside each adapter (see `defineAdapter` in ./types): an
 * adapter owns its TTL, so the ambient `/api/state` loop can read the last
 * known slice without re-hitting eight integrations, while `/xana/context`
 * can ask for a genuinely fresh read.
 *
 * Isolation is the other property that matters: adapters run through
 * `Promise.allSettled` and each is individually guarded. One unreachable
 * integration costs one `error` status row, never a failed LifeState.
 */

import type { AdapterStatus, EnergyBand } from "../core/types";
import { emptySnapshot, type LifeAdapter, type LifeSnapshot } from "./types";
import { calendarAdapter } from "./calendar";
import { tasksAdapter } from "./tasks";
import { knowledgeAdapter } from "./knowledge";
import { healthAdapter } from "./health";
import { weatherAdapter } from "./weather";
import { mediaAdapter } from "./media";
import { financeAdapter } from "./finance";
import { mailAdapter } from "./mail";

export interface RegistryOptions {
  /** Current energy band, used by the media adapter's focus suggestion. */
  band?: () => EnergyBand;
  /** Names Xana knows, used by the mail adapter's importance scoring. */
  knownPeople?: () => string[];
}

export class AdapterRegistry {
  private adapters: LifeAdapter[];
  private opts: RegistryOptions;

  constructor(opts: RegistryOptions = {}) {
    this.opts = opts;
    this.adapters = [
      calendarAdapter(),
      tasksAdapter(),
      weatherAdapter(),
      healthAdapter(),
      knowledgeAdapter(),
      mediaAdapter(opts.band ?? (() => "steady")),
      financeAdapter(),
      mailAdapter(opts.knownPeople ?? (() => [])),
    ];
  }

  /** Every adapter, for the status UI. */
  list(): Array<{ id: string; label: string }> {
    return this.adapters.map((a) => ({ id: a.id, label: a.label }));
  }

  /**
   * Last-known status for every adapter, with no I/O. This is what the cheap
   * presence loop reports; adapters that have never run read as `offline`.
   */
  statuses(): AdapterStatus[] {
    return this.adapters.map((a) => {
      const st = a.state();
      if (st) return st;
      const { id, label } = a;
      return { id, label, state: "offline" as const, mode: "local" as const, detail: "not yet read" };
    });
  }

  /** Run every adapter into one freshly merged snapshot. */
  async collect(): Promise<LifeSnapshot> {
    const snapshot = emptySnapshot();

    const results = await Promise.allSettled(this.adapters.map((a) => a.fetch(snapshot)));

    // A rejected promise here would mean the wrapper itself threw, which each
    // adapter's internal try/catch prevents. Substitute a status row anyway so
    // the count of statuses always matches the count of adapters.
    const statuses: AdapterStatus[] = results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      const adapter = this.adapters[i];
      return {
        id: adapter.id,
        label: adapter.label,
        state: "error" as const,
        mode: "local" as const,
        detail: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    });

    snapshot.statuses = statuses;
    return snapshot;
  }

  /**
   * Drop every adapter's cached slice.
   *
   * This is what makes a write-back visible immediately: after Xana creates a
   * task, the tasks adapter's cache is stale by definition, and waiting for its
   * TTL would show the user a list that contradicts what she just said.
   */
  invalidate(): void {
    for (const adapter of this.adapters) adapter.invalidate();
  }
}

let singleton: AdapterRegistry | undefined;

/**
 * Process-wide registry. `band` and `knownPeople` are read lazily via the
 * accessors passed in, so the registry never has to import the derived layer
 * that imports it.
 */
export function getRegistry(opts: RegistryOptions = {}): AdapterRegistry {
  if (!singleton) singleton = new AdapterRegistry(opts);
  return singleton;
}

export type { LifeSnapshot };
