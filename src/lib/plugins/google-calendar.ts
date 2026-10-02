/**
 * Google OAuth 2.0, for the Calendar API.
 *
 * WHAT THIS IS
 *
 * An authorization-code flow with PKCE, run as a loopback redirect — the shape
 * Google documents for a desktop app in
 * https://developers.google.com/identity/protocols/oauth2/native-app. The user
 * clicks Allow in the Plugins panel, a browser tab opens at Google, Google
 * redirects back to `/api/plugins/google/callback` on this machine, and the
 * refresh token is written to the settings file.
 *
 * WHY NOT THE ICS FEED
 *
 * The calendar plugin already reads Google Calendar, and for reading only, a
 * published ICS address is strictly better: no OAuth app, no client secret, no
 * consent screen to configure. What ICS cannot do is write, and it cannot be
 * scoped — the address reads every calendar the account publishes, forever,
 * and cannot be revoked from inside Xana. This plugin exists for those two
 * things: creating events in a real calendar, and a grant the user can revoke
 * from Google's side as well as ours.
 *
 * WHY NOT A LIBRARY
 *
 * `googleapis` is a large dependency for four HTTP calls, and it would want to
 * own token storage. The four calls are below. PKCE is `node:crypto`, the
 * request is `fetch`, and the token lives in the same `0600` settings file as
 * everything else — one place to look, one thing to delete.
 *
 * THE PART THAT IS EASY TO GET WRONG
 *
 * `access_type=offline` gets a refresh token, but Google only returns one on
 * the *first* consent for a client+account pair. Every later flow returns an
 * access token and no refresh token, which silently works until the access
 * token expires an hour later and then everything stops with no explanation.
 * So `prompt=consent` is sent on every authorization: it costs the user one
 * extra click and it is the difference between a connection that lasts and one
 * that dies quietly after lunch. When a refresh response does omit the refresh
 * token, the stored one is kept rather than cleared.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { AdapterStatus, CalendarEvent } from "../core/types";
import { startOfDay, endOfDay, addDays, uid } from "../core/time";
import { APP_TIME_ZONE } from "../core/zone";
import { defineAdapter, errorMessage, httpJson, status, type LifeAdapter } from "../adapters/types";
import {
  definePlugin,
  setting,
  settingView,
  writePluginSettings,
  type PluginEntry,
} from "./automation";
import type { PluginDescriptor } from "./types";

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

const SCOPES_READ = ["https://www.googleapis.com/auth/calendar.readonly"];

/**
 * Read plus write.
 *
 * `calendar.events` is the narrow write scope: create and modify events, and
 * nothing else. `calendar` would also grant full control of every calendar,
 * including sharing and deletion, which is more than "book this for me" needs.
 */
const SCOPES_WRITE = [...SCOPES_READ, "https://www.googleapis.com/auth/calendar.events"];

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** How long an authorization may sit half-finished before it is abandoned. */
const PENDING_TTL_MS = 10 * 60_000;

/* ------------------------------------------------------------------ */
/* Client credentials                                                 */
/* ------------------------------------------------------------------ */

export interface GoogleClient {
  clientId: string;
  /** Present for a "Web application" client. Absent for a desktop one. */
  clientSecret: string;
  configured: boolean;
}

export function googleClient(): GoogleClient {
  const clientId = setting("google.clientId");
  const clientSecret = setting("google.clientSecret");
  return { clientId, clientSecret, configured: clientId.length > 0 };
}

/* ------------------------------------------------------------------ */
/* PKCE                                                               */
/* ------------------------------------------------------------------ */

/** RFC 7636 §4.1: 43–128 characters of unreserved URL-safe alphabet. */
function base64url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function createVerifier(): string {
  // 32 random bytes becomes 43 base64url characters, the documented minimum.
  return base64url(randomBytes(32));
}

/** RFC 7636 §4.2: BASE64URL(SHA256(ASCII(verifier))). */
export function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

