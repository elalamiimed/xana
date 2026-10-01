"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { contrastWithVoid, findTheme, THEME_PRESETS } from "@/lib/settings/themes";
import { PALETTE } from "@/lib/settings/types";
import type {
  AppearanceSettings,
  SettingsPatch,
  SettingsView,
} from "@/lib/settings/types";

import { Actions, Button, Section, Slider, StatusLine } from "./controls";

/**
 * Appearance: theme, ambient light, and speed.
 *
 * SAVING
 *
 * This is the one section that saves itself, because it is the one section
 * where the result is visible while you are changing it. Every control
 * applies to the live document immediately — the orb behind the panel
 * recolours as you click — and the write to disk is debounced, so dragging
 * the ambient slider does not produce sixty HTTP requests. The effect is
 * keyed on the persisted fields and skips its first run, so opening the
 * panel is not itself a write.
 *
 * A THEME IS BOTH HALVES
 *
 * The bug this section used to have is worth stating, because the shape of
 * it is easy to reintroduce. Clicking a preset sent `{ theme: "aurora" }`
 * and merged it into the appearance object the panel was holding:
 *
 *     onPreview({ ...appearance, theme: "aurora" })
 *
 * so the panel kept the *old* accent channels while claiming the new theme
 * id. The server disagreed — `mergePatch` resolves a preset theme to that
 * preset's two colours — but the panel's copy was now a different object
 * from the one the server had, and it never re-read. The visible result was
 * a click that moved the selection ring and changed no colour at all,
 * which is indistinguishable from a dead button.
 *
 * Two rules came out of fixing it, and both are load-bearing:
 *
 *  1. **The wire carries the change, not the resolved state.** `mergePatch`
 *     treats any patch containing accent channels as an explicit custom
 *     pair, so resolving a preset locally and sending its colours *alongside*
 *     the name flips the stored theme to `custom`. Send `{ theme }`, or send
 *     `{ accent, accent2 }`, never both by accident.
 *  2. **The panel reads `appearance` rather than a copy of it.** That prop
 *     is the server's answer, so anything the server normalises — a preset
 *     name, a "custom" flip, a clamped number — reaches the UI without a
 *     second mechanism to keep in step.
 *
 * `previewAfter` resolves a preset locally only to paint the document, which
 * must happen before the server replies. Everything else is read, not held.
 *
 * The pickers are what switch the theme to `custom`, exactly as the server
 * does it: an explicit channel triplet only ever applies to a custom theme,
 * so choosing a colour by hand is what makes it custom.
 */

/** How long the picker must be still before the change is persisted. */
const SAVE_DEBOUNCE_MS = 700;

/** What a preset looks like as stored state. */
function fromPreset(id: string): AppearanceSettings {
  const preset = findTheme(id);
  if (!preset) return { theme: "custom" } as AppearanceSettings;
  return {
    theme: preset.id,
    accent: preset.accent,
    accent2: preset.accent2,
  } as AppearanceSettings;
}

/**
 * The appearance after a change.
 *
 * The channel rule lives on the server, in `mergePatch`, and this function
 * deliberately does not duplicate it. An earlier attempt did — resolving a
 * preset name to the preset's pair and sending both — and it cannot work:
 * `mergePatch` treats *any* patch carrying accent channels as an explicit
 * custom pair, so sending the pair alongside the name flips the stored theme
 * to `custom`. The fix is to send only what changed and let the server
 * resolve it, which is the same rule that already passes `verify:web`:
 *
 *   { theme: "aurora" }        -> stored as aurora, with its own pair
 *   { accent: "10 200 120" }   -> stored as custom, keeping the other channel
 *   { ambient: 0.2 }           -> stored unchanged, no theme implication
 *
 * Preview still needs a complete object for the live document, because
 * `applyAppearance` reads the channels and the server's answer for a theme
 * change is not known until it responds. So the preview resolves the preset
 * locally while the wire carries only the change. If they ever differ, the
 * next read of `appearance` corrects the panel — it is the server's copy.
 */
function previewAfter(
  current: AppearanceSettings,
  patch: Partial<AppearanceSettings>,
): AppearanceSettings {
  const preset = typeof patch.theme === "string" ? findTheme(patch.theme) : undefined;
  if (preset) return { ...current, ...fromPreset(preset.id) };
  if (patch.accent !== undefined || patch.accent2 !== undefined) {
    return { ...current, ...patch, theme: "custom" };
  }
  return { ...current, ...patch };
}

