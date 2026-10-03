# Xana — Design Spec

The contract for anything visual. Implement tokens once in `globals.css` and
never hardcode a colour, duration or size anywhere else.

**Part of this file is executable.** `npm run check:design` asserts the rules
that can be decided from the source — the type floor below 13px, the heading
outline, long values wrapping instead of widening a 390px sheet, cards using the
project's own `.card`, and the caret and native controls resolving from the
accent channels — and `npm run verify:web` asserts the contrast ratios against
the *served* stylesheet. Everything else here is prose a reviewer has to hold in
their head, so treat the two gates as the floor and this document as the
standard they encode. A rule that turns out to be decidable belongs in the
script; a rule that lives only in prose has already been broken once without
anyone noticing.

## 1. Palette

Deep, near-black, quiet. Nothing in this UI should ever be pure white or
saturated.

| Token | Value | Use |
|---|---|---|
| `--void` | `#040406` | Page background. The dark she lives in. |
| `--surface` | `#101017` | Cards, panels, the input field. |
| `--surface-2` | `#1C1C25` | Raised/hover state of a surface. |
| `--surface-3` | `#282836` | The lightest step. Skeletons, pressed states. |
| `--hairline` | `#2F2F3F` | 1px borders. Never brighter. |
| `--hairline-2` | `#3E3E4E` | Hover state of a hairline. |
| `--accent-rgb` | `111 227 227` | Primary accent, as **channels**. Presence, focus, energy. |
| `--accent-2-rgb` | `156 140 255` | Secondary accent. Acting, recall, the horizon wash. |
| `--text` | `#F1F2F7` | Primary text. |
| `--text-dim` | `#AEB0C2` | Secondary text, body of cards. |
| `--text-faint` | `#8E92A6` | Labels, timestamps, meta. The floor is 4.5:1. |
| `--warn` | `#E0B279` | Nudges of tone `warn`. Muted amber, not red. |
| `--good` | `#86D6A6` | Tone `celebrate`. Muted, not a success-green starburst. |
| `--danger` | `#E08A8A` | A failed save or a refused key. The only red. |

### Contrast and the type scale

These are enforced, not documented. `npm run verify:web` reads the values out
of the served stylesheet and fails if any of them stops holding.

| Text | on void | on surface | on surface-2 | on surface-3 | floor |
|---|---|---|---|---|---|
| `--text` | 18.1 | 16.8 | 15.2 | 13.6 | 4.5 |
| `--text-dim` | 9.4 | 8.8 | 7.9 | 7.1 | 4.5 |
| `--text-faint` | 6.6 | 6.2 | 5.5 | **4.7** | 4.5 |

A contrast ratio is a *relationship* between two tokens, not a property of
one. `--text-faint` has now been raised twice: first from `#6A6C7E`, which
measured 3.89:1 and failed outright, then from `#84879A`, which measured
4.54:1 and passed by four hundredths — until an unrelated change to
`--surface-3` took it to 4.21:1. Nothing caught that, because the promise was
a comment. It is an assertion now.

**Weight is part of legibility, not a style choice.** Every colour above can
pass while the interface still reads as fog, because a 300-weight stroke at
11px on a near-black field is roughly one pixel wide and the eye cannot resolve
it however good the contrast is.

| Size | Weight |
|---|---|
| 12px and below | `font-normal` (400) or heavier. `font-light` is not used. |
| 13px | `font-light` at the lightest, and only on `--text` or `--text-dim`. |
| 14px and above | `font-light` is fine. |

The project previously used `font-light` on 90% of everything 13px and
smaller. It was brought down to 43%, and this line used to claim that none of
it was below 13px. That claim was wrong, and it was wrong in the one place the
gate could not look: `.timestamp` — the utility behind every date, count and
piece of working in the app — was declared `11px` at `font-weight: 300` in
`globals.css`, which is exactly the combination forbidden above. Nothing
caught it because `check:design` read class lists in `.tsx` and a stylesheet
is not a class list.

It is caught now, twice over. `.timestamp` is 12px at weight 400, and rule 8
in `check:design` reads every block in the stylesheet: nothing below 11px, and
nothing at 12px or below in a 300 weight. A design detector reading the served
page found the old value before the gate did — which is the honest order of
events, and the reason the gate exists now.


### The structural rule

**Accents are stored as raw sRGB channels, never as a finished colour.**

