"use client";

/**
 * Paging the calendar with a horizontal swipe.
 *
 * WHY A SWIPE AT ALL
 *
 * A week is seven days wide and a phone is not. Before this, the only way to see
 * the days past the fold was to find the two 28px chevrons in the header, and
 * the only way to see the *next* week was to press one of them — neither of which
 * is a thing a person discovers by touching a calendar. Every calendar a person
 * has already used turns the page when it is pushed sideways, so this is a
 * gesture being honoured rather than a feature being added.
 *
 * WHY THIS IS NOT PART OF `pointerDrag`
 *
 * `beginPointerDrag` answers "where did the pointer go", and every caller of it
 * is moving an *object* — a block, a chip — to that place. A page turn has no
 * object and no destination: the question is one of *direction and distance*,
 * "was that a flick, and which way". Sharing the engine would mean a `DragFrame`
 * full of coordinates that nothing reads, and a `holdMs` that is actively wrong
 * here: the drag engine waits 180ms so a touch can scroll instead, but a swipe on
 * a calendar *is* the scroll, and a page turn that only began after a fifth of a
 * second would read as the calendar ignoring the first half of the gesture.
 *
 * WHAT IT DOES SHARE
 *
 * The one rule that matters, and the reason this file is written to the same
 * shape as the other two: **exactly one of `onPage` or nothing happens, on every
 * path, and any preview is taken down on all of them.** A swipe that lifts, a
 * swipe the browser cancels, a second finger, an unmount — each ends the gesture
 * once. The bug that rule came from (`pointerDrag`'s header spells it out) was a
 * preview left lit for the rest of the session because a path ended in silence.
 *
 * WHY THE PREVIEW FOLLOWS THE FINGER
 *
 * A page turn with no movement until the finger lifts is a calendar that feels
 * stuck. The grid is nudged by the gesture itself — a `transform`, written
 * straight onto a node, no re-render — so the surface reads as one sheet being
 * pushed towards the next period. On release it either commits (a transition
 * that carries the same direction) or springs back.
 *
 * WHAT A SWIPE MUST NEVER DO
 *
 * Steal a touch that was a drag. The grid's blocks arm on a hold and own the
 * pointer once they do (`useTimeGridDrag`), so the rule here is the inverse of
 * the drag engine's: this one *waits* and only becomes a swipe if the finger
 * travels horizontally without a hold having claimed it. A vertical move
 * abandons it immediately, because a day column is 24 hours tall and scrolling
 * it is the commonest thing anyone does to this surface.
 */

import { useCallback, useEffect, useRef } from "react";

export interface SwipePageOptions {
  /** The element the finger must start inside. */
  surfaceRef: React.RefObject<HTMLElement | null>;
  /**
   * The element that is nudged while the finger moves.
   *
   * Separately passed from `surfaceRef` because they are not always the same
   * node: the calendar's gesture surface is the whole room (so a swipe works
   * over the header and the quick-add line too), while the thing that slides is
   * the grid, which is the only part of the room that pages.
   */
  slideRef: React.RefObject<HTMLElement | null>;
  /**
   * Called when a swipe has committed, with the direction the *content* should
   * travel: `1` for "the next period arrives from the right", `-1` for the one
   * before it.
   *
   * Named for what it does to the calendar rather than for which way the finger
   * went, because those are opposites: a finger moving right pulls the previous
   * period in from the left.
   */
  onPage: (step: -1 | 1) => void;
  /** False while a page turn cannot be taken — mid-drag, or a form is open. */
  enabled?: boolean;
  /**
   * How far a swipe must travel, in pixels, to turn the page outright.
   *
   * Read against the surface's own width when it has one — see `thresholdFor` —
   * so the gesture is a proportion of the thing being pushed rather than a
   * number that is right on one screen size and wrong on another.
   */
  distance?: number;
}

/**
 * How long the page turn takes, in milliseconds, or `0` when the person has
 * asked for less motion.
 *
 * The rest of this codebase honours that setting in CSS, which works because the
 * durations there are declarations. These are not: the outgoing half of a page
 * turn has to finish before the period changes, so the timing is a `setTimeout`
 * in the path that does the work, and a media query cannot reach it. Reading the
 * query here is what keeps one rule from being true on every screen except the
 * one belonging to somebody who needs it most.
 *
 * Zero is not "no page turn" — the page still turns, it does so on the frame the
 * finger lifts, which is what reduced motion asks for: no travel.
 */
function turnDuration(): number {
  if (typeof window === "undefined" || !window.matchMedia) return 180;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180;
}

/** A swipe shorter than this is never a page turn, whatever its speed. */
const MIN_DISTANCE = 48;
/**
 * The most a swipe may ever be asked to travel, in pixels.
 *
 * The distance test is a share of the surface, which is right up to the point
 * where the surface is a desktop monitor: at 1440px the share alone asks for
 * 316px, so a touchscreen laptop would have to drag a third of the window to
 * change week. Measured with the real function before this cap existed. A swipe
 * is a movement of a hand, and a hand does not get longer because the screen did.
 */
