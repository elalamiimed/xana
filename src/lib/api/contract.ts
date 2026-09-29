/**
 * Xana's HTTP surface, as TypeScript. The UI imports these types; the route
 * handlers satisfy them. One file means the contract cannot drift.
 *
 *   GET  /api/state     -> StateResponse     (ambient poll: presence + summary)
 *   GET  /api/context   -> ContextResponse   (the unified /xana/context gateway)
 *   POST /api/chat      -> ChatResponse      (say something to Xana)
 *   POST /api/action    -> ActionResponse    (one-tap buttons on cards)
 */

import type { Card, LifeState, Message, ActionIntent, ActionOutcome } from "../core/types";

export type Presence =
  | "dormant"   // nothing happening, low ambient activity
  | "idle"      // awake and listening
  | "thinking"  // composing a reply
  | "speaking"  // delivering one
  | "acting";   // performing a write-back

/**
 * The whisper-thin payload the orb polls. Deliberately not the full LifeState:
 * presence should cost almost nothing to refresh.
 */
export interface StateResponse {
  presence: Presence;
  /** One-line headline for the moment, in Xana's voice. */
  headline: string;
  partOfDay: LifeState["partOfDay"];
  energy: { score: number; band: LifeState["energy"]["band"] };
  /** Count of things awaiting attention — drives the peripheral dot. */
  attention: number;
  /** Her voice: whether an LLM is driving, or the local mind. */
  engine: "llm" | "local";
  generatedAt: string;
}

export interface ContextResponse {
  lifeState: LifeState;
}

export interface ActionRequest {
  action: ActionIntent;
}

export interface ActionResponse {
  outcome: ActionOutcome;
}

export interface ChatApiResponse {
  message: Message;
  lifeState: LifeState;
}

export type { Card, LifeState, Message, ActionIntent, ActionOutcome };