/** Comparison that does not leak where two strings first differ. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/* ------------------------------------------------------------------ */
/* Pending authorization                                              */
/* ------------------------------------------------------------------ */

/**
 * The half-finished flow, parked in the settings file.
 *
 * In a module-level variable it would be lost on the dev server's reload,
 * which happens constantly while the app is being worked on — and the symptom
 * would be "it worked the first time and then never again", which is close to
 * impossible to diagnose from the outside. Ten minutes is long enough to log
 * into Google and short enough that a forgotten flow cannot be replayed.
 */
export function beginAuthorization(redirectUri: string, wantsWrite: boolean): { url: string; state: string } {
  const verifier = createVerifier();
  const state = base64url(randomBytes(16));

  writePluginSettings({
    "google.pendingState": state,
    "google.pendingVerifier": verifier,
    "google.pendingAt": new Date().toISOString(),
  });

  const params = new URLSearchParams({
    client_id: googleClient().clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: (wantsWrite ? SCOPES_WRITE : SCOPES_READ).join(" "),
    // Offline is what asks for a refresh token at all; consent on every run is
    // what makes Google actually hand one over (see the file header).
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: challengeFor(verifier),
    code_challenge_method: "S256",
  });

  return { url: `${AUTH_ENDPOINT}?${params.toString()}`, state };
}

export interface PendingAuthorization {
  state: string;
  verifier: string;
  at: number;
}

export function pendingAuthorization(): PendingAuthorization | undefined {
  const state = setting("google.pendingState");
  const verifier = setting("google.pendingVerifier");
  if (!state || !verifier) return undefined;
  const at = Date.parse(setting("google.pendingAt"));
  if (!Number.isFinite(at)) return undefined;
  if (Date.now() - at > PENDING_TTL_MS) return undefined;
  return { state, verifier, at };
}

/** Check the state Google echoed against the one we sent. */
export function stateMatches(returned: string): boolean {
  const pending = pendingAuthorization();
  if (!pending || !returned) return false;
  return sameSecret(pending.state, returned);
}

/* ------------------------------------------------------------------ */
/* Token exchange                                                     */
/* ------------------------------------------------------------------ */

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/** Where the tokens live, and whether the connection is usable. */
export interface GoogleTokens {
  refreshToken: string;
  accessToken: string;
  /** Epoch milliseconds. 0 means unknown, which forces a refresh. */
  expiresAt: number;
  account: string;
  connected: boolean;
}

export function googleTokens(): GoogleTokens {
  const refreshToken = setting("google.refreshToken");
  const accessToken = setting("google.accessToken");
  const expiresAt = Number(setting("google.accessExpiresAt")) || 0;
  return {
    refreshToken,
    accessToken,
    expiresAt,
    account: setting("google.account"),
    connected: refreshToken.length > 0 || accessToken.length > 0,
  };
}

async function postForm(url: string, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  let parsed: TokenResponse = {};
  try {
    parsed = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`Token endpoint returned ${res.status}: ${text.slice(0, 120)}`);
  }
  if (!res.ok || parsed.error) {
    throw new Error(parsed.error_description || parsed.error || `HTTP ${res.status}`);
  }
  return parsed;
}

export interface ConnectResult {
  ok: boolean;
  error?: string;
  account?: string;
}

/**
 * Exchange the authorization code for tokens and store them.
 *
 * The refresh token is only overwritten when Google sends one. Google omits it
 * on repeat consents for the same client, and treating the absence as "clear
 * the token" would disconnect a working account every time the user
 * re-authorized — a bug whose symptom appears an hour later, nowhere near its
 * cause.
 */