/** The preset a set of channels corresponds to exactly, if any. */
function presetFor(appearance: AppearanceSettings): string | null {
  const match = THEME_PRESETS.find(
    (preset) =>
      preset.accent === appearance.accent && preset.accent2 === appearance.accent2,
  );
  return match ? match.id : null;
}

export interface AppearancePanelProps {
  appearance: AppearanceSettings;
  /** Applied to the live document immediately, without saving. */
  onPreview: (next: AppearanceSettings) => void;
  /**
   * Resolves to the server's view, or `null` when the save failed.
   *
   * The null matters: it is the only signal a write was rejected, and the
   * panel must not claim "Saved" on the strength of a promise that resolved.
   */
  onSave: (patch: SettingsPatch) => Promise<SettingsView | null>;
  saving: boolean;
}

/* ------------------------------------------------------------------ */
/* Colour conversion                                                  */
/* ------------------------------------------------------------------ */

function channelsToHex(value: string): string {
  const [r, g, b] = value.trim().split(/[\s,]+/).map(Number);
  // The fallback is the one finished colour the settings layer declares; an
  // `<input type="color">` cannot be handed `rgb(var(--accent-rgb))`.
  if (![r, g, b].every((n) => Number.isFinite(n))) return PALETTE.accentDefault;
  return `#${[r, g, b]
    .map((n) => Math.round(Math.max(0, Math.min(255, n as number))).toString(16).padStart(2, "0"))
    .join("")}`;
}

function hexToChannels(hex: string): string {
  const clean = hex.replace("#", "").trim();
  if (clean.length !== 6) return "127 227 227";
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if (![r, g, b].every((n) => Number.isFinite(n))) return "127 227 227";
  return `${r} ${g} ${b}`;
}

/* ------------------------------------------------------------------ */
/* A swatch, for the preset grid                                      */
/* ------------------------------------------------------------------ */

/**
 * A preset swatch. The two discs are the actual accent pair, painted with
 * the same radial treatment the orb uses, so choosing a theme is choosing
 * the two colours you are actually going to see rather than two flat chips.
 */