```css
--accent-rgb: 111 227 227;      /* not: --accent: #7fe3e3 */
--a-14: rgb(var(--accent-rgb) / 0.14);
```

Every accent shade in the system — borders, washes, glows, gradients, shadows,
the focus ring, the selection colour, the orb's canvas — is *composed* from
those three numbers at runtime. That is what makes a theme picker possible
without a single component knowing it exists: change three integers on `<html>`
and the whole interface re-derives itself, including colours that were never
explicitly themed.

The ramp, so nobody invents an opacity: `--a-04 --a-08 --a-14 --a-24 --a-40
--a-64`, and `--a2-08 --a2-14 --a2-24` for the secondary.

### Depth

Shadows carry a tint of the accent. That is what stops a dark UI reading as flat
grey. Composition order matters: a tight contact shadow, then a wide ambient
one.

| Token | Use |
|---|---|
| `--shadow-1` | Barely there. Inline chips. |
| `--shadow-2` | A card at rest. |
| `--shadow-3` | A card hovered, a floating panel. |
| `--shadow-glow` | The accent halo on anything interactive. |

### Ambient light

The page is **not** a flat fill. Two very low radial washes give the void a top
and a horizon, so the eye reads the orb as sitting *in* a space rather than on a
black rectangle. `--ambient-glow` (default `0.13`) is user-adjustable, and zero
is a legitimate choice.

### Themes

Six hand-tuned presets: `xana`, `aurora`, `ember`, `lilac`, `signal`, `moss`,
plus a custom pair chosen with a native colour picker. They are picked by eye
rather than generated by rotating a hue — an accent needs luminance above
roughly 180 to read as light on `#07070A`, and its hue has to survive being
rendered at 8% alpha without going muddy. Automatic rotation fails both tests.

**Rule:** accent colour occupies well under 5% of the screen. It marks presence
and state; it never decorates.

## 2. Typography

One family: the system UI sans stack. Thin weights only.

```
--font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
--font-mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace;
```

| Role | Size | Weight | Tracking | Colour |
|---|---|---|---|---|
| Orb caption | 15px | 300 | 0.01em | `--text-dim` |
| Briefing line | 15px | 300 | 0.01em | `--text` |
| Card body | 14px | 300 | 0 | `--text-dim` |
| Settings body | 13px | 300 | 0 | `--text-dim` |
| **Label** (small caps) | 11px | 500 | 0.15em, `uppercase` | `--text-faint` |
| Numeric / metric | 30px | 200 | `-0.02em` | `--text` |
| Timestamp, counts, working | 12px | 400 | 0.03em | `--text-faint` |

Labels are always uppercase with wide tracking — this is the signature of the
interface. Use `.label`. The treatment was 10px at 0.18em; it is 11px at
0.15em, which is the same shape at the same optical width, because 10px is
below the floor for text a person has to read and the label names the row
underneath it.

**11px is the floor for functional text anywhere in this interface**, and
nothing at 12px or below is set in a 300 weight. Both halves are asserted by
`check:design` (rules 1 and 8) against the components *and* the stylesheet,
because a rule that lives in one of those two places is a rule with a door in
it.

The body scale sits at 15px rather than 13–14px. The smaller scale was legible
on a large display and cramped on a laptop, and this is a product people read
rather than a spec they scan.

## 3. Space & shape

- Scale: `4 8 12 16 24 32 48 64 96`.
- Radius: `--r-sm: 8px`, `--r-md: 12px`, `--r-lg: 16px`, `--r-xl: 20px`,
  `--r-full: 999px`. Cards sit inside the 12–16px band; the step above it is for
  sheets, which are not cards. (This line said 18px and 24px for two releases
  after the stylesheet had moved, which is the drift a design document has to be
  read against the code to catch.)
- Cards: `--surface`, a `--fill-1` top sheen, a hairline border, `--shadow-2`.
  They lift 1px and warm their border on hover. **1px, not 4px**: the interface
  should feel like it has depth, not like it bounces.
- Panels and floating surfaces (the settings sheet, tooltips) use `--r-xl` and
  `--shadow-3`.
- Max content width `760px`, centred. The orb is centred in the viewport. A
  board (the goals columns) may run wider, about `1180px`, because three columns
  are the point; a form or a list sits in `--content-max`. What is not allowed is
  a form spanning a 1416px window, which is what the cave did.
