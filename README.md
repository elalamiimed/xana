# Xana

Xana is a personal assistant that runs on your own machine and keeps your life in
a file you own. She is a calm presence rather than a chatbot: dark, quiet, aware
of the shape of your day, and useful with **no API key and nothing switched on**.

She exists because the interesting half of an assistant is not the model. It is
the part that decides what she does — and here that part is local, deterministic
and inspectable. `think()` resolves intent on this machine, always, before any
model is consulted; a model may phrase the answer, and can never invent an action
that lands in your database. Everything that needs the network is a plugin that
asks permission first, and a source that has not been allowed says so rather than
pretending.

## What she is for

- **Capture without ceremony.** "Remind me to call Mum Friday" becomes a task with
  a date. So does a note, a mood, a meal, a habit, a goal.
- **A day you can see.** A briefing on wake: what is next, what is overdue, where
  the energy is, which window is good for real work.
- **A calendar you can use.** Month, week and day over the same entries, with drag
  to move, drag to resize, draw to add, and a form on a tap.
- **Memory that persists.** Recall across sessions, with a local embedder and no
  service behind it.
- **Connections that ask.** Calendar feeds, weather, health export, tasks, mail,
  markets — each one a descriptor with a capability, off until you grant it.

Everything lives in `data/` as SQLite and JSON, and nothing about you is in this
repository.

## Running her

```bash
npm install
npm run seed      # build a plausible life, so there is something to look at
npm run dev       # prints the URL it started on
```

Node 20.9 or newer. `npm run seed -- --reset` rebuilds the demo life from empty.
Open the URL, press **Settings** (or `Ctrl+,`) to pick a theme or paste a key —
none of it is required.

`npm run check` is the project's definition of "this works": the encoder and
secret guards, the compiler, about twenty verification suites, the design
contract and the palette. Start there before you start changing things.

## What is missing

This is the honest list, and it is the list to pick from. Each item says how it is
known, because a gap that has been measured is work and a gap that has been
assumed is a guess.

**Never verified in a real browser.** `npm run verify:browser` has still never run
anywhere — it is the one check written for an environment that could not execute
it. What it covers is therefore unproven: that the client bundle hydrates, that
the orb canvas actually paints and animates, that Settings opens on a real click
and recolours the document, and that nothing overflows at 390px. Running it once
on a normal machine closes it.

**Connections that have never touched the real service.** The Google Calendar
connect flow has never seen a real consent screen or a real refresh token — the
PKCE vector, the authorization URL, `state` mismatch, expiry, the token exchange
and refresh preservation are all tested against stubs. Crypto and Markets have
never returned a live price; both are verified against the documented response
shape through a stubbed `fetch`. Treat the first real call as the test.

**The calendar's rough edges.** The month view is pointer-only: no roving
`tabindex`, no arrow keys, and crossing the room was measured at fifty-two tab
stops — the time grid's blocks already take arrow keys, so the pattern to copy
exists. Degenerate cases are undrawn: a fifteen-minute entry, a block touching a
day boundary, more entries than a cell can hold. And a fresh install shows an
empty grid with nothing to explain it.

**Nothing runs on a schedule.** Reflections are generated only when asked for.
There is no scheduler, no nightly pass, no "yesterday in review" that arrives on
its own.

**The memory embedder is deliberately simple** — feature hashing over unigrams,
bigrams and character trigrams, blended with lexical overlap, salience and
recency. It is not a transformer. `MemoryStore` accepts any `Embedder`, so an
API-backed or local-model embedder is close to a one-line swap, and nobody has
written one.

**The setup assumes Windows.** The local transcriber is installed by PowerShell
(`python/setup.ps1`, `python/serve.ps1`) and there are no macOS or Linux
instructions. The app itself is Node and SQLite and should not care.

**The gate is not the whole gate in CI.** The workflow runs the three checks that
need no install and no server — encoding, secrets, palette — plus a refusal to
track `data/` or `.env`. The full chain is not there because it compiles a native
module and two of its suites want a running server. Closing that gap is a real
piece of work, not a config line.

**A trap that wrote real settings.** `scripts/verify-providers.mjs` reads
`XANA_URL`, not `XANA_BASE_URL`, so running the gate against a throwaway server
still talks to the one on 4310 and writes your `data/settings.json` (it restores
what it finds, but it should not touch it at all). One line, and it bit this
project during its own release.

**Untested by anyone, including the author.** A real finger on a real
touchscreen, compositor touch scrolling, a screen reader, 200% text scaling, and
landscape phones under 400px tall. The synthesised finger in the browser suite is
not the same thing as your thumb.

## Working on it

[CONTRIBUTING.md](CONTRIBUTING.md) has the detail. The short version:

- **`npm run check` is the gate.** A change that does not pass it is not finished.
- **[DESIGN.md](DESIGN.md) is normative, not descriptive.** If a change makes it
  wrong, the same commit updates it.
- **Comments say why, not what.** The code says what it does; a comment earns its
  place with the bug that caused the shape or the alternative that was rejected.
- **Prefer a measurement to an assumption.** Several suites print the number they
  measured next to the assertion. That habit is the point.

[SECURITY.md](SECURITY.md) says where a vulnerability report goes, and which of
the things that look like one are decisions instead.

**[docs/REFERENCE.md](docs/REFERENCE.md)** is the long-form documentation:
architecture, every setting, the API, the voice path, the backup and restore
rules, and the full list of stated limitations. It is where the depth lives, and
it is not where to start.

## Licence

Xana is **source-available, not open source** — see [LICENSE](LICENSE). You may
read it, run it, change it and share it for any noncommercial purpose. Commercial
use needs a separate licence from the copyright holder, and the `Required Notice:`
line has to travel with every copy, so nobody can pass this work off as their own.
The Open Source Initiative's definition requires that commercial use be allowed,
which is why this licence cannot be called open source; the source being public
and the licence being permissive are two different claims, and this project makes
only the first. Commercial licensing is a conversation, not a closed door.
