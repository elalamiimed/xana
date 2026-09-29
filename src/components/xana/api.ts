/**
 * Thin typed wrappers over Xana's four HTTP endpoints.
 *
 * Every function here is total: it either returns parsed data or throws an
 * `ApiError`. Nothing in the UI is allowed to crash because the backend is
 * not up yet — callers catch and degrade to a safe empty state.
 */

import type {
  ActionIntent,
  ActionOutcome,
  ChatApiResponse,
  ContextResponse,
  LifeState,
  Message,
  Presence,
  StateResponse,
} from "@/lib/api/contract";

export class ApiError extends Error {
  readonly endpoint: string;
  readonly status: number | null;

  constructor(endpoint: string, status: number | null, detail?: string) {
    super(detail ?? `${endpoint} failed`);
    this.name = "ApiError";
    this.endpoint = endpoint;
    this.status = status;
  }
}

/** A short, human-readable reason for a failed call. Xana's voice, no stack. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === null) return "The local mind is not answering";
    if (error.status === 404) return "That route is not available yet";
    return `That route answered ${error.status}`;
  }
  return "Something in the local mind did not answer";
}

async function requestJson<T>(
  endpoint: string,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      cache: "no-store",
      ...init,
      headers: init?.body ? { "content-type": "application/json" } : init?.headers,
    });
  } catch {
    // Network-level failure: the route does not exist yet, or the dev server
    // is mid-restart. Surface it as an ApiError so callers have one path.
    throw new ApiError(endpoint, null);
  }

  if (!response.ok) {
    throw new ApiError(endpoint, response.status);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(endpoint, response.status, `${endpoint} sent no JSON`);
  }
}

/** GET /api/state — the cheap ambient poll. */
export async function getState(): Promise<StateResponse> {
  return requestJson<StateResponse>("/api/state");
}

/** GET /api/context — the full life state. */
export async function getContext(): Promise<ContextResponse> {
  return requestJson<ContextResponse>("/api/context");
}

/** POST /api/chat — say something to Xana. */
export async function postChat(input: {
  message: string;
  sessionId?: string;
  modality?: "text" | "voice";
}): Promise<ChatApiResponse> {
  return requestJson<ChatApiResponse>("/api/chat", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * POST /api/action — a one-tap write-back from a card.
 *
 * Deliberately not routed through `requestJson`: the route answers 422 when
 * the action is valid but refused, and that response still carries a perfectly
 * good `{ outcome }` with Xana's explanation in it. Treating it as a transport
 * failure would throw away the one sentence the user needs to read. So a
 * parseable outcome is returned whatever the status code was; only a genuinely
 * unusable response throws.
 */
export async function postAction(action: ActionIntent): Promise<ActionOutcome> {
  const body: { action: ActionIntent } = { action };

  let response: Response;
  try {
    response = await fetch("/api/action", {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError("/api/action", null);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError("/api/action", response.status);
  }

  const outcome = (payload as { outcome?: ActionOutcome } | null)?.outcome;
  if (outcome && typeof outcome.message === "string") {
    return outcome;
  }

  throw new ApiError("/api/action", response.status);
}

/* ------------------------------------------------------------------ */
/* Narrowing helpers for untrusted JSON                                */
/* ------------------------------------------------------------------ */

const PRESENCES: readonly Presence[] = [
  "dormant",
  "idle",
  "thinking",
  "speaking",
  "acting",
];

/** The poll payload is treated as untrusted; a malformed field is dropped. */
export function asPresence(value: unknown): Presence | null {
  return typeof value === "string" && (PRESENCES as readonly string[]).includes(value)
    ? (value as Presence)
    : null;
}

export function asLifeState(value: unknown): LifeState | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<LifeState>;
  if (typeof candidate.generatedAt !== "string") return null;
  if (!Array.isArray(candidate.sources)) return null;
  if (!Array.isArray(candidate.nudges)) return null;
  return candidate as LifeState;
}

export function asMessage(value: unknown): Message | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<Message>;
  if (typeof candidate.text !== "string") return null;
  if (candidate.role !== "user" && candidate.role !== "xana" && candidate.role !== "system") {
    return null;
  }
  return candidate as Message;
}
