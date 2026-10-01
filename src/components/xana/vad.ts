/**
 * Finding where one spoken sentence ends, and nothing else.
 *
 * WHY THIS IS ITS OWN MODULE, AND PURE
 *
 * The recorder needs a single fact the browser will not give it: "they have
 * finished talking". Everything about whether hands-free listening works hangs
 * off that one decision, and three separate bugs have already come out of it —
 * each found by reading a log rather than by reading the code:
 *
 *   1. No minimum on speech length. A door, a keyboard or a chair crossed the
 *      threshold, the quiet that followed satisfied the silence rule, and the
 *      clip ended after a few hundred milliseconds. Whisper got a fragment and
 *      returned an empty string, which the user experienced as "it listened for
 *      half a second and stopped".
 *   2. The noise floor kept adapting WHILE SPEECH WAS HAPPENING. Talking raised
 *      the estimate of "this is just the room", the threshold climbed past the
 *      speaker's own voice, and detection switched off mid-sentence. The clip
 *      then ran to the twelve-second ceiling as pure silence and transcribed as
 *      nothing — the log line `chars=0 ms=11960`.
 *   3. A single instantaneous peak decided speech had started, so a click or a
 *      lip smack began a clip and then ended it.
 *
 * None of those is visible in a code reading. All three are one line in a log.
 * So the decision now lives here as a pure function of (state, loudness, clock),
 * and `scripts/check-vad.ts` drives it through the exact scenarios that broke it
 * — a transient click, a long sentence, a quiet speaker in a noisy room, silence
 * that never becomes speech. A microphone is not needed to test any of it, and a
 * regression names itself instead of arriving as a support report.
 *
 * THE SHAPE OF THE DECISION
 *
 * Two thresholds, not one. Speech opens at `openLevel` and only closes below
 * `closeLevel`, which is lower. One threshold makes a level hovering right at it
 * flicker between "speech" and "silence" sixty times a second, and the silence
 * timer restarts on every flicker, so a sentence never ends. This is the same
 * hysteresis every squelch circuit uses.
 *
 * The noise floor is tracked ONLY while quiet. During speech the room's own
 * baseline is unknowable from the signal — the speaker IS the signal — and
 * guessing it is bug 2 above.
 */

/**
 * The floor starts almost at zero, and that is deliberate.
 *
 * An earlier version started it at an absolute constant — "a quiet room is about
 * this loud" — and that constant turned out to be a livelock. A room noisier than
 * the constant tripped the opening threshold immediately, so the detector decided
 * it was hearing speech; the floor only adapted on the QUIET path, and the loud
 * path was never left, so the floor never learned the room and the threshold
 * never rose above it. The detector sat there believing it was listening to an
 * endless sentence, and produced a clip of silence at the twelve-second ceiling.
 *
 * Starting near zero makes the room learnable from any starting condition: a
 * steady tone is read as speech, speech ends, the quiet path runs, the floor
 * climbs to the room, and the threshold rises above it. Self-correcting beats
 * pre-calibrated, because a detector cannot know the room before hearing it.
 */
export const SILENT_FLOOR = 0.0008;

/** Opening level as a multiple of the measured noise floor. */
const OPEN_RATIO = 3;

/** Closing level: lower than the opening one, so a level near the threshold
 *  cannot flicker between the two states and restart the silence timer. */
const CLOSE_RATIO = 1.8;

/** A short peak must persist this long before it counts as speech starting. */
const ONSET_MS = 120;

/** How fast the floor follows the room while quiet. ~0.4s to settle. */
const FLOOR_FOLLOW = 0.02;

/**
 * The floor is a MINIMUM, not an average, and the two rates are asymmetric.
 *
 * This is the whole fix, and it is simpler than the confirmation flag it
 * replaced. A room's baseline is the quietest thing in it, so:
 *
 *   - Falling is fast. The moment the sound drops, the estimate follows, which is
 *     what lets a fan or a road be learned within about a second.
 *   - Rising is slow. A voice is louder than the room, so a rising estimate can
 *     only ever be dragged up by sound that is not the room — which is precisely
 *     the bug that cut sentences off mid-word. Rising slowly means a voice never
 *     raises it far enough to matter, while a genuine fan still gets absorbed in
 *     a few seconds.
 *
 * An earlier version used a confirmation flag to switch between two rates. It
 * worked in the easy cases and flickered in the grey zone, because the flag is a
 * guess about the sound and the minimum is a fact about it. Facts are better.
 */
const FLOOR_FALL = 0.25;
const FLOOR_RISE_CONFIRMED = 0.002;
const FLOOR_RISE_UNCONFIRMED = 0.06;

/** Speech must last at least this long before its end can stop the clip. */
export const MIN_SPEECH_MS = 350;

export interface VadConfig {
  /** Quiet for this long after speech ends the sentence. */
  silenceMs: number;
  /** No speech at all by now, and the attempt is abandoned. */
  noSpeechMs: number;
  /** Hard ceiling, so a noisy room cannot record forever. */
  maxMs: number;
}

export const DEFAULT_VAD: VadConfig = { silenceMs: 850, noSpeechMs: 7000, maxMs: 15000 };

export interface VadState {
  /** The running estimate of the room. */
  floor: number;
  /** The level speech must cross, and stay below, to end. */
  threshold: number;
  /** When the current loud stretch began, or null when not in one. */
  loudSince: number | null;
  /** When speech was considered to have started, or null. */
  speechAt: number | null;
  /** When the current quiet stretch began, or null. */
  quietSince: number | null;
  /**
   * Whether the current loud stretch has lasted long enough to be believed.
   *
   * The distinction the whole detector turns on. An unconfirmed sound is
   * probably the room and the floor learns it quickly; a confirmed one is
   * probably a person and the floor stops moving so the sentence is not cut off
   * mid-word.
   */
  speechConfirmed: boolean;
}