- **A calendar is a board, not a list.** The month grid and the week grid take the
  same ~1180px, because seven columns at a readable width do not fit in 760. What
  keeps that from being the thing this section forbids is that a grid of days has
  no line length: the text inside it is a title clipped to its own cell, and there
  is no sentence to read across it.

### One small control

`.chip` is every small button in the app: a row action, a filter, a room, a meal,
a mood. `.chip-round` is the same control drawn as a pill, which is what a row of
choices looks like. The rooms had grown **twenty inline recipes** for this button
between them — four radii, three paddings, and a selected state that was `/10` in
one room, `/15` in another and a `/60` border in a third — and no two of them
were identical. The chosen state is now `[aria-pressed="true"]` on a chip, which
is one rule and one look.

`.label` is the only uppercase treatment. It had been retyped five times with a
different size or tracking each time; rule 11 in `check:design` refuses a new
one, and `data-mark` is how a deliberately different treatment declares itself.

`.body-text` is the 15px body, in `:where()` so `class="body-text text-dim"` is
how a quieter paragraph is written. It was dead code before this pass — declared,
documented and used nowhere while the same recipe was retyped twenty times.

### The tap floor

**Below 768px, every control a thumb presses is at least 44px tall as a real
box.** `.chip`, `.tap`, `.icon-tap`, `.btn`, `.field` and `.select` carry it;
`.switch` and `.slider` grow to it. Three things this rule is not:

- **Not a pseudo-element.** A hit area grown by `::before` leaves
  `getBoundingClientRect()` at the drawn size, so nothing can assert it and
  nobody can see it in a screenshot. The floor is real height, and
  `verify:browser` measures every control on the phone viewport against it.
- **Not the same as small.** A 3px `range` track and a 22px switch track are
  correct *drawings*; the box around them is what grows. The slider keeps its
  3px track with `background-clip: content-box`, and the switch stays a pill.
- **Not only the buttons.** The composer pill looked like one 54px target and
  behaved like the 24px line of text inside it, because nothing focused the
  field when the padding was clicked. It does now.

### Recessed surfaces and washes

A recessed surface is black at one of three depths: `--well` (a field, a code
block), `--well-deep` (the focused field), `--scrim` (behind a dialog). A wash is
one of six accent alphas: `--a-04 --a-08 --a-14 --a-24 --a-40 --a-64`. Both are
enforced — rule 9 refuses `bg-black/NN` and any `accent/NN` off the ramp — because
the interface had drifted to four black literals and nine accent alphas, and the
theme picker's promise is only as true as the ramp is small.

## 4. Motion

Everything breathes. Nothing snaps.

| Token | Value | Use |
|---|---|---|
| `--motion` | `1` | Global speed multiplier. Every duration below is `calc(base * var(--motion))`. |
| `--t-fast` | `180ms` | Hover, focus, colour. |
| `--t-state` | `200ms` | A control changing state: a border warming, a knob travelling, a switch filling. |
| `--t-base` | `320ms` | Something *arriving*: a card, a sheet, a toast. |
| `--t-slow` | `520ms` | Layout shifts, orb state changes. |
| `--ease` | `cubic-bezier(0.22, 0.61, 0.36, 1)` | Default. Decelerating. |
| `--ease-soft` | `cubic-bezier(0.4, 0, 0.2, 1)` | Symmetric, for loops. |
| `--ease-arrive` | `cubic-bezier(0.16, 1, 0.3, 1)` | Ease-out-expo. Things that *arrive*: toasts, switches. |

`--t-base` used to carry two jobs, and one of them was wrong. 320ms is right
for something that travels into place, where the eye is following the
movement; it reads as lag on a border colour or a 16px knob, where the eye is
watching for an answer. State changes are 200ms now (the band a product
transition wants is 150–250ms), entry still takes 320ms.

`--ease-arrive` was `--ease-out-back` — a gentle overshoot — until a design
detector named the family: bounce and elastic easing read as dated next to an
exponential curve, which is how real objects decelerate. Nothing about the
arrival needed the overshoot; it needed the speed.

`--motion` is the settings slider. It is a multiplier on the designed pace, not
a replacement for it, and it never overrides the OS reduced-motion setting.

**Card entry.** `opacity 0 -> 1`, `translateY(10px) -> 0`, `scale(0.995) -> 1`,
`--t-base`, staggered `40ms` per card index, capped at 4.