export async function completeAuthorization(
  code: string,
  redirectUri: string,
): Promise<ConnectResult> {
  const pending = pendingAuthorization();
  if (!pending) return { ok: false, error: "That link has expired. Start again." };

  const client = googleClient();
  if (!client.configured) return { ok: false, error: "No Google client id is set." };

  const body: Record<string, string> = {
    client_id: client.clientId,
    code,
    code_verifier: pending.verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  };
  // A desktop client has no secret; sending an empty one is an error, so the
  // field is omitted rather than blanked.
  if (client.clientSecret) body.client_secret = client.clientSecret;

  let tokens: TokenResponse;
  try {
    tokens = await postForm(TOKEN_ENDPOINT, body);
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
  if (!tokens.access_token) return { ok: false, error: "Google returned no access token." };

  const values: Record<string, string> = {
    "google.accessToken": tokens.access_token,
    "google.accessExpiresAt": String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
    // The pending pair is single-use: clearing it means a replayed callback
    // cannot mint a second set of tokens from the same authorization.
    "google.pendingState": "",
    "google.pendingVerifier": "",
    "google.pendingAt": "",
  };
  if (tokens.refresh_token) values["google.refreshToken"] = tokens.refresh_token;

  const written = writePluginSettings(values);
  if (!written.ok) return { ok: false, error: written.error ?? "Could not save the token." };

  const account = await fetchAccount(tokens.access_token);
  if (account) writePluginSettings({ "google.account": account });

  runPluginRefresh();
  return { ok: true, account: account ?? undefined };
}

/** The signed-in address, so the panel can say which account is connected. */
async function fetchAccount(accessToken: string): Promise<string | undefined> {
  try {
    const data = await httpJson<{ email?: string }>(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      { headers: { authorization: `Bearer ${accessToken}` }, timeoutMs: 6000 },
    );
    return data.email;
  } catch {
    return undefined;
  }
}

/**
 * A usable access token, refreshed if needed.
 *
 * Sixty seconds of slack, because a token that expires mid-request fails the
 * request and the retry path would have to be written anyway.
 */
export async function accessToken(): Promise<{ token: string } | { error: string }> {
  const current = googleTokens();
  if (current.accessToken && current.expiresAt - 60_000 > Date.now()) {
    return { token: current.accessToken };
  }
  if (!current.refreshToken) {
    return { error: current.accessToken ? "The access token expired and there is no refresh token." : "Not connected." };
  }

  const client = googleClient();
  const body: Record<string, string> = {
    client_id: client.clientId,
    refresh_token: current.refreshToken,
    grant_type: "refresh_token",
  };
  if (client.clientSecret) body.client_secret = client.clientSecret;

  try {
    const tokens = await postForm(TOKEN_ENDPOINT, body);
    if (!tokens.access_token) return { error: "Google returned no access token." };
    writePluginSettings({
      "google.accessToken": tokens.access_token,
      "google.accessExpiresAt": String(Date.now() + (tokens.expires_in ?? 3600) * 1000),
    });
    return { token: tokens.access_token };
  } catch (err) {
    const message = errorMessage(err);
    // A revoked or expired refresh token is terminal: say so, and stop
    // pretending the connection is alive.
    if (/invalid_grant|invalid_client|unauthorized/i.test(message)) {
      return { error: "Google refused the refresh token. Reconnect the account." };
    }
    return { error: message };
  }
}

/**
 * Forget the account.
 *
 * Two halves, deliberately not conditional on the same thing:
 *
 *  - **Clearing the stored tokens always happens.** It is a write to her own
 *    settings file, it is what the user asked for, and it has to work even with
 *    every permission withdrawn — a disconnect button that refuses while
 *    permissions are off is a button that traps credentials on disk.
 *  - **Revoking at Google happens only when the network is permitted.** It is a
 *    request to a third party, so it follows the rule every other request
 *    follows. With nothing granted the token is forgotten locally and Google
 *    keeps its copy, which the user can revoke from their Google account and
 *    which is inert anyway once the refresh token here is gone.
 *
 * The first version revoked unconditionally, so `POST /api/plugins` with
 * `permissions: {}` reached oauth2.googleapis.com. Small, and exactly the shape
 * of thing this system exists to prevent.
 */
export async function disconnect(
  opts: { mayReachNetwork?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  const mayReachNetwork = opts.mayReachNetwork ?? false;
  const tokens = googleTokens();
  if (mayReachNetwork && (tokens.refreshToken || tokens.accessToken)) {
    try {
      // Best effort. Google's revoke drops every token for this client, which
      // is what "disconnect" should mean.
      await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(tokens.refreshToken || tokens.accessToken)}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(6000),
      });
    } catch {
      /* the local clear below is what matters */
    }
  }
  // The pending-flow pair is cleared too. A half-finished authorization left in
  // the file after a disconnect is a state the next connect would inherit.
  const result = writePluginSettings({
    "google.refreshToken": "",
    "google.accessToken": "",
    "google.accessExpiresAt": "",
    "google.account": "",
    "google.pendingState": "",
    "google.pendingVerifier": "",
    "google.pendingAt": "",
  });
  runPluginRefresh();
  return result;
}

