"use client";

/**
 * One pointer gesture, from press to release, as a frame loop.
 *
 * WHY THIS IS NOT `onPointerMove` ON A REACT ELEMENT
 *
 * Three things have to be true for a drag to feel like the object is attached to
 * the pointer, and a React handler per move fails all three:
 *
 *  1. **No re-render per frame.** A calendar drag would re-render the grid —
 *     every hour line, every block, every label — on every move to move one box.
 *     Here the pointer position is written into a closure variable and the
 *     visual is a `transform` written straight onto a node, so React renders
 *     once when the drag starts and once when it ends.
 *  2. **A frame, not an event.** Pointer events arrive in bursts and stop
 *     arriving at all while the finger is still. Autoscroll, though, has to keep
 *     moving while the pointer is parked at the edge of the grid, so the work is
 *     driven by `requestAnimationFrame` and reads the latest position each
 *     frame. One read per frame, before any writes, so the browser never has to
 *     lay the page out twice.
 *  3. **Capture, and a way out.** `setPointerCapture` keeps the gesture alive
 *     when the pointer leaves the element — without it, dragging a block past
 *     the edge of its column drops it. Escape cancels, and a lost capture or a
 *     `pointercancel` (the browser taking the gesture for a scroll) is a cancel
 *     rather than a drop, because a scroll must never move an event.
 *
 * TOUCH
 *
 * On a touch pointer the gesture is armed after a short hold. Before it is armed
 * the surface keeps its native `touch-action`, so a swipe still scrolls the grid,
 * and a move of more than a few pixels means the person was scrolling and the
 * gesture is abandoned. That is the same trade Google Calendar makes, and the
 * alternative — `touch-action: none` everywhere — makes a full-screen calendar
 * impossible to scroll on a phone.
 *
 * HOW A GESTURE ENDS, AND WHY THAT IS THE WHOLE CONTRACT
 *
 * Exactly one of `onEnd` or `onCancel` runs, on every path, and never twice.
 * `onEnd` means the pointer let go of an armed gesture and where it let go is
 * what the user asked for; `onCancel` means nothing was asked for.
 *
 * That totality is not tidiness. The caller draws a preview — a floating copy of
 * the block, a dashed slot, a lit cell — and the only thing that takes it down is
 * one of these two callbacks. A path that reaches neither leaves the preview on
 * screen for the rest of the session, which is a bug that had already happened:
 * a finger that lifted inside the hold window never armed, so the gesture ended
 * in silence and the slot it had drawn stayed lit. The fix is not "remember to
 * clear it there too", it is that there is no such thing as ending in silence.
 *
 * A release inside the hold window is therefore a **cancel**, and the caller is
 * told so. The tap's meaning is not lost: a touch that never became a drag still
 * produces a `click`, and that is where "put something here" belongs.
 */

/** Where the pointer is, and how far it has travelled since the press. */
export interface DragFrame {
  /** Pixels from the press, horizontally. */
  dx: number;
  /** Pixels from the press, vertically. */
  dy: number;
  /** Viewport coordinates of the pointer right now. */
  clientX: number;
  clientY: number;
  /** True once the gesture has travelled past the click threshold. */
  moved: boolean;
}

export interface PointerDragOptions {
  pointerId: number;
  /** The element to capture the pointer on. Must stay mounted for the gesture. */
  element: Element;
  originX: number;
  originY: number;
  /** True for a finger, which has to be able to scroll instead. */
  touch: boolean;
  /**
   * How long a touch must be held before it becomes a drag. Below this the
   * surface scrolls. Ignored for a mouse or a pen, where there is no conflict.
   */
  holdMs?: number;
  onFrame?: (frame: DragFrame) => void;
  onEnd?: (frame: DragFrame) => void;
  /** Escape, a cancelled pointer, a lost capture, or a release before the hold
   *  armed. Never a drop, and always reported. */
  onCancel?: () => void;
  /** Called once the gesture is definitely a drag rather than a tap. This is
   *  where a caller shows what it is dragging: nothing is drawn before it. */
  onArm?: () => void;
}

/** How far a pointer may travel before it is a drag rather than a click. */
const CLICK_SLOP = 4;

/** How far a touch may travel before the hold is abandoned to the scroller. */
const SCROLL_SLOP = 8;

/**
 * Run one gesture. Returns a function that ends it early.
 *
 * The returned function is for a component that unmounts mid-drag; calling it is
 * a cancel, so nothing is committed by a calendar being closed under a finger.
 */
