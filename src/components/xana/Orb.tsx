"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Presence } from "@/lib/api/contract";

import { OrbRenderer, orbSeed } from "./orb/renderer";
import type { OrbPresence } from "./orb/scene";

/**
 * The orb.
 *
 * Two renderers, one element. The live orb is a WebGL-free 3D canvas
 * (see `orb/renderer.ts`). The layered CSS disc in `globals.css` remains
 * as the fallback, and it is a *real* fallback rather than dead code:
 *
 *   - no canvas 2D context (a hardened browser, a failed `getContext`)
 *   - reduced motion, where a still layered disc communicates the state
 *     without a particle field that never stops turning
 *
 * Both paths render the same `role="status"` region with the same label,
 * so a screen reader gets one answer either way.
 */

/** Every Presence value is named, so the status region is never vague. */
const STATE_LABEL: Record<Presence, string> = {
  dormant: "Xana is dormant",
  idle: "Xana is listening",
  thinking: "Xana is thinking",
  speaking: "Xana is speaking",
  acting: "Xana is taking an action",
};

/** The one-line description under the orb. Xana's voice, no jargon. */
const STATE_LINE: Record<Presence, string> = {
  dormant: "Resting",
  idle: "Listening",
  thinking: "Thinking",
  speaking: "Here",
  acting: "Working",
};

export interface OrbProps {
  presence: Presence;
  /** Increments once per reply. Any change replays the ripple exactly once. */
  rippleKey: number;
  /** Global speed multiplier from settings. 1 is the designed pace. */
  motionSpeed?: number;
  /** Tapping the orb focuses the composer, so the orb is a real control. */
  onActivate?: () => void;
}

/** Falls back to the CSS renderer after a failed context. */
function supportsCanvas(): boolean {
  try {
    const probe = document.createElement("canvas");
    return probe.getContext("2d") !== null;
  } catch {
    return false;
  }
}