/* ------------------------------------------------------------------ */
/* Calendar API                                                       */
/* ------------------------------------------------------------------ */

interface GoogleEvent {
  id?: string;
  summary?: string;
  location?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string; displayName?: string }>;
}

interface GoogleEventsResponse {
  items?: GoogleEvent[];
  error?: { message?: string };
}

/** Which calendar to read. `primary` is the account's own. */
function calendarId(): string {
  return setting("google.calendarId") || "primary";
}

export interface GoogleReadResult {
  events: CalendarEvent[];
  /** Non-fatal problems, e.g. one of several calendars refused. */
  notes: string[];
  error?: string;
}

/**
 * The `events.list` query, built from the app's own days.
 *
 * `timeZone` is sent explicitly rather than left to the account's default. The
 * window alone is not enough: Google expands a recurring event in the zone it is
 * told about, so a 09:00 series read with a UTC window can expand at 09:00 UTC
 * and land on the previous day's row here. The window is the app's day boundary,
 * so the first and last days are whole days in Beijing rather than in UTC.
 *
 * Exported so the query can be asserted without a network call.
 */
export function eventsQuery(now: Date = new Date()): URLSearchParams {
  return new URLSearchParams({
    timeMin: startOfDay(now).toISOString(),
    timeMax: endOfDay(addDays(now, 7)).toISOString(),
    timeZone: APP_TIME_ZONE,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });
}

/**
 * Read events from the account's calendar.
 *
 * `singleEvents=true` is what makes a recurring event arrive as the individual
 * occurrences the rest of the app reasons about, and `orderBy=startTime`
 * requires it. Without that flag Google returns one row per series with an
 * RRULE, which would put "Weekly standup" in today's list once a week.
 */