function Swatch({
  accent,
  accent2,
  selected,
  label,
  mood,
  onSelect,
}: {
  accent: string;
  accent2: string;
  selected: boolean;
  label: string;
  mood: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`group flex items-center gap-3 rounded-[var(--r-md)] border px-3 py-2.5 text-left transition-all duration-[var(--t-fast)] ${
        selected
          ? "border-accent/40 bg-accent/10"
          : "border-hairline hover:border-hairline-2 hover:bg-surface-2"
      }`}
    >
      <span className="relative h-7 w-7 shrink-0" aria-hidden="true">
        {/* The two accent fills only. A zero-offset halo used to sit under
            the primary disc; that is a glow, and a glow on a static swatch
            is decoration. The colours are the content here. */}
        <span
          className="absolute inset-0 rounded-full"
          style={{
            background: `radial-gradient(circle at 50% 45%, rgb(${accent} / 0.95) 0%, rgb(${accent} / 0.35) 62%, transparent 78%)`,
          }}
        />
        <span
          className="absolute -right-1 -bottom-0.5 h-3.5 w-3.5 rounded-full"
          style={{
            background: `radial-gradient(circle, rgb(${accent2} / 0.95) 0%, rgb(${accent2} / 0.3) 70%, transparent 85%)`,
          }}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-light text-text">{label}</span>
        <span className="mt-0.5 block text-[11px] leading-snug font-normal text-faint">
          {mood}
        </span>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* The panel                                                          */
/* ------------------------------------------------------------------ */

export default function AppearancePanel({
  appearance,
  onPreview,
  onSave,
  saving,
}: AppearancePanelProps) {
  const [pending, setPending] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const firstRun = useRef(true);
  /** The change waiting to be written, as the patch and as the preview. */
  const pendingPatch = useRef<Partial<AppearanceSettings> | null>(null);
  const pendingPreview = useRef<AppearanceSettings | null>(null);
  /** Set by an explicit save, so the debounce does not fire a second write. */
  const handledBy = useRef<AppearanceSettings | null>(null);

  /**
   * Stage a change: apply it to the live document now, write it shortly.
   *
   * `patch` is what travels — only the fields the user actually touched —
   * and `preview` is the complete object the document needs. They are
   * different objects on purpose; see `previewAfter`.
   */
  const stage = useCallback(
    (patch: Partial<AppearanceSettings>, preview: AppearanceSettings) => {
      onPreview(preview);
      pendingPatch.current = patch;
      pendingPreview.current = preview;
      setPending(true);
      setFailed(null);
    },
    [onPreview],
  );

  /**
   * Persist after the user stops moving.
   *
   * `appearance` is the dependency, so every change resets the timer and
   * only the final value is written. The cleanup clears the pending timer.
   * The first run is skipped, so opening the panel is not itself a write.
   */
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }

    // An explicit save already wrote this exact value.
    if (handledBy.current === appearance) {
      handledBy.current = null;
      return;
    }
    const patch = pendingPatch.current;
    if (!patch || pendingPreview.current !== appearance) return;

    const timer = setTimeout(() => {
      void Promise.resolve(onSave({ appearance: patch })).then((result) => {
        setPending(false);
        if (result === null) setFailed("That change could not be saved.");
        else setSavedAt(Date.now());
      });
    }, SAVE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [appearance, onSave]);

  /** Write immediately, for the changes where waiting is wrong. */
  const saveNow = useCallback(
    async (patch: Partial<AppearanceSettings>, preview: AppearanceSettings) => {
      stage(patch, preview);
      handledBy.current = preview;
      const result = await onSave({ appearance: patch });
      setPending(false);
      if (result === null) setFailed("That change could not be saved.");
      else setSavedAt(Date.now());
    },
    [onSave, stage],
  );

  // The channels actually in force. `appearance` is the persisted truth, so
  // reading it here is what stops the panel drifting from the server.
  const accentContrast = contrastWithVoid(appearance.accent);
  const accent2Contrast = contrastWithVoid(appearance.accent2);
  const lowContrast = [
    accentContrast < 3 ? "primary" : null,
    accent2Contrast < 3 ? "secondary" : null,
  ].filter(Boolean) as string[];

  const matchingPreset = presetFor(appearance);
  const activePreset = findTheme(appearance.theme)?.id ?? matchingPreset;
  const isCustom = matchingPreset === null;

  const status = failed
    ? { tone: "error" as const, text: failed }
    : pending || saving
      ? { tone: "info" as const, text: "Saving…" }
      : savedAt
        ? {
            tone: "ok" as const,
            text: "Saved. The theme is applied everywhere, including the orb.",
          }
        : {
            tone: "info" as const,
            text: "Changes apply immediately and save on their own.",
          };

  return (
    <div>
      <Section
        title="Palette"
        blurb="Six hand-tuned pairs. The whole interface — borders, washes, glows, the orb — re-derives itself from these two colours, so nothing is left behind when you switch."
      >
        <div
          role="radiogroup"
          aria-label="Theme"
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          {THEME_PRESETS.map((preset) => (
            <Swatch
              key={preset.id}
              accent={preset.accent}
              accent2={preset.accent2}
              label={preset.label}
              mood={preset.mood}
              selected={activePreset === preset.id}
              onSelect={() => {
                const patch = { theme: preset.id };
                void saveNow(patch, previewAfter(appearance, patch));
              }}
            />
          ))}
        </div>

        {/* Custom colours. The native picker is deliberate: it is the one
            control that already knows about the OS colour wheel, screen
            eyedroppers and saved swatches, and reimplementing it badly
            would be a worse experience than using it. */}
        <div className="grid grid-cols-1 gap-4 border-t border-hairline pt-5 sm:grid-cols-2">
          <div>
            <label
              htmlFor="accent-primary"
              className="block text-[13px] font-light text-text"
            >
              Primary accent
            </label>
            <p className="mt-1 text-[12px] font-normal text-faint">
              The orb, the focus ring, the one number that matters.
            </p>
            <div className="mt-2 flex items-center gap-3">
              <input
                id="accent-primary"
                type="color"
                value={channelsToHex(appearance.accent)}
                onChange={(event) => {
                  // Both channels travel: the server keys "this is a custom
                  // pair" off the presence of an explicit colour, and sending
                  // only one would leave the other to be inferred.
                  const accent = hexToChannels(event.target.value);
                  const patch = {
                    theme: "custom",
                    accent,
                    accent2: appearance.accent2,
                  };
                  stage(patch, previewAfter(appearance, patch));
                }}
                className="h-8 w-12 cursor-pointer rounded-[var(--r-sm)] border border-hairline bg-transparent"
              />
              <code className="font-mono text-[12px] text-dim">
                rgb({appearance.accent})
              </code>
            </div>
          </div>

          <div>
            <label
              htmlFor="accent-secondary"
              className="block text-[13px] font-light text-text"
            >
              Secondary accent
            </label>
            <p className="mt-1 text-[12px] font-normal text-faint">
              Moments of change: acting, the horizon wash, recall.
            </p>
            <div className="mt-2 flex items-center gap-3">
              <input
                id="accent-secondary"
                type="color"
                value={channelsToHex(appearance.accent2)}
                onChange={(event) => {
                  const accent2 = hexToChannels(event.target.value);
                  const patch = {
                    theme: "custom",
                    accent: appearance.accent,
                    accent2,
                  };
                  stage(patch, previewAfter(appearance, patch));
                }}
                className="h-8 w-12 cursor-pointer rounded-[var(--r-sm)] border border-hairline bg-transparent"
              />
              <code className="font-mono text-[12px] text-dim">
                rgb({appearance.accent2})
              </code>
            </div>
          </div>
        </div>

        {/* Which preset the colours currently correspond to. Without this,
            a theme id and a colour pair that disagree look like a bug — and
            were one. */}
        <p className="mt-4 text-[12px] font-normal text-faint">
          {isCustom ? (
            <>
              These two colours match no preset, so the theme is{" "}
              <span className="text-dim">custom</span>. Pick a preset above to
              go back to a hand-tuned pair.
            </>
          ) : (
            <>
              Currently <span className="text-dim">{findTheme(matchingPreset)?.label}</span>
              {appearance.theme !== matchingPreset ? " (stored as a custom pair)" : ""}.
            </>
          )}
        </p>

        {lowContrast.length > 0 ? (
          <StatusLine tone="info">
            {`The ${lowContrast.join(" and ")} accent ${
              lowContrast.length > 1 ? "are" : "is"
            } below a 3:1 contrast ratio against the background. It will still work, but it will be hard to see — on a bright screen especially.`}
          </StatusLine>
        ) : null}
      </Section>

      <Section
        title="Light"
        blurb="Xana's background is not flat black. Two very low washes give it a top and a horizon, which is what stops the orb reading as a sticker on a dark rectangle."
      >
        <Slider
          label="Ambient light"
          value={appearance.ambient}
          min={0}
          max={0.3}
          step={0.005}
          format={(value) =>
            value === 0 ? "off" : `${Math.round((value / 0.3) * 100)}%`
          }
          hint="Turn it to zero for pure black, or up for a room with the lights low."
          onChange={(ambient) => {
            // One field only. Sending the whole appearance here is what used
            // to flip a preset theme to custom just for touching the light.
            const patch = { ambient };
            stage(patch, previewAfter(appearance, patch));
          }}
        />
      </Section>

      <Section
        title="Motion"
        blurb="One multiplier for everything that moves: the orb's rotation, the breath, card entries, the ripple. It does not override your system's reduced-motion setting — that always wins."
      >
        <Slider
          label="Speed"
          value={appearance.motionSpeed}
          min={0.25}
          max={2}
          step={0.05}
          format={(value) =>
            value === 1 ? "normal" : `${value < 1 ? "slower" : "faster"} ×${value.toFixed(2)}`
          }
          hint="Set it low if the movement is distracting. Set it high if you want her to feel more awake."
          onChange={(motionSpeed) => {
            const patch = { motionSpeed };
            stage(patch, previewAfter(appearance, patch));
          }}
        />
      </Section>

      <div className="px-6 py-4">
        <Actions>
          <StatusLine tone={status.tone}>{status.text}</StatusLine>
        </Actions>
        <div className="mt-3">
          <Button
            onClick={() => {
              const preset = THEME_PRESETS[0];
              if (!preset) return;
              const patch = {
                theme: preset.id,
                ambient: 0.13,
                motionSpeed: 1,
              };
              void saveNow(patch, previewAfter(appearance, patch));
            }}
          >
            Reset appearance
          </Button>
        </div>
      </div>
    </div>
  );
}
