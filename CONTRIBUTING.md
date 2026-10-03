# Contributing

Xana is a personal project that happens to be public. It is not trying to
become a community or a company, and the honest starting point for anyone
reading this is that its direction is set by one person's use of it. With that
said, bug reports are genuinely useful, and a patch that fixes something real
is welcome.

## What this project is licensed as, and what that means for you

Xana is **source-available under the PolyForm Noncommercial License 1.0.0** —
see [LICENSE](LICENSE). You may read it, run it, study it, change it, and share
it for any noncommercial purpose. You may not use it commercially.

That applies to your contribution too, so by opening a pull request you agree
that:

1. your contribution is licensed to everyone under the same terms as the rest
   of the project, and
2. the copyright holder may also license your contribution under other terms,
   including a commercial license.

The second point is not a formality. The reason this project can offer a
commercial license at all is that a single copyright holder is free to license
the whole work; if contributions arrived under the project's terms only, that
option would be gone for any file a contributor had touched. If you are not
comfortable with that, please open an issue describing the fix instead of a
pull request — that is a completely reasonable thing to do, and the fix can be
written here.

This paragraph is a plain-language statement of intent, not legal advice, and
it is not a signed agreement. If a contribution ever matters commercially,
that conversation happens before it is merged.

## Running it

```bash
npm install
npm run seed          # build a plausible life so there is something to look at
npm run dev           # prints the URL it started on
```

`npm run dev` starts the Next server programmatically rather than shelling out
to `next dev`; the reasons are in the [README](README.md#L22). Node 20 or newer.

Your data lives in `data/` and is never in the repository. If you want the app
to use a different directory — which is what the verification scripts do, so
they cannot touch your real database — set `XANA_DATA_DIR`.

## The gate: `npm run check`

`npm run check` is the definition of "this works". It runs the encoder check,
the TypeScript compiler, about twenty verification scripts, the demo, the route
smoke test, and the design and palette contracts. A change that does not pass
it is not finished, and "it passes on my machine" is not a substitute for
running it.

Two suites need something extra:

- `npm run verify:calendar-browser` drives a real Chromium over the DevTools
  protocol — drags, drops, touch. It needs a browser it can start
  (`--port 9222`, or `XANA_CDP_PORT`). In a sandbox that denies the browser's
  own transport it says so in one line and exits 0 rather than pretending it
  verified something. It writes screenshots into `data/shots/`.
- `npm run check:design` and `npm run check:bundle` inspect a **running**
  server, so start `npm run dev` first.

`npm run check:secrets` is the guard against publishing anything private. See
[SECURITY.md](SECURITY.md).

## The design contract

[DESIGN.md](DESIGN.md) is normative, not descriptive. It records the type
floor, the accent ramp, the ownership rules for shared classes, and the laws
the interface is held to — including three added by the calendar work: a
gesture ends exactly once and says how, nothing is drawn before a gesture is
armed, and a control's size comes from the space it actually has.

`check:design` enforces what can be enforced mechanically. A literal colour in
a `.tsx` file, a type below the floor, or a utility that overrides a property
its shared class owns will fail the build. If a change to the interface makes
DESIGN.md wrong, the same commit updates DESIGN.md. A rule that is quietly no
longer true is worse than no rule, because the next person trusts it.

## How the code is written here

- **Comments say why, not what.** The code says what it does. A comment earns
  its place by recording the thing that is not visible in the code: the bug
  that caused this shape, the alternative that was rejected, the reason the
  obvious version is wrong. `MEMORY.md` is where the long version of those
  arguments lives.
- **A guard must not fail on its own source.** Both `check-encoding.mjs` and
  `check-no-secrets.mjs` search for patterns they themselves contain, and both
  build the pattern so the literal in the file cannot match it.
- **A deliberate exception is marked, not excluded.** If a line legitimately
  contains something a check would flag, put `xana-encoding-ok` or
  `xana-secret-ok` on that line. It is auditable by reading the line; a
  whole-file exclusion is not. A real leak will not have been marked by anyone.
- **Prefer a measurement to an assumption.** The scripts in `scripts/` exist
  because "it looks right" and "it is right" are different claims, and several
  of them print the number they measured next to the assertion.

## Reporting a bug

Include what you did, what you expected, and what happened — and if the answer
is in a screenshot, say what the screenshot shows rather than only attaching
it. If you can reproduce it in a script, that is the most useful form a bug
report can take here, and it is usually most of the fix.

Security problems do not go in the issue tracker: see [SECURITY.md](SECURITY.md).