export async function readEvents(now: Date = new Date()): Promise<GoogleReadResult> {
  const auth = await accessToken();
  if ("error" in auth) return { events: [], notes: [], error: auth.error };

  const params = eventsQuery(now);

  try {
    const data = await httpJson<GoogleEventsResponse>(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId())}/events?${params.toString()}`,
      { headers: { authorization: `Bearer ${auth.token}` }, timeoutMs: 9000 },
    );
    if (data.error?.message) return { events: [], notes: [], error: data.error.message };
    const events = (data.items ?? [])
      .map(toCalendarEvent)
      .filter((e): e is CalendarEvent => e !== undefined);
    return { events, notes: [] };
  } catch (err) {
    return { events: [], notes: [], error: errorMessage(err) };
  }
}

function toCalendarEvent(raw: GoogleEvent): CalendarEvent | undefined {
  // Cancelled instances still come back from the API and must not be shown.
  if (raw.status === "cancelled") return undefined;
  const startRaw = raw.start?.dateTime ?? raw.start?.date;
  if (!startRaw) return undefined;
  const allDay = !raw.start?.dateTime;
  const start = new Date(startRaw);
  if (Number.isNaN(start.getTime())) return undefined;

  const endRaw = raw.end?.dateTime ?? raw.end?.date;
  let end = endRaw ? new Date(endRaw) : undefined;
  // An all-day event's end is the exclusive midnight boundary, so a one-day
  // event would render as ending at 00:00 tomorrow.
  if (allDay && end) end = new Date(end.getTime() - 1);
  if (!end || Number.isNaN(end.getTime()) || end <= start) {
    end = new Date(start.getTime() + 30 * 60_000);
  }

  const attendees = (raw.attendees ?? [])
    .map((a) => a.displayName?.trim() || a.email?.split("@")[0] || "")
    .filter(Boolean);

  return {
    id: `google_${raw.id ?? uid("gcal")}`,
    title: raw.summary?.trim() || "Untitled",
    start: start.toISOString(),
    end: end.toISOString(),
    location: raw.location?.trim() || undefined,
    attendees: attendees.length > 0 ? attendees : undefined,
    source: "google",
    allDay,
  };
}

export interface GoogleWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * Create an event in the user's real calendar.
 *
 * Called only after `mayWriteRemotely("google-calendar")` has allowed it. The
 * echo of the created event is returned and stored locally as well, so the
 * schedule is correct the instant the write succeeds rather than after the next
 * read.
 */
export async function createEvent(input: {
  title: string;
  start: string;
  end: string;
  location?: string;
}): Promise<GoogleWriteResult> {
  const auth = await accessToken();
  if ("error" in auth) return { ok: false, error: auth.error };

  const body = {
    summary: input.title,
    location: input.location,
    start: { dateTime: new Date(input.start).toISOString() },
    end: { dateTime: new Date(input.end).toISOString() },
  };

  try {
    const created = await httpJson<GoogleEvent & { error?: { message?: string } }>(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId())}/events`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${auth.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        timeoutMs: 9000,
      },
    );
    if (created.error?.message) return { ok: false, error: created.error.message };
    return { ok: true, id: created.id };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** Delete an event Xana created, so a mistake can be undone from here. */
