/**
 * The Google OAuth callback, as a function rather than a route body.
 *
 * WHY THIS IS NOT IN THE ROUTE FILE
 *
 * The redirect URI is sent to Google twice — once when the flow begins
 * (`beginAuthorization`) and once when the code is exchanged (`redirect_uri`
 * must match byte for byte or Google refuses). It is therefore pinned in the
 * authorization URL the user approves, which means the *path* is part of the
 * exchange.
 *
 * Xana renamed its public surface from `/api/plugins` to `/api/connections`,
 * and a rename must not break a sign-in that is already half-finished, nor a
 * Cloud Console project that has the older redirect registered. So two routes
 * exist, and both call the code below with the path they were reached on: the
 * one that started the flow is the one the exchange uses. One implementation,
 * two addresses, no drift — and the state check below means a mismatch is
 * refused rather than silently swapping accounts.
 *
 * STATE IS CHECKED. The `state` parameter is compared against the one Xana
 * generated when the flow began, and a mismatch is refused. Without that check
 * a third party could hand the user a link that attaches *their* Google account
 * to this Xana, which is the classic authorization-code interception. PKCE
 * covers the code exchange; `state` covers the handoff.
 */

import { completeAuthorization, googleSetup, stateMatches } from "./google-calendar";

/**
 * Where the browser is told to come back to.
 *
 * `path` is the route the request actually arrived on, so the exchange uses the
 * same redirect URI that was authorized.
 */
export function googleCallbackRedirect(origin: string, path: string): string {
  return `${origin}${path}`;
}

export async function handleGoogleCallback(request: Request, path: string): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const error = url.searchParams.get("error");

  // The user pressed Deny, or Google refused the request. Not an exception.
  if (error) {
    return page({
      ok: false,
      title: "Not connected",
      body:
        error === "access_denied"
          ? "You declined, so nothing was connected. Nothing was stored."
          : `Google returned: ${error}`,
    });
  }

  if (!code) {
    return page({
      ok: false,
      title: "Nothing to do",
      body: "That link had no authorization code in it. Start the connection from the Connections panel.",
    });
  }

  if (!stateMatches(state)) {
    return page({
      ok: false,
      title: "That link has expired",
      body:
        "The sign-in took longer than ten minutes, or it did not start here. Nothing was connected — open the Connections panel and press Connect again.",
    });
  }

  const redirect = googleCallbackRedirect(`${url.protocol}//${url.host}`, path);
  const result = await completeAuthorization(code, redirect);

  if (!result.ok) {
    return page({
      ok: false,
      title: "Connection failed",
      body: result.error ?? "Google would not exchange the code.",
    });
  }

  const setup = googleSetup();
  return page({
    ok: true,
    title: "Connected",
    body: setup.account
      ? `${setup.account} is connected. Google Calendar events will appear in your schedule, and Xana can book into it.`
      : "Connected. Google Calendar events will appear in your schedule.",
  });
}

/* ------------------------------------------------------------------ */
/* The page                                                           */
/* ------------------------------------------------------------------ */

/**
 * A self-contained dark page.
 *
 * Hand-written rather than rendered through the app's layout because this is a
 * full document in a tab of its own, and reusing the shell would drag the whole
 * client bundle into a confirmation screen. The colours are the app's own
 * tokens, written out — there is no stylesheet loaded here to inherit them.
 */
function page(input: { ok: boolean; title: string; body: string }): Response {
  const accent = input.ok ? "#86D6A6" : "#E0B279";
  const mark = input.ok
    ? `<path d="M6 20.5 15.5 30 34 11" stroke="${accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`
    : `<path d="M11 11l18 18M29 11L11 29" stroke="${accent}" stroke-width="3" stroke-linecap="round" fill="none"/>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.title)} — Xana</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #040406; color: #F1F2F7; padding: 24px;
    font: 400 14px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 34rem; text-align: center; }
  h1 { margin: 20px 0 0; font-size: 15px; font-weight: 400; letter-spacing: .01em; }
  p { margin: 8px 0 0; color: #AEB0C2; font-size: 13px; }
  .close { margin-top: 24px; font-size: 12px; color: #8E92A6; }
  .close[hidden] { display: none; }
</style>
</head>
<body>
<main>
  <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">${mark}</svg>
  <h1>${escapeHtml(input.title)}</h1>
  <p>${escapeHtml(input.body)}</p>
  <p class="close" id="close" hidden>Closing this tab.</p>
</main>
<script>
  // Tell the panel that opened this tab to refresh. Failure is fine and
  // expected when the tab was not opened from the panel. Both names are sent
  // because a bundle built before the rename listens for the older one.
  try {
    if (window.opener && !window.opener.closed) {
      var payload = { source: "xana-connections", ok: ${input.ok ? "true" : "false"} };
      window.opener.postMessage(payload, window.location.origin);
      try {
        window.opener.postMessage({ source: "xana-plugins", ok: ${input.ok ? "true" : "false"} }, window.location.origin);
      } catch (err) { /* nothing to do */ }
      var note = document.getElementById("close");
      note.hidden = false;
      setTimeout(function () { window.close(); }, 1400);
    }
  } catch (err) { /* nothing to do */ }
</script>
</body>
</html>`;

  return new Response(html, {
    status: input.ok ? 200 : 400,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // A confirmation of a one-time exchange must never be cached or
      // replayed from history.
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
