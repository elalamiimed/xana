"use client";

/**
 * The settings client: fetch, save, and apply.
 *
 * Three jobs, kept in one place so no component has to know how a setting
 * travels from a control to the running app:
 *
 *   1. **Fetch** the masked view from `/api/settings`.
 *   2. **Save** a patch, then adopt the server's returned view as truth.
 *      Never the local guess: the server clamps, coerces and resolves, so
 *      its answer is the only one that matches what is on disk.
 *   3. **Apply** the appearance to the live document immediately, so the
 *      theme and the motion slider are a preview rather than a promise
 *      that only pays off after a reload.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ModelProvider,
  ResolvedModelView,
  SecretView,
  SettingsPatch,
  SettingsView,
  XanaSettings,
} from "@/lib/settings/types";

import { ApiError } from "./api";

export type { SettingsView, SettingsPatch } from "@/lib/settings/types";

async function request<T>(init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/settings", { cache: "no-store", ...init });
  } catch {
    throw new ApiError("/api/settings", null);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError("/api/settings", response.status);
  }

  if (!response.ok) {
    const message = (payload as { error?: string } | null)?.error;
    throw new ApiError("/api/settings", response.status, message);
  }
  return payload as T;
}

export interface ProbeResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  model?: string;
}

/**
 * Write the appearance tokens onto `<html>`.
 *
 * The same properties `themeStyle()` renders server-side in the root
 * layout, so an applied preview and a reloaded page are indistinguishable.
 * The canvas orb reads these back out of computed style, which is what
 * makes the 3D renderer recolour without a single prop being passed to it.
 */
export function applyAppearance(
  appearance: Pick<XanaSettings["appearance"], "accent" | "accent2" | "ambient" | "motionSpeed">,
): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.setProperty("--accent-rgb", appearance.accent);
  root.style.setProperty("--accent-2-rgb", appearance.accent2);
  root.style.setProperty("--glow-rgb", appearance.accent);
  root.style.setProperty("--ambient-glow", String(appearance.ambient));
  root.style.setProperty("--motion", String(appearance.motionSpeed));
}

export interface SettingsController {
  /** Null until the first fetch settles. */
  view: SettingsView | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  /** True once a save has succeeded and the view is fresh. */
  savedAt: number | null;
  reload: () => Promise<void>;
  save: (patch: SettingsPatch) => Promise<SettingsView | null>;
  probe: (patch: SettingsPatch) => Promise<ProbeResult | null>;
  clearError: () => void;
}

export function useSettings(open: boolean): SettingsController {
  const [view, setView] = useState<SettingsView | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const inFlight = useRef(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await request<{ settings: SettingsView }>();
      setView(payload.settings);
      setError(null);
    } catch (err) {
      setError(describe(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on first open rather than on mount: a user who never opens
  // Settings should never pay for the request, and the values are only
  // needed when the panel is on screen.
  useEffect(() => {
    if (!open || view || inFlight.current) return;
    inFlight.current = true;
    void reload().finally(() => {
      inFlight.current = false;
    });
  }, [open, view, reload]);

  const save = useCallback(async (patch: SettingsPatch): Promise<SettingsView | null> => {
    setSaving(true);
    try {
      const payload = await request<{ settings: SettingsView }>({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: patch }),
      });
      setView(payload.settings);
      setError(null);
      setSavedAt(Date.now());
      return payload.settings;
    } catch (err) {
      setError(describe(err));
      return null;
    } finally {
      setSaving(false);
    }
  }, []);

  const probe = useCallback(async (patch: SettingsPatch): Promise<ProbeResult | null> => {
    try {
      const payload = await request<{ probe: ProbeResult }>({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings: { ...patch, testModel: true } }),
      });
      return payload.probe;
    } catch (err) {
      return { ok: false, message: describe(err) };
    }
  }, []);

  return {
    view,
    loading,
    saving,
    error,
    savedAt,
    reload,
    save,
    probe,
    clearError: () => setError(null),
  };
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === null) return "The settings route is not answering.";
    if (error.status === 500) return error.message;
    return error.message || `That route answered ${error.status}.`;
  }
  return "Something went wrong saving that.";
}

/* ------------------------------------------------------------------ */
/* Untrusted JSON narrowing                                            */
/* ------------------------------------------------------------------ */

const PROVIDERS: readonly ModelProvider[] = ["openai", "anthropic"];

export function asModelProvider(value: unknown): ModelProvider | null {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value)
    ? (value as ModelProvider)
    : null;
}

export function asSecretView(value: unknown): SecretView {
  const candidate =
    typeof value === "object" && value !== null
      ? (value as Partial<SecretView>)
      : {};
  return {
    present: candidate.present === true,
    masked: typeof candidate.masked === "string" ? candidate.masked : "",
    from:
      candidate.from === "settings" || candidate.from === "env"
        ? candidate.from
        : "none",
  };
}

export function asResolvedModel(value: unknown): ResolvedModelView {
  const candidate =
    typeof value === "object" && value !== null
      ? (value as Partial<ResolvedModelView>)
      : {};
  return {
    model: typeof candidate.model === "string" ? candidate.model : "",
    baseUrl: typeof candidate.baseUrl === "string" ? candidate.baseUrl : "",
    provider: asModelProvider(candidate.provider) ?? "openai",
    active: candidate.active === true,
  };
}