const MAX_DISTANCE = 160;
/** The share of the surface's width that a swipe must cross to commit. */
const DISTANCE_SHARE = 0.22;
/** A flick faster than this, in px/ms, commits without crossing the distance. */
const FLICK_VELOCITY = 0.55;
/** How far a vertical move may go before the gesture is handed to the scroller. */
const VERTICAL_SLOP = 24;
/** How far, in pixels, a finger may travel before this is a swipe at all. */
const START_SLOP = 6;
/** Below this a gesture is a tap and nothing else. */
const TIME_LIMIT = 700;

/**
 * True when a calendar block holds this pointer's capture.
 *
 * A block that armed on its hold has called `setPointerCapture`, which is what
 * makes the whole of that drag reach the block even as the finger leaves it —
 * and capture also retargets every later event for that pointer, which is why
 * this component stops hearing `pointermove` the moment a block arms, while the
 * `pointerup` still arrives at the window.
 *
 * `Element.hasPointerCapture` is the real API but it needs the element that did
 * the capturing, and that element is a React node this hook has no reference to.
 * So the question is walked: the only things on this surface that capture are
 * blocks and their grips, both of which carry `data-event`, and each of them can
 * be asked directly. That is a handful of nodes, read once per finger lift.
 *
 * `null`-safe by construction, and it reads a torn-down document as "not
 * captured" — the safe direction, because a page turn can be swiped back in one
 * gesture and a block moved by something other than its own drag cannot be
 * undone without noticing.
 */
function capturedByABlock(pointerId: number): boolean {
  for (const node of document.querySelectorAll("[data-event]")) {
    if (node.hasPointerCapture?.(pointerId)) return true;
  }
  return false;
}

/**
 * How far a swipe must travel to turn the page on a surface this wide.
 *
 * The distance test and the flick test are deliberately redundant: a slow,
 * deliberate drag across a fifth of a phone turns the page, and so does a fast
 * flick that only crosses a centimetre. Both are things people do, and a rule
 * with only one of them makes the calendar ignore the other.
 *
 * Clamped at both ends. The floor keeps a swipe from being a hair-trigger on a
 * narrow window; the ceiling keeps a wide one from demanding a drag longer than
 * a hand naturally makes.
 */
export function thresholdFor(width: number, distance?: number): number {
  if (typeof distance === "number" && distance > 0) return distance;
  if (!Number.isFinite(width) || width <= 0) return 120;
  return Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, width * DISTANCE_SHARE));
}

/**
 * Which way a gesture of this size and speed should turn the page, or `null` to
 * leave it alone.
 *
 * Exported and pure so `check-calendar` can assert the decisions without a
 * browser: the thresholds are the whole behaviour, and a gesture recogniser that
 * cannot be tested is one whose edges are only ever found by a person using it.
 *
 * `dx` is the finger's travel — positive to the right — and the returned step is
 * the direction the content moves, so the two have opposite signs. A finger
 * going right drags the previous period in: step `-1`.
 */
export function pageStep(
  dx: number,
  dy: number,
  elapsedMs: number,
  width: number,
  distance?: number,
): -1 | 1 | null {
  // Mostly vertical: the scroller's, not the page turn's.
  if (Math.abs(dy) > Math.abs(dx)) return null;
  if (Math.abs(dx) < START_SLOP) return null;
  if (elapsedMs > TIME_LIMIT) return null;

  const velocity = Math.abs(dx) / Math.max(elapsedMs, 1);
  const committed = Math.abs(dx) >= thresholdFor(width, distance) || velocity >= FLICK_VELOCITY;
  if (!committed) return null;
  return dx < 0 ? 1 : -1;
}

export interface SwipePage {
  /** Attach to the surface as `onPointerDown`. */
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
}

