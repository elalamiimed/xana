"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { AppearanceSettings, SettingsPatch } from "@/lib/settings/types";

import { Tabs } from "./controls";
import AppearancePanel from "./AppearancePanel";
import ModelPanel from "./ModelPanel";
import SourcesPanel from "./SourcesPanel";
import VoicePanel from "./VoicePanel";
import type { SettingsController } from "../useSettings";

/**
 * The settings surface.
 *
 * A right-hand panel on a wide screen, a full-height sheet on a narrow one.
 * The panel rather than a centred modal is a deliberate choice: Xana's orb
 * stays visible beside it, so the theme picker and the motion slider are a
 * live preview of the actual interface rather than a swatch that promises
 * something. On a phone there is no room for that, so the sheet takes the
 * screen and the sections carry their own small previews.
 *
 * ACCESSIBILITY
 *
 * `role="dialog"` with `aria-modal`, a real focus trap (Tab cycles within
 * the panel), Escape to close, focus returned to whatever opened it, and
 * the page behind locked from scrolling. The trap is hand-rolled rather
 * than pulled from a library because it is thirty lines and the failure
 * mode of getting it wrong — a keyboard user tabbing out of a modal into
 * a page they cannot see — is exactly the bug worth owning.
 */

export type SettingsTab = "appearance" | "voice" | "model" | "sources" | "about";

export interface SettingsProps {
  open: boolean;
  onClose: () => void;
  controller: SettingsController;
  /** Applied to the live document as the user changes appearance. */
  onAppearancePreview: (next: AppearanceSettings) => void;
  /** Live adapter statuses for the sources panel. */
  statuses: Record<string, { state: string; mode: string; detail?: string }>;
}