export default function Orb({
  presence,
  rippleKey,
  motionSpeed = 1,
  onActivate,
}: OrbProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<OrbRenderer | null>(null);
  const draggedRef = useRef(false);

  /**
   * `null` until the client decides. The server has no canvas and no
   * `matchMedia`, so guessing during render would desync hydration — the
   * first client paint commits to the live renderer and the CSS disc is
   * only ever mounted as an explicit fallback.
   */
  const [mode, setMode] = useState<"pending" | "canvas" | "css">("pending");

  /* ---------------- create the renderer ---------------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return;

    const reducedQuery =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;

    // A still layered disc is a better answer than a rotating field for
    // someone who has asked the system not to animate, and it is also the
    // honest answer: the canvas orb's whole point is its motion.
    if (reducedQuery?.matches || !supportsCanvas()) {
      setMode("css");
      return;
    }

    const renderer = new OrbRenderer({
      // 280 points is right for a laptop; a phone at 2x DPR is drawing the
      // same field into a quarter of the area, so it gets a thinner shell.
      quality: window.innerWidth < 640 ? 0.6 : 1,
      seed: orbSeed(),
    });
    rendererRef.current = renderer;
    renderer.attach(canvas);
    renderer.setReducedMotion(false);
    renderer.start();
    setMode("canvas");

    /* --- keep the backing store correct --- */
    const onResize = () => renderer.resize();
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
    observer?.observe(host);
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);

    /**
     * Device-pixel-ratio changes do not fire `resize`.
     *
     * Browser zoom, and dragging the window to a display with a different
     * scale factor, both change `devicePixelRatio` while the element's CSS
     * box stays identical — so a ResizeObserver never fires and the canvas
     * keeps its old backing store, which shows up as a soft, blurry orb
     * after a zoom. The trick is that the media query embeds the *current*
     * ratio, so it has to be re-registered after every change, and the
     * query is matched once (not added as a permanent listener).
     */
    let dprQuery: MediaQueryList | null = null;
    const onDprChange = () => {
      renderer.resize();
      watchDpr();
    };
    const watchDpr = () => {
      dprQuery?.removeEventListener("change", onDprChange);
      if (typeof window.matchMedia !== "function") return;
      dprQuery = window.matchMedia(
        `(resolution: ${window.devicePixelRatio || 1}dppx)`,
      );
      dprQuery.addEventListener("change", onDprChange);
    };
    watchDpr();

    /* --- stop drawing when nobody can see it --- */
    const onVisibility = () => {
      if (document.hidden) renderer.stop();
      else renderer.start();
    };
    document.addEventListener("visibilitychange", onVisibility);

    const intersection =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(
            (entries) => {
              for (const entry of entries) renderer.setVisible(entry.isIntersecting);
            },
            { threshold: 0 },
          )
        : null;
    intersection?.observe(host);

    /* --- follow a change to the OS motion setting --- */
    const onMotionPreference = () => {
      // Re-mounting into the CSS path is deliberate: switching renderers
      // mid-session keeps the orb honest rather than leaving a stale field
      // running for a reader who just turned motion off.
      setMode(reducedQuery?.matches ? "css" : "canvas");
    };
    reducedQuery?.addEventListener("change", onMotionPreference);

    return () => {
      reducedQuery?.removeEventListener("change", onMotionPreference);
      observer?.disconnect();
      intersection?.disconnect();
      dprQuery?.removeEventListener("change", onDprChange);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  /* ---------------- push presence and ripple in ---------------- */
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || mode !== "canvas") return;
    renderer.setPresence(presence as OrbPresence);
  }, [presence, mode]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || mode !== "canvas") return;
    renderer.setRippleKey(rippleKey);
  }, [rippleKey, mode]);

  /* ---------------- pointer ---------------- */
  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const renderer = rendererRef.current;
    const host = hostRef.current;
    if (!renderer || !host) return;
    const rect = host.getBoundingClientRect();
    const half = Math.max(1, Math.min(rect.width, rect.height) / 2);
    renderer.pointerMove(
      (event.clientX - (rect.left + rect.width / 2)) / half,
      (event.clientY - (rect.top + rect.height / 2)) / half,
      event.clientX,
      event.clientY,
    );
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    // Capture keeps the drag alive when the pointer leaves the orb, which
    // is what makes a fast spin usable rather than frustrating.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    renderer.pointerDown(event.clientX, event.clientY);
    draggedRef.current = false;
  }, []);

  const onPointerUp = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    draggedRef.current = renderer.pointerUp();
  }, []);

  const activate = useCallback(() => {
    // A spin that ends on the orb must not also focus the composer.
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    onActivate?.();
  }, [onActivate]);

  return (
    <div className="flex flex-col items-center">
      <div
        ref={hostRef}
        role="status"
        aria-live="polite"
        aria-label={STATE_LABEL[presence]}
        onPointerMove={onPointerMove}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={() => rendererRef.current?.pointerLeave()}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onActivate?.();
          }
        }}
        tabIndex={onActivate ? 0 : -1}
        style={{
          // The renderer reads its own size from the element, so the CSS
          // token is the single source of truth for how big the orb is at
          // each breakpoint.
          width: "var(--orb-size)",
          height: "var(--orb-size)",
          // A speed multiplier from settings, applied to the ripple
          // animation. The renderer reads the same value for its own
          // clock, so the CSS and 3D paths stay in step.
          ["--motion" as string]: String(motionSpeed),
        }}
        className={`orb state-${presence} cursor-pointer touch-none select-none`}
      >
        {/* Screen readers get a full sentence; the canvas is decoration. */}
        <span className="sr-only">{STATE_LABEL[presence]}</span>

        {mode === "css" ? <CssLayers rippleKey={rippleKey} /> : null}

        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="absolute inset-0 h-full w-full"
          style={{ opacity: mode === "canvas" ? 1 : 0, transition: "opacity 400ms" }}
        />
      </div>

      {/* The one line under the orb. Duplicated by the status region for
          assistive tech, so it is marked decorative here to avoid the
          same sentence being announced twice. */}
      <span aria-hidden="true" className="timestamp mt-1">
        {STATE_LINE[presence]}
      </span>
    </div>
  );
}

/**
 * The CSS orb: five stacked layers, every state variation in globals.css.
 * Kept because it is the reduced-motion and no-canvas answer — a still
 * disc that still differentiates dormant from thinking.
 */
function CssLayers({ rippleKey }: { rippleKey: number }) {
  return (
    <>
      {/* The ripple sits behind everything: it reads as leaving the core.
          React remounts it when the key changes, and a fresh node replays
          its animation from frame zero — no timers, and it cannot loop
          because the keyframe ends in `forwards`. */}
      {rippleKey > 0 ? (
        <div key={rippleKey} className="orb-layer orb-ripple" aria-hidden="true" />
      ) : null}

      <div className="orb-layer orb-halo" aria-hidden="true" />
      <div className="orb-layer orb-ring orb-ring-1" aria-hidden="true" />
      <div className="orb-layer orb-ring orb-ring-2" aria-hidden="true" />
      <div className="orb-layer orb-ring orb-ring-3" aria-hidden="true" />
      <div className="orb-layer orb-core" aria-hidden="true" />
      <div className="orb-layer orb-light" aria-hidden="true" />
    </>
  );
}