export function initialVad(): VadState {
  return {
    floor: SILENT_FLOOR,
    threshold: SILENT_FLOOR * OPEN_RATIO,
    loudSince: null,
    speechAt: null,
    quietSince: null,
    speechConfirmed: false,
  };
}

export type VadVerdict =
  | { kind: "listening" }
  | { kind: "speech-started" }
  | { kind: "speech-ended"; durationMs: number }
  | { kind: "no-speech" }
  | { kind: "too-long" };

export interface VadStep {
  state: VadState;
  verdict: VadVerdict;
  /** True when the level is currently above the closing threshold. */
  loud: boolean;
}

/**
 * Advance the detector by one sample of loudness.
 *
 * `level` is a peak amplitude in 0..1 from an `AnalyserNode`; `now` is a
 * millisecond clock. Both are passed in rather than read, which is what makes
 * this testable without an audio device.
 */
export function stepVad(
  state: VadState,
  level: number,
  now: number,
  config: VadConfig = DEFAULT_VAD,
  startedAt = 0,
): VadStep {
  const next: VadState = { ...state };
  const aboveClose = level > next.threshold;

  /**
   * The ceiling is checked FIRST, before anything branches on loudness.
   *
   * A previous version checked it only on the quiet path, so a speaker who never
   * stopped — or a room loud enough that speech never "ended" — ran forever,
   * holding the microphone open and never transcribing. The check has to be
   * independent of what the level is doing.
   */
  if (now - startedAt > config.maxMs) {
    return { state: next, verdict: { kind: "too-long" }, loud: aboveClose };
  }

  if (aboveClose) {
    next.quietSince = null;
    if (next.loudSince === null) next.loudSince = now;

    const longEnough = next.loudSince !== null && now - next.loudSince >= ONSET_MS;

    // ORDER MATTERS, and getting it wrong is subtle. The floor rises only once
    // the sound has been going long enough to be considered at all, so a real
    // word gets its 120ms of grace before the estimate can move under it. Rising
    // first — which an earlier attempt did — let the floor climb to the speaker's
    // own level inside that window, and nothing ever registered as speech.
    if (longEnough) {
      const rise = next.speechConfirmed ? FLOOR_RISE_CONFIRMED : FLOOR_RISE_UNCONFIRMED;
      next.floor += (level - next.floor) * rise;
    } else {
      // Within the onset window, follow downward only. A crackle that stops
      // should not leave the estimate inflated.
      next.floor = Math.min(next.floor, next.floor + (level - next.floor) * FLOOR_FALL);
    }

    if (longEnough && !next.speechConfirmed) {
      next.speechConfirmed = true;
      /**
       * The bar is SET once, at the moment speech is believed, and then left
       * alone for the rest of the sentence.
       *
       * Setting it matters as much as freezing it, and the first version of this
       * only froze. It froze the STARTING threshold — 0.0024 — which is below an
       * ordinary room's noise floor, so the room itself stayed "above the
       * threshold" for the whole sentence, the quiet path never ran, the silence
       * timer never started, and the clip ran to the twelve-second ceiling. The
       * end of a sentence was undetectable because the bar for "still talking"
       * was lower than the bar for "this room is silent".
       *
       * `floor * CLOSE_RATIO` is that bar: comfortably above the room, and
       * comfortably below the voice that just crossed a threshold three times
       * higher than the room. Freezing it there is what stops a pause between
       * words from ending the sentence early, which was the original bug.
       */
      next.threshold = Math.max(SILENT_FLOOR, next.floor * CLOSE_RATIO);
      if (next.speechAt === null) {
        next.speechAt = next.loudSince ?? now;
        return { state: next, verdict: { kind: "speech-started" }, loud: true };
      }
    }
    // The bar rises with the room until speech is believed, which is what stops
    // a fan being listened to as though it were a sentence.
    if (!next.speechConfirmed) {
      next.threshold = Math.max(SILENT_FLOOR, next.floor * OPEN_RATIO);
    }
    return { state: next, verdict: { kind: "listening" }, loud: true };
  }

  // Quiet: falling is fast, so the room is learned as soon as it is audible.
  next.floor += (level - next.floor) * FLOOR_FALL;
  next.loudSince = null;
  next.speechConfirmed = false;
  // Hysteresis: a level near the line must not flicker across it, because every
  // flicker restarts the silence timer and the sentence never ends.
  const ratio = next.speechAt !== null ? CLOSE_RATIO : OPEN_RATIO;
  next.threshold = Math.max(SILENT_FLOOR, next.floor * ratio);

  next.loudSince = null;
  if (next.speechAt !== null && next.quietSince === null) next.quietSince = now;

  if (next.speechAt === null) {
    if (now - startedAt > config.noSpeechMs) {
      return { state: next, verdict: { kind: "no-speech" }, loud: false };
    }
    return { state: next, verdict: { kind: "listening" }, loud: false };
  }

  const quietFor = next.quietSince === null ? 0 : now - next.quietSince;
  const speechLasted = (next.quietSince ?? now) - next.speechAt;
  if (quietFor > config.silenceMs && speechLasted >= MIN_SPEECH_MS) {
    return {
      state: next,
      verdict: { kind: "speech-ended", durationMs: now - startedAt },
      loud: false,
    };
  }

  return { state: next, verdict: { kind: "listening" }, loud: false };
}