export async function deleteEvent(eventId: string): Promise<GoogleWriteResult> {
  const auth = await accessToken();
  if ("error" in auth) return { ok: false, error: auth.error };
  const raw = eventId.replace(/^google_/, "");
  try {
    const res = await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(raw)}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${auth.token}` },
        signal: AbortSignal.timeout(9000),
      },
    );
    // 410 means it was already deleted, which is the outcome the caller wanted.
    if (res.ok || res.status === 404 || res.status === 410) return { ok: true };
    const text = await res.text();
    return { ok: false, error: `HTTP ${res.status}${text ? `: ${text.slice(0, 120)}` : ""}` };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/* ------------------------------------------------------------------ */
/* The plugin                                                         */
/* ------------------------------------------------------------------ */

export const GOOGLE_PLUGIN_ID = "google-calendar";

export const GOOGLE_DESCRIPTOR: PluginDescriptor = {
  id: GOOGLE_PLUGIN_ID,
  name: "Google Calendar",
  category: "life",
  // A source you sign into. Grouped with the other things that are already
  // yours rather than with the keyless public services, because the thing it
  // takes from the user is a sign-in, not a key.
  kind: "source",
  tagline: "Your real Google calendar, read and written.",
  dataNote:
    "Sends your calendar data to and from www.googleapis.com, authenticated as you. Xana stores a refresh token in her settings file on this machine, and can create events in your calendar once you allow it.",
  provides:
    "Events from Google in the same schedule as everything else, and events she books go into your real calendar.",
  needs: [
    { kind: "account", reason: "Sign in to your Google account." },
    {
      kind: "net.read",
      reason: "Read your calendar.",
      hosts: ["www.googleapis.com", "oauth2.googleapis.com", "accounts.google.com"],
    },
  ],
  optional: [
    {
      kind: "remote.write",
      reason: "Create events in your Google calendar, and delete the ones she created.",
    },
    { kind: "local.write", reason: "Keep a local copy of what she booked." },
  ],
  config: [
    {
      key: "google.clientId",
      label: "OAuth client ID",
      hint: "From a Google Cloud project with the Calendar API enabled.",
      kind: "text",
      where: "https://console.cloud.google.com/apis/credentials",
      example: "1234567890-abc123.apps.googleusercontent.com",
      required: true,
    },
    {
      key: "google.clientSecret",
      label: "Client secret",
      hint: "Not needed for a Desktop app client. Required for a Web application one.",
      kind: "secret",
    },
    {
      key: "google.calendarId",
      label: "Calendar",
      hint: "Leave blank for your primary calendar, or paste a calendar's id.",
      kind: "text",
      example: "primary",
    },
  ],
  writesBack: true,
};

/**
 * Whether the account is connected, without doing any I/O.
 *
 * Exported because the panel and the write-back path both need to ask
 * "is this usable" without triggering a token refresh.
 */
export function googleConnected(): boolean {
  return googleTokens().connected;
}

/** Nudge the registry to rebuild the calendar adapter after a token change. */
function runPluginRefresh(): void {
  // `writePluginSettings` already bumped the config epoch, so the adapter
  // rebuilds on its next use and picks up the new token. This function exists
  // so the dependency is stated at the call sites rather than implied.
}

export function googleCalendarPlugin(): PluginEntry {
  const descriptor = GOOGLE_DESCRIPTOR;

  const adapter = (): LifeAdapter => {
    const id = GOOGLE_PLUGIN_ID;
    const label = "Google Calendar";

    return defineAdapter<{ events: CalendarEvent[] }>({
      id,
      label,
      // Shorter than the ICS TTL: this one is also the write-back target, and
      // a stale read would show an event she just created as missing.
      ttlMs: 45_000,
      empty: { events: [] },
      async produce(): Promise<{ data: { events: CalendarEvent[] }; status: AdapterStatus }> {
        const t0 = Date.now();
        if (!googleClient().configured) {
          return {
            data: { events: [] },
            status: status(
              id, label, "offline", "local",
              "Paste an OAuth client ID to connect",
              Date.now() - t0,
            ),
          };
        }
        if (!googleConnected()) {
          return {
            data: { events: [] },
            status: status(id, label, "offline", "local", "Not connected", Date.now() - t0),
          };
        }

        const read = await readEvents();
        if (read.error) {
          // The rows below are whatever the last successful read returned, so
          // the mode is `synthetic` rather than `live`: this is not a fresh
          // answer, and the status text is where the reason is stated.
          return {
            data: { events: read.events },
            status: status(id, label, "error", "synthetic", read.error, Date.now() - t0),
          };
        }

        const account = googleTokens().account;
        return {
          data: { events: read.events },
          status: status(
            id, label, "connected", "live",
            `${read.events.length} events${account ? ` · ${account}` : ""}`,
            Date.now() - t0,
          ),
        };
      },
    });
  };

  return definePlugin({ descriptor, adapter });
}

/**
 * Whether the OAuth half is set up, for the panel's status line.
 *
 * Deliberately reports presence only — never the client secret, never the
 * refresh token. The panel shows "connected as you@example.com" or "not
 * connected", which is everything a person needs to know.
 */
export function googleSetup(): {
  clientIdPresent: boolean;
  clientIdFrom: "settings" | "env" | "none";
  connected: boolean;
  account: string;
  redirectHint: string;
} {
  const client = settingView("google.clientId");
  return {
    clientIdPresent: client.present,
    clientIdFrom: client.from,
    connected: googleConnected(),
    account: googleTokens().account,
    // The current path, and the one the flow actually begins with. The
    // pre-rename `/api/plugins/google/callback` still answers too, so a project
    // that already registered the older URI keeps working.
    redirectHint: "http://127.0.0.1:4310/api/connections/google/callback",
  };
}