**In the orb** (see §5) the durations live in the renderer as *half-lives*, not
durations: a state change eases toward its target over a fixed time constant,
which is what makes it feel like one object changing its mind rather than a
cross-fade between two objects.

**`prefers-reduced-motion: reduce`** — the orb's loop stops entirely and one
still frame is drawn; the breath, the rotation and the stagger stop; the ripple
becomes a pure opacity fade. Opacity and colour transitions survive, so a state
change still reads without movement. Non-negotiable, and not merely detected —
the canvas is genuinely never animated in that mode.

### Dragging is tracked, not animated

The calendar is the one surface a person moves things around on, and it is worth
naming what that costs, because the obvious implementation is wrong.

**A drag writes a `transform` on the frame the pointer moved.** It is not a
transition towards a target: an easing curve under the hand is the difference
between holding an object and pulling it on a string, and at a quarter-hour snap
it also hides the thing the snap is telling you. So the gesture owns a frame loop
(`requestAnimationFrame`, one read before any write) and React renders twice per
drag — once when it is picked up, once when it is put down — rather than once per
frame. Every duration token in this document is for something the user is
*watching*; a drag is something they are *doing*.

**What is animated is the arrival.** A block that has just been dropped fades up
from 55% to full over `--t-state` — one beat, no travel, and only ever in
response to a drop. Under reduced motion the fade stays and nothing else does,
which is the same rule the entry animations follow.

**One number is shared with the stylesheet.** `--cal-hour` is the height of an
hour. The geometry module positions every block with it and the stylesheet draws
the hour rules with it, from the same value, because two independent answers to
"how tall is an hour" put every block a few pixels off the line it claims to
start on — a wrongness that is visible and unnameable.

**A gesture ends exactly once, and says how.** `beginPointerDrag` reports
`onEnd` or `onCancel` on every path and never both, and a release inside the
180ms touch hold is a cancel rather than silence. The caller draws its preview
on `onArm` — never on `pointerdown` — and takes it down in one of those two
callbacks, so "the gesture ended and nobody was told" is not a state that
exists. It existed: a tap on empty grid left its drawn slot in the DOM for the
rest of the session, because the path that ends a gesture without arming
returned in silence. Nothing is drawn before arming for the second half of the
same reason: a dashed block that appears under a finger which turns out to be
scrolling is the calendar claiming an intention nobody had.

**A block's resize grips come out of what the body can spare.**
`gripHeightFor(px, coarse)` takes the body's minimum first — 18px under a
finger, 12px under a cursor — caps the grip at 14 or 8px, and returns zero when
what is left is too thin to hit. A block with no grips moves by its whole body,
and its length is changed in the editor, which is exact. The fixed 14px grip
this replaced left a 30-minute block at 390px with a body of **minus six
pixels**: every press reached a handle, so the most ordinary short event could
be made longer and never moved.

**The event board is measured, and on a phone it docks.** The form is placed
from the box it actually has, inside a `max-height` counted from the viewport,
so it cannot be taller than the screen and cannot put its own buttons past the
fold — the version this replaced was positioned against a hard-coded 360px
height while standing 574px tall, which put `Add`, `remove` and `Close` 206px
below the bottom edge with no other way out. Below the compact breakpoint it
docks to the bottom edge behind a scrim rather than floating beside a 22px
block. Escape, a press outside, the scrim and `Close` all close it, and Escape
is taken on the document in the capture phase, because a React handler cannot
stop the cave's own document listener — which is how closing the form once
closed the room with it.

## 5. The orb

The only focal element, and now a real 3D object rather than stacked divs.

**Live orb** — `src/components/xana/orb/`. A hand-written 3D renderer on a 2D
canvas: a few hundred points on a real sphere, three orbit rings sampled as
tilted 3D circles, a luminous core, and ripples expanding in the orb's own
equatorial plane. Everything is rotated, perspective-projected, and drawn with
size and alpha derived from each vertex's depth, every frame.

Why hand-rolled rather than three.js: ~600 KB is too much to add to a
local-first assistant that must work with no network and no build step, in order
to draw one object. And the orb's easing *is* the personality — the half-lives
that make it lean toward your cursor rather than mirror it, the 23s/31s drift
periods that keep the sway from settling into a loop, the tint that crossfades
slowest of all. That is easier to get right with the maths in front of you.

