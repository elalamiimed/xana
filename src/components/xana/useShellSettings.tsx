"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { AppearanceSettings } from "@/lib/settings/types";

import Settings from "./settings/Settings";
import {
  applyAppearance,
  useSettings,
  type SettingsView,
} from "./useSettings";

/**
 * Settings state for the whole app.
 *
 * One hook, called once, in the shell. It owns three things the rest of
 * the interface needs and none of which belong to any single component:
 *
 *   - the appearance, applied to `<html>` so the orb and every utility
 *     recolour together;
 *   - the voice, so a reply can be spoken as it arrives;
 *   - the adapter statuses, so the Connections screen can say which of
 *     them are actually answering.
 *
 * The panel is mounted here rather than inside the header so that closing
 * it restores focus to the header button — which only works if both live
 * inside the same React tree.
 */

export interface ShellSettings {
  open: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  /** My cave: the goal board and memory room. */
  caveOpen: boolean;
  openCave: () => void;
  closeCave: () => void;
  controller: ReturnType<typeof useSettings>;
  view: SettingsView | null;
  onAppearancePreview: (next: AppearanceSettings) => void;
  voice: {
    speakReplies: boolean;
    voiceName: string;
    rate: number;
    pitch: number;
    /** Keep listening for her name without a button press. */
    wakeEnabled: boolean;
    /** Comma-separated ways of saying her name; empty means the built-in list. */
    wakePhrases: string;
  };
  /** Adapter id -> state, for the Connections screen. */
  statuses: Record<string, { state: string; mode: string; detail?: string }>;
  /** Global motion multiplier, handed to the orb. */
  motionSpeed: number;
  /**
   * Whether a model is *configured* and answering, as opposed to which
   * engine happened to produce the last reply.
   *
   * The distinction matters and was previously conflated. `/api/state`
   * reports whichever engine served the most recent turn, so one failed
   * model call made the interface claim "The local mind is answering" even
   * though a working model was configured and the next turn would use it.
   * This is the durable answer; the per-message `engine` is the transient
   * one, and both are shown.
   */
  modelActive: boolean;
  /** The model id that will answer, for the status line. */
  modelName: string;
}

export function useShellSettings(
  sources: readonly { id: string; state: string; mode: string; detail?: string }[],
  /**
   * Called after My cave writes something.
   *
   * The cave has its own route and its own copy of the goals, tasks and
   * memories, so a change made there leaves the briefing on this page reading
   * whatever it loaded at mount. That is how a deleted task kept appearing:
   * the database had one, the cave panel had one, and the briefing had three.
   *
   * Passed in rather than imported so this hook stays a shell concern and the
   * page decides what "the data changed" means for it.
   */
  onDataChanged?: () => void,
): ShellSettings {
  const [open, setOpen] = useState(false);
  const [caveOpen, setCaveOpen] = useState(false);
  const controller = useSettings(open);
  const view = controller.view;

  const openSettings = useCallback(() => setOpen(true), []);
  const closeSettings = useCallback(() => setOpen(false), []);
  const openCave = useCallback(() => setCaveOpen(true), []);

  /**
   * Closing the cave is the reliable moment to re-read.
   *
   * Refreshing on every keystroke inside it would fight the cave's own
   * optimistic updates, and the cave is a full-screen room — nothing on this
   * page is visible while it is open. So the refresh happens once, on the way
   * out, which is exactly when the difference becomes visible.
   */
  const closeCave = useCallback(() => {
    setCaveOpen(false);
    onDataChanged?.();
  }, [onDataChanged]);

  /**
   * Keep the live document in step with the saved appearance.
   *
   * The server already rendered the right tokens, so this only matters
   * after a save or a preview — but it also covers the case where the
   * response was cached from an older value, and it costs nothing.
   */
  useEffect(() => {
    if (view) applyAppearance(view.appearance);
  }, [view]);

  const onAppearancePreview = useCallback((next: AppearanceSettings) => {
    applyAppearance(next);
  }, []);

  const statuses = useMemo(() => {
    const map: Record<string, { state: string; mode: string; detail?: string }> = {};
    for (const source of sources) {
      map[source.id] = {
        state: source.state,
        mode: source.mode,
        ...(source.detail ? { detail: source.detail } : {}),
      };
    }
    return map;
  }, [sources]);

  const voice = useMemo(
    () => ({
      speakReplies: view?.voice.speakReplies ?? false,
      voiceName: view?.voice.voiceName ?? "",
      rate: view?.voice.rate ?? 1,
      pitch: view?.voice.pitch ?? 1,
      wakeEnabled: view?.voice.wakeEnabled ?? false,
      wakePhrases: view?.voice.wakePhrases ?? "",
    }),
    [view],
  );

  return {
    open,
    openSettings,
    closeSettings,
    caveOpen,
    openCave,
    closeCave,
    controller,
    view,
    onAppearancePreview,
    voice,
    statuses,
    motionSpeed: view?.appearance.motionSpeed ?? 1,
    modelActive: view?.effective.active ?? false,
    modelName: view?.effective.model ?? "",
  };
}

export { Settings };
