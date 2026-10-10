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

When the local engine matches nothing, she gets a second chance that is still
under that rule. With a key configured, she is offered a **closed catalog of
typed operations** — read your list, read your goals, plan a goal into dated
milestones, add a task — and may pick one. She cannot compose a new operation,
cannot run a query, cannot fetch a page, and cannot name a record by its id; a
name that matches nothing is a refusal rather than a guess. Every proposal passes
one validator and lands through the one write path, behind an audit row and an
idempotency key. So the set of things she can *do* is still a set a human wrote
down — what the model got is a vote on which member applies, and a real ability
to hold a conversation. See [docs/WHY-THIS-WAY.md](docs/WHY-THIS-WAY.md) for what
that deliberately rules out, including why there is no web-fetch tool.

## What she is for

- **Capture without ceremony.** "Remind me to call Mum Friday" becomes a task with
  a date. So does a note, a mood, a meal, a habit, a goal.
- **A day you can see.** A briefing on wake: what is next, what is overdue, where
  the energy is, which window is good for real work.
- **Talk, as well as tasks.** Tell her you are worn out, or that you are weighing
  a decision, and she answers as a conversation — with your actual numbers in
  hand rather than a status readout. She was previously only able to answer
  things the intent parser recognised; that ceiling is gone.
- **Plans with dates on them.** "I want to be fit this year" becomes proposed
  milestones, worked backwards from the date you named, for you to accept or
  change. She proposes the structure; she never grades your progress — that stays
  derived from what you actually tick off.
- **A calendar you can use.** Month, week and day over the same entries, with drag
  to move, drag to resize, draw to add, and a form on a tap.
- **Memory that persists.** Recall across sessions, lexical and semantic, with a
  local embedder and no service behind it. With a key configured she also
  *learns*: a durable fact stated in conversation — a preference, a person, a
  deadline that matters later — is stored once, rephrasings included, and praise
  is refused in both directions so the memory cannot drift toward flattery.
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

**The scheduled pass exists, and you own the schedule.** Reflections are still
generated only when asked for. What now exists is the whole path for her to speak
first:

- `src/lib/derived/proactive.ts` decides *whether* an interruption is worth
  making — relevance weighed against cost (Horvitz's expected-value rule), with
  quiet hours, a daily budget, suppression during a meeting or a focus session,
  and a recorded reason for every verdict including the suppressions.
- `src/lib/derived/checkin.ts` is the pass: it gathers what the rest of the app
  already measured, scores it, spends the budget, and **records what it said** so
  the same overdue task is never announced twice and the budget survives a
  restart.
- `scripts/schedule.ts` runs it. Point Task Scheduler, cron or a systemd timer at
  it — `npm run schedule`, or `npm run schedule:dry` to see what she would say
  without recording anything. It exits 0 when she has nothing to say, because a
  quiet assistant is a working assistant and a job that alerts on silence gets
  muted on day two.
- `GET /api/schedule` is the read-only view of the same decision, for the
  interface and for working out why she is quiet.

It is deliberately *not* a timer inside the app: a timer there does not survive a
reload, wakes in parallel with request handlers against a single SQLite writer,
and makes "why did she say that at 3am" unanswerable.

What is still missing is the `ignored` signal — a suggestion shown and never
acted on — which is the only feedback that would let the budget tune itself.
Until that exists the budget is fixed and conservative on purpose, because an
authority that has to interrupt before it can learn when to interrupt is one that
interrupts too much.

**The memory embedder is deliberately simple** — feature hashing over unigrams,
bigrams and character trigrams. It is not a transformer, and `MemoryStore` accepts
any `Embedder`, so a local model is close to a one-line swap. Nobody has written
one.

The channel *around* it changed, and that is where the measured gain came from.
Recall now fuses that dense channel with **BM25 through SQLite FTS5** by
reciprocal rank fusion (`src/lib/derived/recall.ts`), so the lexical half is a
real ranking function rather than a Jaccard fraction added to a cosine, and the
combination consumes ranks — which sidesteps the bug the old scorer had, where
four numbers on four different scales were weighted as though the weights meant
something. Recency is per memory *kind* and measured from when a memory was last
**used** rather than when it was written: the old flat 45-day half-life from
`created_at` scored an eight-month-old stated preference at about 0.002, which is
indistinguishable from noise, so a passing mention from yesterday could outrank a
preference the user had actually told her. And `embedding_model` now records which
embedder wrote each vector, so a future swap can find the rows that need
re-embedding instead of silently comparing vectors from two different models.

**Still not a transformer, and that ceiling is real.** A local
sentence-transformer (`bge-small-en-v1.5` or `gte-small`; both are 384-dim, so the
stored BLOBs stay valid and no migration is needed) is the next step, and it is
opt-in work nobody has done. The research pass flagged that the published MTEB
comparisons are version-dependent and vendors quote whichever flatters them, so
the model should be chosen by measuring on this user's own memory rather than
from a leaderboard.

**The setup assumes Windows.** The local transcriber is installed by PowerShell
(`python/setup.ps1`, `python/serve.ps1`) and there are no macOS or Linux
instructions. The app itself is Node and SQLite and should not care.

**The gate is not the whole gate in CI.** The workflow runs the three checks that
need no install and no server — encoding, secrets, palette — plus a refusal to
track `data/` or `.env`. The full chain is not there because it compiles a native
module and two of its suites want a running server. Closing that gap is a real
piece of work, not a config line.

**A trap that wrote real settings — half fixed, and the other half found by
walking into it.** `scripts/verify-providers.mjs` read `XANA_BASE_URL` rather than
`XANA_URL`, so running the gate against a throwaway server still talked to the one
on 4310 and wrote your `data/settings.json` (it restored what it found, but it
should not have touched it). It reads `XANA_URL` now. The remaining half was
worse, and only surfaced because this machine has an unrelated program holding
4310: the reachability probe accepted *any* HTTP response, so that program's
output went straight into `JSON.parse` and the suite died with a `SyntaxError`
from inside undici instead of saying something useful. It now checks the response
looks like Xana before touching anything, and prints the skip with the fix.

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