| Presence | Shell | Density | Spin | Breath | Core | Tint |
|---|---|---|---|---|---|---|
| `dormant` | 0.42 | 0.38 | 150s | 9s | 0.30 | accent |
| `idle` | 0.52 | 0.78 | 96s | 6.5s | 0.60 | accent |
| `thinking` | 0.47 | 0.96 | 26s | 2.4s | 0.80 | accent |
| `speaking` | 0.53 | 0.86 | 60s | 3.4s | 1.00 | accent |
| `acting` | 0.46 | 1.00 | 20s | 2.8s | 0.85 | **secondary** |

Every column is a *target*; the renderer eases toward it, so moving between
presences is a transition rather than a cut.

Interaction: the pointer leans the camera (heavily damped while dragging); a
drag spins the orb with real inertia that decays; a reply sends a wave out from
the core. Depth is normalised against **the object being drawn**, not the
canvas — pass the wrong radius and every particle lands in the middle of the
depth range and the sphere flattens into a disc.

**CSS orb** — the fallback, and a real one. Kept for two cases: a browser with
no canvas context, and reduced motion, where a still layered disc communicates
the state better than a particle field that never stops turning. Same geometry
as before: halo, three rings, core, inner light — all sized from
`--orb-size` (260 / 300 / 340px by breakpoint).

**Accessibility:** the orb is `role="status"` with an `aria-label` naming the
current state, on a focusable element that focuses the composer. The canvas is
`aria-hidden`; a screen-reader-only sentence carries the same information, and a
visible one-line caption sits beneath.

## 6. Layout

```
┌──────────────────────────────────────────┐
│  XANA        [status dots]   [⚙ Settings]│  header: name + adapters, 60px
│                                          │
│                                          │
│              ◯  the orb                  │  centred, breathing, interactive
│           "Good morning."                │  one line, her voice
│                                          │
│                                          │
│  ┌─ peripheral cards (only when needed) ─┐│  scrolls, fades in
│                                          │
│  ┌──────────────────────────────────────┐│
│  │  Ask Xana…                     [↵]   ││  input, pinned, 1px hairline
│  └──────────────────────────────────────┘│
└──────────────────────────────────────────┘
```

- Header and input are fixed. The middle region scrolls. The header is a
  minimum height, not a fixed one: on a narrow screen the name and the status
  row take a line each rather than overlapping. The wordmark is the only item
  that cannot shrink and the dots are the only item that must not, so one of
  them used to be painted over the other — at 390px the status dots covered
  half the app's name.
- Cards are **peripheral**: they appear on a reply, and fade back to `opacity
  0.55` after 20s of no interaction. Hover restores full opacity.
- On an empty session the card area is empty — just the orb. That emptiness is
  the point.
- Connection status is a row of dots in the header; `--good` connected,
  `--text-faint` local, `--warn` error. Tooltip on hover *or* focus, and the row
  carries an `aria-label` stating the counts — colour is never the only signal.
- A connection **waiting for permission** is a hollow ring (`ring-1 ring-faint`),
  not an amber dot. It is neither healthy nor broken: nothing has failed and
  there is a button to press. Painting it `--warn` would put it in the same class
  as a rejected API key, which is how a user learns to ignore the dot that
  matters. The header button carries a `--a-64` pixel beside it instead, and its
  `aria-label` counts them separately from the failures.

### Settings

A right-hand panel on a wide screen, a full-height sheet on a narrow one. The
panel rather than a centred modal is deliberate: the orb stays visible beside
it, so the theme picker and the motion slider are a live preview of the actual
interface rather than a swatch that promises something.

Sections: **Appearance** (palette, custom colours, ambient light, motion),
**Voice** (spoken replies, voice, rate, pitch — each with a sample), **Model &
key** (provider, model, key, a real test request, persona), **Connections** (one
card per connection: what leaves the machine, what you get, each capability with
its reason and hosts, settings, and Allow / Withdraw), **About** (where the file
lives, and what she does without any of it).

Connections is one list rather than two screens, grouped by what it takes to
connect — **Your data**, **Services**, **Devices**, **Bundled** — and the
grouping is the server's, shipped with the response. A kind with nothing in it is
not rendered, because an empty heading promises something that is not there. The
card says **answered by** against the provenance rather than "source", because one
of the kinds is literally called a source and two meanings for one word on one
screen is a caption the user has to decode.

The connection card is the consent surface, so its order is a safety decision
rather than a layout preference: what leaves the machine first, then what you
get, then the capabilities in danger order (`remote.write` last), then the
fields, then the buttons. A `remote.write` grant gets its own control — allowing
reads and allowing changes are different decisions and must not share a click.

