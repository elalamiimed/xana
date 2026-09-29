/**
 * The settings endpoint, as plain functions.
 *
 * Kept separate from the route files because there are two of them: the
 * canonical `/xana/settings` and the UI's `/api/settings` prefix, matching
 * how the life-state gateway is exposed at both `/xana/context` and
 * `/api/context`. One implementation, two doors —rather than a route that
 * re-exports another route, which is the kind of indirection that works
 * until someone adds a method to one of them.
 *
 * This is the only writer of the settings file, and `mergePatch` is the only
 * place client input becomes stored state, so every validation rule lives in
 * one function that can be read in one sitting.
 *
 * WHAT IS DELIBERATELY ABSENT
 *
 * There is no authentication. Xana binds to 127.0.0.1 and is a single-user
 * local application; adding a login would be security theatre that makes the
 * product worse. What this *does* guarantee is that the API key never travels
 * toward the browser —the GET response carries a masked placeholder, and the
 * PUT body accepts the sentinel `KEEP_KEY`, so a mask is never round-tripped
 * back as a literal key. Writing the key is one-way, by design.
 */

import { NextResponse } from "next/server";

import {
  KEEP_KEY,
  loadSettings,
  mergePatch,
  modelActive,
  saveSettings,
  settingsView,
  type SettingsPatch,
} from "@/lib/settings/store";
import { canonicalBaseUrl, findProvider } from "@/lib/settings/providers";
import { probeModel } from "@/lib/mind/llm";

export function getSettings(): NextResponse {
  return NextResponse.json({ settings: settingsView() });
}

export async function putSettings(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "That request body was not JSON." },
      { status: 400 },
    );
  }

  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Expected an object." }, { status: 400 });
  }

  const patch = (body as { settings?: SettingsPatch }).settings;
  if (!patch || typeof patch !== "object") {
    return NextResponse.json(
      { error: "Expected a `settings` object." },
      { status: 400 },
    );
  }

  // --- Test-only mode: prove a configuration without saving it. --------
  if ((patch as { testModel?: boolean }).testModel) {
    return NextResponse.json({ probe: await testModel(patch) });
  }

  const next = mergePatch(loadSettings(), patch);
  const saved = saveSettings(next);
  if (!saved.ok) {
    return NextResponse.json(
      {
        error: `Could not write the settings file: ${saved.error ?? "unknown reason"}`,
      },
      { status: 500 },
    );
  }

  // A change to a token, a feed URL or a location must show up on the very
  // next read, not whenever an adapter's TTL happens to lapse. Both cache
  // layers are dropped: the gateway's assembled state and every adapter's own
  // slice. Imported lazily because the gateway pulls in the whole adapter
  // graph, and a settings write that changes nothing relevant has no business
  // loading it.
  const affectsSources =
    patch.sources !== undefined ||
    patch.clearSources !== undefined ||
    patch.identity !== undefined;

  if (affectsSources) {
    try {
      const { invalidateContext } = await import("@/lib/context/gateway");
      invalidateContext();
    } catch {
      // An unavailable gateway is not a reason to fail the save: the file is
      // already written, and the next cold read picks it up anyway.
    }
  }

  return NextResponse.json({
    settings: settingsView(),
    // Echoed so the settings screen can state plainly whether a model is
    // answering, rather than the user having to infer it from a dot.
    modelActive: modelActive(),
  });
}

/**
 * Probe a not-yet-saved model configuration.
 *
 * Run against the values in the request, with two substitutions from
 * storage: a blank key falls back to whatever is already saved (so "Test"
 * works before you retype a key you already entered), and a blank base URL
 * falls back to the matched provider's default.
 *
 * The endpoint is normalised here too, so testing a URL the user pasted in
 * one of the three documented shapes tests the same thing that saving it
 * would. A probe that passes on a tidied URL and then fails on save would be
 * worse than no probe at all.
 */
async function testModel(patch: SettingsPatch) {
  const current = loadSettings();
  const incoming = patch.model ?? {};

  const provider =
    incoming.provider === "anthropic" || incoming.provider === "openai"
      ? incoming.provider
      : current.model.provider;

  const rawKey =
    typeof incoming.apiKey === "string" && incoming.apiKey.trim() !== KEEP_KEY
      ? incoming.apiKey.trim()
      : "";
  const apiKey = rawKey || current.model.apiKey.trim();

  const storedBase =
    typeof incoming.baseUrl === "string" ? incoming.baseUrl.trim() : "";
  const candidateBase =
    storedBase || current.model.baseUrl.trim() || findProvider("deepseek")?.baseUrl || "";
  const baseUrl = canonicalBaseUrl(candidateBase);

  const model =
    (typeof incoming.model === "string" ? incoming.model.trim() : "") ||
    current.model.model.trim() ||
    findProvider("deepseek")?.defaultModel ||
    "gpt-4o-mini";

  return probeModel({
    provider,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    model,
    apiKey,
    temperature: 0,
  });
}