export function beginPointerDrag(options: PointerDragOptions): () => void {
  const { pointerId, element, originX, originY, touch } = options;
  const hold = touch ? (options.holdMs ?? 180) : 0;

  let latestX = originX;
  let latestY = originY;
  let moved = false;
  let armed = hold === 0;
  let playhead = 0;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;

  const frame = (): DragFrame => ({
    dx: latestX - originX,
    dy: latestY - originY,
    clientX: latestX,
    clientY: latestY,
    moved,
  });

  const teardown = () => {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("touchmove", onTouchMove);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("blur", onPointerCancel);
    if (playhead !== 0) cancelAnimationFrame(playhead);
    playhead = 0;
    try {
      if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
    } catch {
      /* The element can be gone by now; there is nothing to release. */
    }
  };

  const stop = () => {
    if (finished) return false;
    finished = true;
    teardown();
    return true;
  };

  /**
   * The one way out. Every path below funnels through here, so "a gesture ended
   * and nothing was told about it" is not a case that exists.
   *
   * `end` is only ever passed by a release of an armed gesture. Everything
   * else — an early release, a `pointercancel`, a lost window focus, Escape, an
   * unmount — is a cancel, and cancelling is unconditional: it does not matter
   * whether the gesture got as far as arming, because the caller may have drawn
   * something the moment it did.
   */
  const finish = (ending: "end" | "cancel") => {
    if (!stop()) return;
    if (ending === "end") options.onEnd?.(frame());
    else options.onCancel?.();
  };

  const loop = () => {
    if (finished) return;
    playhead = requestAnimationFrame(loop);
    options.onFrame?.(frame());
  };

  const arm = () => {
    if (armed || finished) return;
    armed = true;
    try {
      element.setPointerCapture(pointerId);
    } catch {
      /* Capture is an optimisation; the window listeners still carry the drag. */
    }
    options.onArm?.();
    playhead = requestAnimationFrame(loop);
  };

  function onPointerMove(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    latestX = event.clientX;
    latestY = event.clientY;
    const travelled = Math.hypot(latestX - originX, latestY - originY);
    if (!moved && travelled > CLICK_SLOP) moved = true;

    if (!armed && travelled > SCROLL_SLOP) {
      // Still inside the hold, and really moving: the person is scrolling, so the
      // gesture is handed back to the browser rather than stolen from it.
      finish("cancel");
    }
    // Otherwise there is nothing to do here: the loop reads `latestX/Y` on the
    // next frame, which is what keeps a burst of moves to one piece of work.
  }

  function onTouchMove(event: TouchEvent) {
    // Once the hold has armed, the page must not also scroll. `touch-action`
    // alone cannot express "pan, unless the finger has been down for 180ms", so
    // the scroll is refused here instead.
    if (armed && event.cancelable) event.preventDefault();
  }

  function onPointerUp(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    latestX = event.clientX;
    latestY = event.clientY;
    if (Math.hypot(latestX - originX, latestY - originY) > CLICK_SLOP) moved = true;
    // A release inside the hold window never armed, so no frame was ever
    // delivered and there is nothing to commit. It is still an ending, and the
    // caller is told: it may be showing a preview it has to take down.
    finish(armed ? "end" : "cancel");
  }

  function onPointerCancel(event: Event) {
    if (event.type === "pointercancel" && (event as PointerEvent).pointerId !== pointerId) return;
    finish("cancel");
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    finish("cancel");
  }

  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);
  // Not passive: this one exists in order to call preventDefault.
  window.addEventListener("touchmove", onTouchMove, { passive: false });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("blur", onPointerCancel);

  if (hold === 0) {
    try {
      element.setPointerCapture(pointerId);
    } catch {
      /* As above. */
    }
    options.onArm?.();
    playhead = requestAnimationFrame(loop);
  } else {
    holdTimer = setTimeout(arm, hold);
  }

  return () => finish("cancel");
}

/**
 * The click that follows a drag, swallowed.
 *
 * A pointer gesture ends with a `click` on whatever is under the pointer, and on
 * a calendar that click lands on the day cell the block was just dropped into —
 * which would immediately open the create editor for the slot the user has only
 * just finished filling. This eats exactly one click, in the capture phase so
 * nothing downstream can act on it first.
 */
export function swallowNextClick(): void {
  const eat = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("click", eat, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", eat, { capture: true }), 350);
}
