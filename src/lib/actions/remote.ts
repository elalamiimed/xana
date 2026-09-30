/**
 * Remote write-back: what happens after a local write, when a plugin can
 * repeat it somewhere the user actually looks.
 *
 * THE SPLIT
 *
 * `executeAction` is synchronous. It sits behind thirteen handlers in the local
 * mind and is called by the seed script, the demo, the card buttons and the
 * chat path. Making it asynchronous to serve one plugin's HTTP write would have
 * rippled through all of them, and the ripple would not have been free: the
 * handler chain's *order* is load-bearing (see the note in `mind/local.ts`), and
 * a mechanical async conversion is exactly the kind of edit that reorders
 * things.
 *
 * So the write happens in two steps with an explicit handoff:
 *
 *   1. `executeAction` writes locally and, on a calendar event, attaches a
 *      `remoteEligible` descriptor to the outcome.
 *   2. The route layer — which is already async — calls `mirrorToRemote` with
 *      that descriptor before replying.
 *
 * The user sees one reply, and it is true when they read it. Within the
 * server, the local write is never blocked on the network.
 *
 * WHY THE PERMISSION IS CHECKED TWICE
 *
 * `mayWriteRemotely` is consulted here, and the executor does not consult it at
 * all. That is the correct place: this is the function that would cause the
 * remote change, so this is the function that asks. A check in the executor
 * would be a check in the wrong process step, guarding a function that cannot
 * make the request.
 */

import type { ActionOutcome, RemoteEligible } from "../core/types";
import { getStore } from "../core/store";
import { mayWriteRemotely } from "../plugins/automation";
import { createEvent as createGoogleEvent, googleConnected } from "../plugins/google-calendar";

/** What happened when the local write was mirrored. */
export type MirrorResult =
  /** It landed remotely. */
  | { state: "written"; id?: string }
  /** It could have, but the user has not allowed it. Not an error. */
  | { state: "refused"; reason: string }
  /** It was allowed and the service said no. */
  | { state: "failed"; reason: string }
  /** Nothing to mirror: no plugin for this, or not connected. */
  | { state: "skipped" };

export interface MirrorOutcome {
  /** The message to show instead of the original, when it changed. */
  message: string;
  result: MirrorResult;
  /** Ids to add to the outcome, when a remote record was created. */
  addedIds: string[];
}

/**
 * Repeat a local write in the service that owns it, if permitted.
 *
 * Returns the message the user should see. Callers replace
 * `outcome.message` with it when it differs — the local confirmation is not
 * wrong, it is just incomplete, and "Booked X at 2pm" when the user's phone
 * stays empty is the failure this whole path exists to prevent.
 */
export async function mirrorToRemote(outcome: ActionOutcome): Promise<MirrorOutcome> {
  const eligible = outcome.remoteEligible;
  if (!eligible) {
    return { message: outcome.message, result: { state: "skipped" }, addedIds: [] };
  }

  // Not connected at all: the user never set this up, so saying anything about
  // Google would be noise.
  if (!googleConnected()) {
    return { message: outcome.message, result: { state: "skipped" }, addedIds: [] };
  }

  const verdict = mayWriteRemotely(eligible.plugin);
  if (!verdict.allowed) {
    return {
      message: `${outcome.message} ${verdict.reason ?? "It is in my calendar only."}`.replace(/\s+/g, " ").trim(),
      result: { state: "refused", reason: verdict.reason ?? "not permitted" },
      addedIds: [],
    };
  }

  const written = await writeRemote(eligible);
  if (written.state === "written") {
    return {
      message: `${outcome.message.replace(/\.$/, "")}, and in your Google calendar.${eligible.clash}`,
      result: written,
      addedIds: written.id ? [written.id] : [],
    };
  }

  if (written.state === "failed") {
    // The local event stands. The booking is real; it is just not where the
    // user will look for it, so the reply says so instead of reading clean.
    return {
      message: `${outcome.message.replace(/\.$/, "")} — Google refused it: ${written.reason}.`,
      result: written,
      addedIds: [],
    };
  }

  return { message: outcome.message, result: written, addedIds: [] };
}

async function writeRemote(eligible: RemoteEligible): Promise<MirrorResult> {
  if (eligible.kind !== "event") return { state: "skipped" };

  const result = await createGoogleEvent({
    title: eligible.title,
    start: eligible.start,
    end: eligible.end,
    location: eligible.location,
  });

  if (!result.ok) return { state: "failed", reason: result.error ?? "unknown error" };

  // Tie the remote record to the local one, so a later delete can find it. A
  // memory rather than a column: `events` is a shared table that several
  // plugins write into, and one plugin's bookkeeping does not belong in it.
  try {
    getStore().remember({
      kind: "fact",
      title: `Google event: ${eligible.title}`,
      content: `Created in Google Calendar as ${result.id ?? "an untitled event"}, from the local event ${eligible.localId}.`,
      entities: [eligible.title],
      tags: ["google-calendar", `key:event:${eligible.localId}`, `google:${result.id ?? ""}`],
      salience: 0.3,
      source: "xana",
    });
  } catch {
    // Bookkeeping. The event is already in the calendar; a failed memory write
    // must not turn a successful booking into an error.
  }

  return { state: "written", id: result.id };
}

/**
 * Apply a mirror result to an outcome, in place.
 *
 * One function rather than four copies of "set the message, push the id, mark
 * the refresh" across the routes that need it.
 */
export function applyMirror(outcome: ActionOutcome, mirror: MirrorOutcome): ActionOutcome {
  if (mirror.message !== outcome.message) outcome.message = mirror.message;
  if (mirror.addedIds.length > 0) {
    outcome.ids = [...(outcome.ids ?? []), ...mirror.addedIds];
  }
  if (mirror.result.state === "written") {
    // The remote calendar changed, so the schedule card is stale in a way the
    // local refresh hints do not describe.
    outcome.refresh = [...new Set([...(outcome.refresh ?? []), "calendar" as const])];
  }
  return outcome;
}

/** Convenience: mirror when eligible, otherwise return the outcome untouched. */
export async function finishAction(outcome: ActionOutcome): Promise<ActionOutcome> {
  if (!outcome.remoteEligible) return outcome;
  try {
    return applyMirror(outcome, await mirrorToRemote(outcome));
  } catch (err) {
    // A mirror must never fail an action that already succeeded locally.
    return {
      ...outcome,
      message: `${outcome.message.replace(/\.$/, "")} — the copy to Google did not take (${
        err instanceof Error ? err.message : String(err)
      }).`,
    };
  }
}
