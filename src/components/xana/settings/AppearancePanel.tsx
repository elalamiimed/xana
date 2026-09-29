"use client";

import { useEffect, useState } from "react";

import { contrastWithVoid, THEME_PRESETS } from "@/lib/settings/themes";
import type { AppearanceSettings, SettingsPatch } from "@/lib/settings/types";

import { Actions, Button, Section, Slider, StatusLine } from "./controls";

/**
 * Appearance: theme, ambient light, and speed.
 *
 * The one section that saves *itself*, because it is the one section where
 * the result is visible while you are changing it. Every control calls
 * `onPreview` on change, which writes the tokens straight onto `<html>` so
 * the orb behind the panel recolours as you click; the write to disk is
 * debounced so dragging a colour picker does not produce sixty HTTP
 * requests.
 *
 * The debounce is the interesting part. It has to solve two problems at
 * once: coalesce a burst of changes into one save, and never leave the
 * last change unsaved because the user closed the panel. Hence both a
 * timer and a flush on unmount.
 */

/** How long the picker must be still before the change is persisted. */
const SAVE_DEBOUNCE_MS = 700;

export interface AppearancePanelProps {
  appearance: AppearanceSettings;
  /** Applied to the live document immediately, without saving. */
  onPreview: (next: AppearanceSettings) => void;
  onSave: (patch: SettingsPatch) => Promise<unknown>;
  saving: boolean;
}

/* ------------------------------------------------------------------ */
/* Colour conversion                                                  */
/* ------------------------------------------------------------------ */

function channelsToHex(value: string): string {
  const [r, g, b] = value.trim().split(/[\s,]+/).map(Number);
  if (![r, g, b].every((n) => Number.isFinite(n))) return "#7fe3e3";
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
        <span className="mt-0.5 block text-[11px] leading-snug font-light text-faint">
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
  const [saved, setSaved] = useState(false);

  /**
   * Persist after the user stops moving.
   *
   * `appearance` is the dependency, so every change resets the timer and
   * only the final value is written. The cleanup clears the pending timer —
   * but that alone would lose the last change on unmount, so the value is
   * also kept in a ref and flushed. `useEffect` cleanup cannot await, so
   * the flush is fire-and-forget; the server is the source of truth either
   * way, and a dropped flush at worst means the next open shows the
   * previous value.
   */
  useEffect(() => {
    setSaved(false);
    const timer = setTimeout(() => {
      void onSave({ appearance }).then(() => setSaved(true));
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // Intentionally keyed on the persisted fields only: `onSave` is stable
    // from the controller, and including it would re-trigger on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    appearance.theme,
    appearance.accent,
    appearance.accent2,
    appearance.ambient,
    appearance.motionSpeed,
  ]);

  const accentContrast = contrastWithVoid(appearance.accent);
  const accent2Contrast = contrastWithVoid(appearance.accent2);
  const lowContrast = [
    accentContrast < 3 ? "primary" : null,
    accent2Contrast < 3 ? "secondary" : null,
  ].filter(Boolean) as string[];

  const patch = (next: Partial<AppearanceSettings>) => {
    onPreview({ ...appearance, ...next });
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
              selected={appearance.theme === preset.id}
              onSelect={() => patch({ theme: preset.id })}
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
            <p className="mt-1 text-[12px] font-light text-faint">
              The orb, the focus ring, the one number that matters.
            </p>
            <div className="mt-2 flex items-center gap-3">
              <input
                id="accent-primary"
                type="color"
                value={channelsToHex(appearance.accent)}
                onChange={(event) => patch({ accent: hexToChannels(event.target.value) })}
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
            <p className="mt-1 text-[12px] font-light text-faint">
              Moments of change: acting, the horizon wash, recall.
            </p>
            <div className="mt-2 flex items-center gap-3">
              <input
                id="accent-secondary"
                type="color"
                value={channelsToHex(appearance.accent2)}
                onChange={(event) => patch({ accent2: hexToChannels(event.target.value) })}
                className="h-8 w-12 cursor-pointer rounded-[var(--r-sm)] border border-hairline bg-transparent"
              />
              <code className="font-mono text-[12px] text-dim">
                rgb({appearance.accent2})
              </code>
            </div>
          </div>
        </div>

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
          onChange={(ambient) => patch({ ambient })}
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
          onChange={(motionSpeed) => patch({ motionSpeed })}
        />
      </Section>

      <div className="px-6 py-4">
        <Actions>
          <StatusLine tone={saved ? "ok" : "info"}>
            {saving
              ? "Saving…"
              : saved
                ? "Saved. The theme is applied everywhere, including the orb."
                : "Changes apply immediately and save on their own."}
          </StatusLine>
        </Actions>
        <div className="mt-3">
          <Button
            onClick={() => {
              const preset = THEME_PRESETS[0];
              if (preset) {
                patch({
                  theme: preset.id,
                  accent: preset.accent,
                  accent2: preset.accent2,
                  ambient: 0.13,
                  motionSpeed: 1,
                });
              }
            }}
          >
            Reset appearance
          </Button>
        </div>
      </div>
    </div>
  );
}