export function useSwipePage(options: SwipePageOptions): SwipePage {
  const { surfaceRef, slideRef, onPage, enabled = true } = options;

  /**
   * The live option values, read at gesture time rather than captured.
   *
   * The listeners are attached to the window for the length of a gesture, so a
   * closure over `onPage` would pin the callback — and therefore the whole
   * `anchor` state it reads — to whatever it was when the finger landed. Dragging
   * the last frame of a swipe against a stale anchor is how a fast double-swipe
   * loses a week.
   */
  const latest = useRef({ onPage, enabled, distance: options.distance });
  latest.current = { onPage, enabled, distance: options.distance };

  /** True while a page transition is running, so a second swipe cannot stack. */
  const busy = useRef(false);

  const detach = useCallback(() => {
    const slide = slideRef.current;
    if (slide) {
      slide.style.transition = "";
      slide.style.transform = "";
      slide.style.willChange = "";
    }
  }, [slideRef]);

  useEffect(() => {
    // A room that closes mid-transition must not leave the grid nudged sideways.
    return () => detach();
  }, [detach]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!latest.current.enabled || busy.current) return;
      if (event.button !== 0) return;
      // A finger only. A mouse has no swipe vocabulary on a calendar, and a
      // drag with a mouse is already the way to move things; treating a
      // horizontal mouse drag as a page turn would fight the block drags.
      if (event.pointerType === "mouse") return;

      const surface = surfaceRef.current;
      const maybeSlide = slideRef.current;
      if (!surface || !maybeSlide) return;
      /**
       * Rebound to a `const` that the closures below can rely on.
       *
       * The narrowing above survives only until the next function boundary: the
       * listeners are declared inside this scope and TypeScript cannot carry
       * "not null" into them, because `slideRef.current` may legitimately have
       * changed by the time one runs. Holding the element in a local is the
       * honest reading anyway — a swipe that started on this grid moves *this*
       * grid, even if React has swapped the node underneath it since.
       */
      const slide = maybeSlide;
      const originX = event.clientX;
      const originY = event.clientY;
      const started = performance.now();
      const width = surface.getBoundingClientRect().width;
      let finished = false;

      const teardown = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("blur", onCancel);
      };

      const release = (commit: -1 | 1 | null, animate: boolean) => {
        if (finished) return;
        finished = true;
        teardown();

        if (commit === null) {
          // Return it, if it moved at all. The transition is the spring back,
          // and it is set here rather than in CSS because the nudge before it
          // had to be transition-free to follow the finger exactly.
          const duration = turnDuration();
          if (animate && duration > 0) {
            slide.style.transition = `transform ${duration}ms var(--ease)`;
            slide.style.transform = "translate3d(0,0,0)";
            const done = () => detach();
            slide.addEventListener("transitionend", done, { once: true });
            window.setTimeout(done, duration + 60);
          } else {
            detach();
          }
          return;
        }

        busy.current = true;
        const duration = turnDuration();
        /**
         * The outgoing half of the page turn.
         *
         * The grid slides a little further the way the finger was already
         * pushing, the period changes underneath it, and the incoming half is
         * React's own first frame rendered at the opposite offset and brought
         * back. Doing both halves here would mean holding the new period's data
         * before asking for it, which is the one thing this component
         * deliberately does not know about.
         *
         * With reduced motion the offset is skipped entirely and the page turns
         * on the next frame rather than after a fifth of a second: the delay
         * exists to let the slide finish, so with no slide there is nothing to
         * wait for, and waiting anyway would be a gesture that feels broken
         * rather than one that feels calm.
         */
        if (duration > 0) {
          slide.style.transition = `transform ${duration}ms var(--ease), opacity ${duration}ms var(--ease)`;
          slide.style.transform = `translate3d(${commit === 1 ? -14 : 14}%, 0, 0)`;
        }
        window.setTimeout(() => {
          latest.current.onPage(commit);
          busy.current = false;
        }, duration);
      };

      function onMove(move: PointerEvent) {
        if (move.pointerId !== event.pointerId) return;
        const dx = move.clientX - originX;
        const dy = move.clientY - originY;

        // A vertical move is a scroll, and the scroller has to win it outright:
        // a day column is 24 hours tall and scrolling is what a finger does to
        // this surface most often. Bow out without resizing anything.
        if (Math.abs(dy) > VERTICAL_SLOP && Math.abs(dy) > Math.abs(dx)) {
          release(null, false);
          return;
        }
        if (Math.abs(dx) < START_SLOP) return;

        // The nudge. Damped, because the page turn is finite — there is exactly
        // one period either side — and a grid that tracked the finger 1:1 would
        // promise travel that does not exist.
        slide.style.willChange = "transform";
        slide.style.transform = `translate3d(${dx * 0.35}px, 0, 0)`;
      }

      function onUp(up: PointerEvent) {
        if (up.pointerId !== event.pointerId) return;
        const dx = up.clientX - originX;
        const dy = up.clientY - originY;
        const elapsed = performance.now() - started;
        const moved = Math.abs(dx) >= START_SLOP;

        /**
         * A gesture that the grid has taken is not a swipe.
         *
         * The block drags arm on a hold and `setPointerCapture` the block, and
         * since capture retargets *every* later event for that pointer to the
         * capturer, this listener stops hearing `pointermove` the moment it
         * happens. The `pointerup` still reaches the window, though — so without
         * a test here, a slow sideways drag of a block would move the block *and*
         * turn the page underneath it.
         *
         * The test asks whether a *block* holds this pointer's capture, which is
         * the actual question. `elementFromPoint` would answer where the finger
         * is rather than who owns the gesture, and a finger that lifted over a
         * different block than it started on would be misread by it.
         */
        if (capturedByABlock(up.pointerId)) {
          release(null, false);
          return;
        }

        release(pageStep(dx, dy, elapsed, width, latest.current.distance), moved);
      }

      function onCancel() {
        release(null, true);
      }

      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("blur", onCancel);
    },
    [slideRef, surfaceRef],
  );

  return { onPointerDown };
}
