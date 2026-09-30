/**
 * The plugins endpoint.
 *
 * Three jobs, in one file so the shape of a plugin's status is decided once:
 *
 *   1. `GET`  — every plugin with its capabilities, its settings presence, and
 *               what it last managed to read. Presence only: no secret value
 *               travels toward the browser from here.
 *   2. `POST` — grant, revoke, connect, disconnect. Every one of these is a
 *               consent decision or a credential exchange, so they are POSTs
 *               with an explicit action rather than a PUT of a whole document.
 *   3. The Google OAuth callback, which lives in the route file beside this
 *               one because it has to return HTML to a browser tab, not JSON.
 *
 * WHY THE STATUS IS BUILT HERE RATHER THAN IN THE COMPONENT
 *
 * `pluginView` is the only place that knows how to turn a descriptor plus a
 * runtime status plus stored settings into something renderable. The panel
 * imports the type and renders it; it does not re-derive whether a plugin is
 * ready, because a second opinion about "is this configured" is how a UI ends
 * up saying Connected next to a plugin that cannot run. It also means the
 * consent card and any future client — a script, a phone — agree by
 * construction.
 */

import { NextResponse } from "next/server";

/**
 * Importing the registry is load-bearing, not tidiness.
 *
 * The register lives in `automation.ts` and is populated by `registry.ts`, so
 * this module must pull that in or `allPlugins()` answers with an empty array —
 * which is indistinguishable from "this build has no plugins" and is exactly
 * how the panel would have shipped blank.
 */
import { getRegistry } from "./registry";

import {
  allGranted,
  allPlugins,
  grantPlugin,
  grants,
  mayWriteRemotely,
  revokePlugin,
  settingView,
  writePluginSettings,
  type PluginEntry,
} from "./automation";
import {
  beginAuthorization,
  disconnect as googleDisconnect,
  googleConnected,
  googleSetup,
  GOOGLE_PLUGIN_ID,
} from "./google-calendar";
import {
  CAPABILITY_INFO,
  CAPABILITY_ORDER,
  type CapabilityKind,
  type CapabilityView,
  type PluginAction,
  type PluginActionResponse,
  type PluginConfigView,
  type PluginStatus,
  type PluginsResponse,
} from "./types";

/* ------------------------------------------------------------------ */
/* Building a status row                                              */
/* ------------------------------------------------------------------ */

/**
 * Turn a plugin into its view.
 *
 * The order of the capability list is `CAPABILITY_ORDER`, which runs from the
 * harmless ones to `remote.write`, so the sentence a user reads last is the one
 * that changes something in their account. That ordering is a safety decision,
 * not a layout preference.
 */
export function pluginView(entry: PluginEntry): PluginStatus {
  const descriptor = entry.descriptor;
  const current = grants();
  const missing = entry.missing();

  const optionalKinds = new Set((descriptor.optional ?? []).map((o) => o.kind));
  const specByKind = new Map(
    [...descriptor.needs, ...(descriptor.optional ?? [])].map((spec) => [spec.kind, spec]),
  );

  const capabilities: CapabilityView[] = CAPABILITY_ORDER.filter((kind) =>
    specByKind.has(kind),
  ).map((kind) => {
    const spec = specByKind.get(kind)!;
    const info = CAPABILITY_INFO[kind];
    return {
      ...info,
      reason: spec.reason,
      hosts: spec.hosts,
      optional: optionalKinds.has(kind),
      granted: current[kind] === true,
    };
  });

  const config: PluginConfigView[] = (descriptor.config ?? []).map((item) => {
    const found = settingView(item.key);
    const view: PluginConfigView = {
      key: item.key,
      label: item.label,
      hint: item.hint,
      kind: item.kind,
      example: item.example,
      where: item.where,
      required: Boolean(item.required),
      present: found.present,
      from: found.from,
    };
    // Secrets are never echoed, masked or otherwise. Non-secrets are, so the
    // form is populated and a user can correct a typo in a calendar URL.
    if (item.kind !== "secret" && found.from === "settings") view.value = found.value;
    return view;
  });

  const missingConfig = config
    .filter((item) => item.required && !item.present)
    .map((item) => item.key);

  const base = entry.status();
  const ready = missing.length === 0 && missingConfig.length === 0 && base.state === "connected";

  return {
    ...base,
    name: descriptor.name,
    category: descriptor.category,
    tagline: descriptor.tagline,
    dataNote: descriptor.dataNote,
    provides: descriptor.provides,
    capabilities,
    missingConfig,
    config,
    writesBack: (descriptor.optional ?? []).some((o) => o.kind === "remote.write"),
    ready,
  };
}

export function pluginsResponse(): PluginsResponse {
  // Warm the register first. The statuses below come from each plugin's own
  // last read, which the registry owns, so the two must be the same object.
  getRegistry();
  const plugins = allPlugins().map(pluginView);
  return {
    plugins,
    grants: grants(),
    awaitingConsent: plugins.filter((p) => p.missing.length > 0).length,
    unconfigured: plugins.filter((p) => p.missing.length === 0 && p.missingConfig.length > 0).length,
  };
}

/* ------------------------------------------------------------------ */
/* GET                                                                */
/* ------------------------------------------------------------------ */

export function getPlugins(): NextResponse {
  try {
    return NextResponse.json(pluginsResponse());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "plugins.failed" },
      { status: 500 },
    );
  }
}