const TABS: readonly { id: SettingsTab; label: string; badge?: boolean }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "voice", label: "Voice" },
  { id: "model", label: "Model & key", badge: true },
  { id: "sources", label: "Connections" },
  { id: "about", label: "About" },
];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Settings({
  open,
  onClose,
  controller,
  onAppearancePreview,
  statuses,
}: SettingsProps) {
  const [tab, setTab] = useState<SettingsTab>("appearance");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  /* ---------------- open and close ---------------- */

  useEffect(() => {
    if (!open) return;

    // Remember what had focus so closing can give it back. Without this a
    // keyboard user lands back at the top of the document.
    restoreRef.current = document.activeElement as HTMLElement | null;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      // The trap. Recomputed per keypress rather than cached: sections
      // mount and unmount as tabs change, so any cached list goes stale.
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;

      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);

    // Stop the page behind scrolling underneath the panel.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Move focus in, after the panel has painted.
    const frame = requestAnimationFrame(() => {
      const target = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
      target?.focus();
    });

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      cancelAnimationFrame(frame);
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  const save = useCallback(
    async (patch: SettingsPatch) => {
      const next = await controller.save(patch);
      // An appearance save applies to the live document immediately; other
      // sections have nothing to apply.
      if (next) onAppearancePreview(next.appearance);
      return next;
    },
    [controller, onAppearancePreview],
  );

  if (!open) return null;

  const view = controller.view;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* The scrim. Kept light enough that the orb stays visible through
          it on a wide screen — the theme preview depends on that. */}
      <button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        className="scrim-in absolute inset-0 cursor-default bg-black/55 backdrop-blur-[2px]"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="sheet-in panel relative flex h-full w-full max-w-[760px] flex-col overflow-hidden rounded-none md:rounded-l-[var(--r-xl)] md:rounded-r-none"
      >
        {/* ---------------- header ---------------- */}
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-hairline px-6 py-4">
          <div>
            <h2 id="settings-title" className="text-[15px] font-normal tracking-[0.01em] text-text">
              Settings
            </h2>
            <p className="mt-0.5 text-[12px] font-normal text-faint">
              {view
                ? view.effective.active
                  ? `${view.effective.model} is answering.`
                  : "Her own engine is answering."
                : "Loading…"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-dim transition-colors duration-[var(--t-fast)] hover:bg-surface-2 hover:text-text"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path
                d="M1 1l10 10M11 1L1 11"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        {/* ---------------- body ---------------- */}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* Tabs: a horizontal strip on a phone, a rail on a desktop. */}
          <nav className="shrink-0 border-b border-hairline px-3 py-2 md:w-[184px] md:border-r md:border-b-0 md:px-3 md:py-4">
            <div className="hidden md:block">
              <Tabs
                tabs={TABS}
                active={tab}
                onChange={setTab}
                ariaLabel="Settings sections"
                orientation="vertical"
              />
            </div>
            <div className="md:hidden">
              <Tabs
                tabs={TABS}
                active={tab}
                onChange={setTab}
                ariaLabel="Settings sections"
                orientation="horizontal"
              />
            </div>
          </nav>

          <div
            id={`panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`tab-${tab}`}
            tabIndex={-1}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {controller.error && !view ? (
              <div className="px-6 py-8">
                <p role="alert" className="text-[13px] font-light text-danger">
                  {controller.error}
                </p>
                <button
                  type="button"
                  onClick={() => void controller.reload()}
                  className="btn btn-ghost mt-4"
                >
                  Try again
                </button>
              </div>
            ) : null}

            {!view && !controller.error ? (
              <div className="space-y-3 px-6 py-8" aria-hidden="true">
                {[0, 1, 2].map((index) => (
                  <div
                    key={index}
                    className="skeleton h-4"
                    style={{ width: `${90 - index * 18}%` }}
                  />
                ))}
              </div>
            ) : null}

            {view ? (
              <>
                {tab === "appearance" ? (
                  <AppearancePanel
                    appearance={view.appearance}
                    onPreview={onAppearancePreview}
                    onSave={save}
                    saving={controller.saving}
                  />
                ) : null}

                {tab === "voice" ? (
                  <VoicePanel view={view} onSave={save} saving={controller.saving} />
                ) : null}

                {tab === "model" ? (
                  <ModelPanel view={view} controller={controller} />
                ) : null}

                {tab === "sources" ? (
                  <SourcesPanel
                    view={view}
                    statuses={statuses}
                    onSave={save}
                    saving={controller.saving}
                  />
                ) : null}

                {tab === "about" ? (
                  <AboutPanel settingsPath={view.settingsPath} />
                ) : null}

                <div className="h-6" />
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* About                                                              */
/* ------------------------------------------------------------------ */

/**
 * Where the file lives, and what she can actually do.
 *
 * This is the section that answers "wait, where did my key go?" without
 * requiring anyone to read a README. Showing the literal path is more
 * useful than a polite description of it.
 */
function AboutPanel({ settingsPath }: { settingsPath: string }) {
  return (
    <section className="border-b border-hairline px-6 py-6 last:border-b-0">
      <h3 className="text-[15px] font-normal tracking-[0.01em] text-text">
        Where things are kept
      </h3>
      <p className="mt-1 max-w-[52ch] text-[13px] leading-relaxed font-light text-dim">
        Every setting on this screen, and every key you have pasted into it,
        is stored in one JSON file on this machine. Nothing is sent anywhere
        except to the services you have explicitly switched on.
      </p>
      <code className="mt-4 block overflow-x-auto rounded-[var(--r-md)] border border-hairline bg-black/30 px-3 py-2 font-mono text-[12px] text-dim">
        {settingsPath}
      </code>

      <h3 className="mt-8 text-[15px] font-normal tracking-[0.01em] text-text">
        What she does without any of this
      </h3>
      <ul className="mt-2 space-y-1.5 text-[13px] leading-relaxed font-light text-dim">
        <li>A daily briefing, built from your own engine — no network.</li>
        <li>Tasks, reminders, routines and habit streaks, all local.</li>
        <li>Goal tracking with weekly and monthly reflections.</li>
        <li>A memory that remembers what you tell her, and recalls it later.</li>
        <li>Energy, pattern and nudge inference from whatever data exists.</li>
      </ul>

      <h3 className="mt-8 text-[15px] font-normal tracking-[0.01em] text-text">
        A note on the model
      </h3>
      <p className="mt-1 max-w-[52ch] text-[13px] leading-relaxed font-light text-dim">
        The model shapes how she says things. It never decides what she
        does — every action, write-back and memory is resolved by her own
        engine first, so the same sentence produces the same result whether
        a model is configured or not.
      </p>
    </section>
  );
}
