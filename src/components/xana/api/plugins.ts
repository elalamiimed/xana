/**
 * The plugin endpoints, from the browser's side.
 *
 * Three calls and one rule that differs from the rest of the app: a refused
 * consent action is not a transport failure. `POST /api/plugins` answers
 * 4xx/5xx with a readable `{ ok: false, message }` beside the current plugin
 * list — "Allow Google Calendar first, then connect." is the sentence the user
 * has to read, and throwing it away in favour of "that route answered 409"
 * would leave them with nothing to act on. So these helpers return the failure
 * payload when there is one, and throw only when the body is not something the
 * panel can render at all.
 *
 * Everything here narrows the response rather than trusting it, the same way
 * `../api.ts` does: a proxy error page or a half-written JSON body must not
 * crash the panel, and a missing count must not be quietly replaced with a
 * zero, because a summary that says "0 waiting for permission" when nobody
 * asked is worse than no summary.
 */

import type {
  ConnectionGroup,
  ConnectionsResponse,
  PermissionGrants,
  PluginAction,
  PluginActionResponse,
  PluginStatus,
  PluginsResponse,
} from "../../../lib/plugins/types";

/** The canonical surface. `/api/plugins` still answers the same handlers. */
export const CONNECTIONS_ENDPOINT = "/api/connections";
export const CONNECTION_SETTINGS_ENDPOINT = "/api/connections/settings";

/** Kept as the old names, so an older import keeps compiling. */
export const PLUGINS_ENDPOINT = CONNECTIONS_ENDPOINT;
export const PLUGIN_SETTINGS_ENDPOINT = CONNECTION_SETTINGS_ENDPOINT;

/** The list the GET returns, plus the sentence that came back with a write. */
export type PluginSettingsResponse = PluginsResponse & { ok: boolean; message: string };

export class PluginsApiError extends Error {
  readonly endpoint: string;
  readonly status: number | null;

  constructor(endpoint: string, status: number | null, detail?: string) {
    super(detail && detail.trim().length > 0 ? detail : `${endpoint} did not answer`);
    this.name = "PluginsApiError";
    this.endpoint = endpoint;
    this.status = status;
  }
}

/** A short sentence for the panel's error line. No stack, no status code. */
export function describePluginsError(error: unknown): string {
  if (error instanceof PluginsApiError) {
    if (error.status === null) return "The plugin service is not answering";
    return error.message;
  }
  return "Something in the plugin service did not answer";
}

/* ------------------------------------------------------------------ */
/* Narrowing                                                          */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The list, the groups and the two counts, or null when the body is not that shape.
 *
 * Only the envelope is checked. The array is handed on as `PluginStatus[]`
 * rather than re-validated field by field, because the server builds it from
 * the very type this file imports: re-narrowing every field here would be a
 * second opinion about a contract that is already shared, and a second opinion
 * is how the two drift apart.
 *
 * The counts are required rather than defaulted. They are the header's whole
 * text, and the panel is not allowed to invent them. `groups` is the same
 * bargain: the server computed it from the same rows, so the panel renders it
 * rather than recomputing a total that could disagree with the cards below.
 */
function asPluginsResponse(payload: unknown): PluginsResponse | null {
  if (!isRecord(payload)) return null;
  if (!Array.isArray(payload.plugins)) return null;
  if (typeof payload.awaitingConsent !== "number") return null;
  if (typeof payload.unconfigured !== "number") return null;

  const grants: PermissionGrants = isRecord(payload.grants)
    ? (payload.grants as PermissionGrants)
    : {};

  return {
    plugins: payload.plugins as PluginStatus[],
    groups: Array.isArray(payload.groups) ? (payload.groups as ConnectionGroup[]) : [],
    kinds: Array.isArray(payload.kinds) ? (payload.kinds as ConnectionsResponse["kinds"]) : [],
    grants,
    awaitingConsent: payload.awaitingConsent,
    unconfigured: payload.unconfigured,
  };
}

/** The server's own sentence, whether it was sent as `message` or `error`. */
function messageOf(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  for (const key of ["message", "error"] as const) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

async function send(endpoint: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(endpoint, { cache: "no-store", ...init });
  } catch {
    // Network-level failure: the server is mid-restart, or the route is gone.
    throw new PluginsApiError(endpoint, null);
  }
}

/* ------------------------------------------------------------------ */
/* The calls                                                          */
/* ------------------------------------------------------------------ */

/** GET /api/plugins — every plugin, its capabilities, and its last read. */
export async function getPlugins(): Promise<PluginsResponse> {
  const response = await send(PLUGINS_ENDPOINT, {});
  const payload = await readJson(response);
  const data = asPluginsResponse(payload);

  if (!response.ok || !data) {
    throw new PluginsApiError(
      PLUGINS_ENDPOINT,
      response.status,
      messageOf(payload) ?? undefined,
    );
  }
  return data;
}

/**
 * POST /api/plugins — grant, revoke, connect, disconnect.
 *
 * A refusal comes back as a value, not a throw, because a refusal here is a
 * decision the user can act on — usually "do the other step first" — and the
 * endpoint says which step in `message`.
 */
export async function postPluginAction(
  action: PluginAction,
): Promise<PluginActionResponse> {
  const response = await send(PLUGINS_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(action),
  });

  const payload = await readJson(response);
  const data = asPluginsResponse(payload);
  const message = messageOf(payload);

  if (!data) {
    throw new PluginsApiError(PLUGINS_ENDPOINT, response.status, message ?? undefined);
  }

  return {
    ok: isRecord(payload) && payload.ok === true,
    message: message ?? (response.ok ? "Done." : "That did not go through."),
    authUrl:
      isRecord(payload) && typeof payload.authUrl === "string"
        ? payload.authUrl
        : undefined,
    plugins: data.plugins,
    grants: data.grants,
  };
}

/**
 * PUT /api/plugins/settings — one plugin's fields, by qualified key.
 *
 * `values` must contain only the keys the user actually typed into. The
 * endpoint cannot tell a deliberate value from an echoed one, so an untouched
 * field sent along "for completeness" is a field promoted out of the
 * environment and into the settings file.
 */
export async function savePluginSettings(
  values: Record<string, string>,
): Promise<PluginSettingsResponse> {
  const response = await send(PLUGIN_SETTINGS_ENDPOINT, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values }),
  });

  const payload = await readJson(response);
  const data = asPluginsResponse(payload);
  const message = messageOf(payload);

  if (!data) {
    throw new PluginsApiError(
      PLUGIN_SETTINGS_ENDPOINT,
      response.status,
      message ?? undefined,
    );
  }

  return {
    ok: isRecord(payload) && payload.ok === true,
    message: message ?? (response.ok ? "Saved." : "That did not save."),
    ...data,
  };
}