At the foot of Connections, collapsed, sit the older flat `XANA_*` values — one
disclosure generated from `SOURCE_GROUPS`, kept so a key that still resolves from
the environment can also be cleared. The health card carries one block more,
**From your phone**: the ingest URL, the header name, a body to paste, and the
two platform paths. It is deliberately not a warning treatment — nothing there is
broken or missing, it is an offer — and the one honest sentence about the network
sits under it: she has to be reachable on your LAN for a phone to post, and the
switch that makes her reachable exposes this interface too.

It is a real dialog: `role="dialog"`, `aria-modal`, a focus trap, Escape to
close, focus returned to whatever opened it, and the page behind locked from
scrolling.

## 7. Voice in the UI

- Text is sentence case, never Title Case or ALL CAPS (labels excepted).
- Xana's lines are short. If a string needs a comma splice, it is two strings.
- No exclamation marks. No emoji. No "Oops", no "Sorry".
- Buttons on cards are verb-first and lowercase: `protect it`, `start focus`,
  `log it`, `show me`.
- Empty states are statements, not instructions: "Nothing scheduled."
- Settings copy explains *why*, in one sentence, and never scolds. A field with
  no key says what still works without one.

## 8. Anti-patterns — do not ship these

- Gradients that announce themselves; neon glows; glassmorphism.
- Shadows that are grey. If a shadow is visible as a shadow, it is too strong;
  if it is visible at all it should carry a tint of the accent.
- More than two accent colours on screen at once.
- Spinners. Use the breathing shell, or the two drifting bars while she thinks.
- Charts with axes, grids or legends. Rings and thin bars only.
- Animating anything the user did not cause, except the breath.
- A disabled control with no explanation. Say what is missing instead.
- Text below 11px, or anything at 12px or below set in a 300 weight. The floor
  is asserted in both places text can be declared — class lists and the
  stylesheet — because a rule that covers one of them is a rule with a door.
- Bounce or elastic easing. Things arrive quickly and decelerate; they do not
  spring.
- A full pill on a small chip: pills are for the composer and for things a
  thumb presses.

## 9. Time

**The app's clock is Asia/Shanghai's, not the machine's and not the browser's.**

Everything calendar-shaped goes through one module, `src/lib/core/zone.ts`, and
`APP_TIME_ZONE` there is the only place a timezone is named. Date keys, clock
readings, day starts and ends, weekday labels, and every "today" or "tomorrow"
come from it, on the server and in the browser alike, so the two cannot disagree
about which day it is. They used to: date keys were built from `getFullYear()`
and each client component formatted with its own `toLocale*` call, which made the
same instant two different days for eight hours out of every day in any pair of
zones that straddle midnight. The user asked for Beijing time in the calendar;
what made it a bug rather than a preference is that this machine already runs
Asia/Shanghai, so the dependency on the host was invisible from here.

Two things the contract fixes:

- **No offset is written down.** `+08:00` appears nowhere. The zone is read
  through `Intl`, every helper takes the zone as a parameter, and moving the app
  to another zone means changing that one constant. Asia/Shanghai has no daylight
  saving, so a day is exactly 24 hours here, but the boundaries derive that
  rather than assume it: `endOfDay` is the next day's start minus a millisecond,
  and adding a day keeps the wall-clock time rather than adding 24 hours.
- **The zone is a constant, not a setting.** There is no picker and no
  per-connection override, deliberately: one user, one machine, and a wrong zone
  in a settings file is a silent eight hour error in everything downstream.
  `npm run verify:zone` measures the whole layer, including in a child process
  whose host zone is UTC, which is the check a machine already set to Beijing
  cannot make from the inside.
- **A label never throws.** `Intl.DateTimeFormat` raises a `RangeError` on an
  unusable instant, where the `toLocale*` calls it replaces returned the string
  "Invalid Date". The zone helpers answer with an empty string instead. This is
  not hypothetical: a cave room renders its day label before the server has said
  which day it is, and the difference between the two was a wrong label and a
  blank room with a stack trace in it.

The zone is pinned; the language is not. Clock and weekday labels still follow
the runtime's locale, exactly as the `toLocale*` calls they replace did, so an
English browser reads "01:30 AM" and "Saturday" rather than a 24 hour clock and
another language's day names. Time is the app's; language is the reader's.