/* ------------------------------------------------------------------ */
/* POST                                                               */
/* ------------------------------------------------------------------ */

/** The origin the browser actually used, so the redirect URI matches. */
function originOf(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export async function postPlugins(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "That request body was not JSON.");
  }

  const actions = normaliseActions(body);
  if (actions.length === 0) {
    return fail(400, "Expected an `action` and a plugin `id`.");
  }

  const messages: string[] = [];
  let authUrl: string | undefined;

  for (const action of actions) {
    const entry = allPlugins().find((p) => p.descriptor.id === action.id);
    if (!entry) {
      return fail(404, `There is no plugin called "${action.id}".`);
    }

    switch (action.action) {
      case "grant": {
        const result = grantPlugin(action.id, Boolean(action.includeWrite));
        if (!result.ok) return fail(500, result.error ?? "Could not save that permission.");
        messages.push(
          action.includeWrite
            ? `Allowed ${entry.descriptor.name}, including changes.`
            : `Allowed ${entry.descriptor.name}.`,
        );
        break;
      }

      case "revoke": {
        const result = revokePlugin(action.id);
        if (!result.ok) return fail(500, result.error ?? "Could not save that permission.");
        messages.push(`Withdrew permission for ${entry.descriptor.name}.`);
        break;
      }

      case "connect": {
        if (action.id !== GOOGLE_PLUGIN_ID) {
          return fail(400, `${entry.descriptor.name} connects with a key rather than a sign-in.`);
        }
        // Consent first: there is no point sending someone to Google before
        // they have allowed Xana to hold the token that comes back.
        if (!allGranted(["account", "net.read"])) {
          return fail(
            409,
            "Allow Google Calendar first, then connect. The sign-in hands Xana a token, so the permission has to come before it.",
          );
        }
        if (!googleSetup().clientIdPresent) {
          return fail(
            409,
            "Paste an OAuth client ID first. The setup steps are under the field.",
          );
        }
        const wantWrite = mayWriteRemotely(GOOGLE_PLUGIN_ID).allowed;
        const { url } = beginAuthorization(
          `${originOf(request)}/api/plugins/google/callback`,
          wantWrite,
        );
        authUrl = url;
        messages.push("Opening Google to sign in.");
        break;
      }

      case "disconnect": {
        if (action.id !== GOOGLE_PLUGIN_ID) {
          return fail(400, `${entry.descriptor.name} has nothing to disconnect.`);
        }
        const result = await googleDisconnect();
        if (!result.ok) return fail(500, result.error ?? "Could not clear the stored token.");
        messages.push("Disconnected. The token is revoked and forgotten.");
        break;
      }
    }
  }

  const response: PluginActionResponse = {
    ok: true,
    message: messages.join(" "),
    authUrl,
    plugins: allPlugins().map(pluginView),
    grants: grants(),
  };
  return NextResponse.json(response);
}

function fail(status: number, message: string): NextResponse {
  return NextResponse.json({ ok: false, message, ...pluginsResponse() }, { status });
}

/**
 * Accept one action or a batch.
 *
 * A batch is what the "Allow everything that asks for nothing" button on the
 * panel sends. Each entry is validated by the same code as a single action, so
 * there is no path where the bulk form is more permissive than the explicit
 * one.
 */
function normaliseActions(body: unknown): PluginAction[] {
  if (typeof body !== "object" || body === null) return [];
  const record = body as Record<string, unknown>;

  const raw = Array.isArray(record.actions) ? record.actions : [body];
  const out: PluginAction[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const action = entry.action;
    if (!id) continue;
    if (action !== "grant" && action !== "revoke" && action !== "connect" && action !== "disconnect") {
      continue;
    }
    out.push({ id, action, includeWrite: entry.includeWrite === true });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

/**
 * Save plugin settings.
 *
 * Separate from the generic settings PUT because a plugin's fields are its own:
 * this refuses any key no plugin declared, and it rebuilds every adapter whose
 * configuration just changed. Without the rebuild, pasting a calendar URL
 * would appear to do nothing until a restart — the adapter resolves its
 * configuration once, at construction.
 */
export async function putPluginSettings(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "That request body was not JSON.");
  }
  if (typeof body !== "object" || body === null) {
    return fail(400, "Expected an object.");
  }

  const source = body as Record<string, unknown>;
  const values = source.values;
  if (typeof values !== "object" || values === null) {
    return fail(400, "Expected a `values` object of setting name to string.");
  }

  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (typeof value === "string") clean[key] = value;
  }

  const written = writePluginSettings(clean);
  if (!written.ok) return fail(500, written.error ?? "Could not write the settings file.");

  try {
    const { invalidateContext } = await import("../context/gateway");
    invalidateContext();
  } catch {
    // The file is already written; the next cold read picks it up regardless.
  }

  return NextResponse.json({ ok: true, message: "Saved.", ...pluginsResponse() });
}

/* ------------------------------------------------------------------ */
/* Exports the UI reads                                               */
/* ------------------------------------------------------------------ */

export {
  allPlugins,
  beginAuthorization,
  googleConnected,
  googleSetup,
  GOOGLE_PLUGIN_ID,
  mayWriteRemotely,
  allGranted,
};
export type { CapabilityKind, PluginStatus };
