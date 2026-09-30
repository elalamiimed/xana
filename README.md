# Xana

A minimalist, Jarvis-inspired personal AI assistant. She is a calm, intelligent
presence rather than a chatbot: dark, quiet, and always aware of the shape of
your day. She thinks, remembers, and acts.

She runs with **zero API keys**, and with **nothing switched on**. Every
integration is a plugin that asks permission before it does anything: a source
that has not been allowed reports itself as `waiting for permission` rather than
pretending, and everything that needs no network — tasks, reminders, habits,
goals, memory, the briefing — works out of the box.

```bash
npm install
npm run seed      # build a plausible life so there is something to look at
npm run dev       # prints the URL it started on
```

Then open the URL and press **Settings** (or `Ctrl+,`) to choose a theme, paste
an API key, or open **Plugins** and allow a connection. Nothing in there is
required.

`npm run dev` does **not** shell out to `next dev`. It starts the Next server
programmatically from `scripts/dev.mjs`, which matters in two situations:

- **Sandboxes that deny process creation.** `next dev` is a thin supervisor that
  `child_process.fork()`s the real server; that fork fails with `EPERM` in a
  restricted environment even though nothing is wrong with the app.
- **A port that is already taken.** If something else owns 4310, Xana says so
  and starts on the next free port instead of dying with `EADDRINUSE`. If the
  port is already serving Xana, it tells you the URL and exits.

Because that path bypasses the CLI, the `.env` file watcher that `next dev`
normally provides is gone — so `dev.mjs` wires it back up itself. Editing
`.env.local` while the server runs reloads it. `npm run dev:next` remains
available as the stock CLI, for a normal machine.

---

## What she actually does

**Life management.** A daily briefing on wake — calendar, weather, energy,
priorities. Natural-language capture ("remind me to call Mom Friday"). Calendar,
reminders, routines and habit streaks in one store rather than four silos.
Proactive nudges ranked by what changes the day.

Everything local works with nothing granted. Weather and market quotes need a
click first: they are the only two built-ins that cannot answer honestly without
leaving the machine, and Open-Meteo would otherwise geolocate you by IP on the
first page load.

**Goals.** Short, mid and long horizons with milestones. Weekly and monthly
reflections she writes herself. Progress as thin rings, never charts.

**The brain.** A persistent external memory in SQLite with vector recall. She
remembers conversations, decisions, preferences, and the people, places and
projects that recur — and she surfaces them unprompted when they are relevant.

**Behavioural pattern detection.** The part that makes her feel like she
notices things:

> You're most consistent with deep work on Tuesdays — 24h across 15 sessions,
> 67% of your focused time.

> Nights under 6.5h cost you roughly 2.1 points of mood the next day.

Every claim carries its evidence, and every detector stays silent until it has
enough data to be worth saying.

**A voice you can change.** Pick from six palettes or dial in your own two
accent colours — the whole interface re-derives itself from them, including the
orb. Adjust how fast anything moves. Have her read replies aloud, with a voice
from your own system. Every one of those is a control, not a config file.

---

## Architecture

```
  plugins ──┐
            ├─► LifeState ─► /xana/context ─► mind ─► UI cards
  derived  ─┤                     ▲
  memory   ─┘                     │
                            actions (write-back) ─► remote mirror
```

| Layer | Location | Responsibility |
|---|---|---|
| **Core** | `src/lib/core/` | Domain types, SQLite store + vector recall, local embedder, time helpers, NL time parsing |
| **Plugins** | `src/lib/plugins/` | One descriptor per feature, the capability gate, and the Google Calendar OAuth client |
| **Adapters** | `src/lib/adapters/` | One file per life-data source. Never throw; report mode honestly; told what they may do |
| **Derived** | `src/lib/derived/` | Energy forecast, goal pace, habit health, pattern detection, nudges, reflections, memory ingestion |
| **Context** | `src/lib/context/gateway.ts` | The unified `/xana/context` gateway — one "life state" object |
| **Actions** | `src/lib/actions/` | Every write-back in one place, and the remote mirror that repeats a local write elsewhere |
| **Settings** | `src/lib/settings/` | The typed settings store, theme presets, and the one function that turns client input into stored state |
| **Mind** | `src/lib/mind/` | LLM client, local deterministic intent engine, prompt construction |
| **UI** | `src/app/`, `src/components/xana/` | The orb, its 3D renderer, the composer, peripheral cards, the settings surface |

### Plugins and permission

Every life-data source is a **plugin** with a descriptor that declares what it
needs. Nothing it wants to do happens until the matching capability has been
granted in **Settings → Plugins**, and the grant is a value in the settings file
you can read and revoke.

```ts
{
  id: "weather",
  needs: [
    { kind: "net.read", reason: "Look up the forecast.",
      hosts: ["api.open-meteo.com", "geocoding-api.open-meteo.com", "ipapi.co"] },
    { kind: "location", reason: "Use the coordinates you set, or guess them from your IP." },
  ],
  config: [{ key: "weather.latitude", label: "Latitude", … }],
}
```

The rule the whole thing rests on:

> **A plugin with an ungranted capability is never called.** Not "is called and
> checks", not "is called in a limited mode" — never called.

The check lives in one function (`runPlugin` in `lib/plugins/automation.ts`), in
front of the adapter. A blocked plugin has no adapter instance, so there is no
function to call by accident. When a capability is revoked, the assembled life
state and every adapter's cache are dropped together, so the data does not
linger for a TTL after you withdraw access.

Three things follow from that, and they are the whole design:

- **Consent and configuration are different questions.** An ungranted plugin
  reads `blocked`; a granted plugin with no URL yet reads `local` and says what
  is missing. Neither looks like the other, and neither looks like a fault.
- **Her own store is not a permission boundary.** Tasks, her own events, habits,
  energy readings and memories live in `data/xana.db`, which she wrote. Those
  plugins are `core` and always run — a fresh install has a working assistant,
  not an empty one waiting on a permissions screen. The boot contract refuses
  `core: true` on any descriptor whose *required* capabilities leave the
  machine, so the flag cannot become an escape hatch.
- **Adapters are told, not asked.** The plugin layer computes a `PluginGates`
  (`{network, remote, localWrite}`) and hands it to the adapter factory. An
  adapter never reads the permission store; when `network` is false the network
  branch is not entered and no request object is built.

`GET /api/plugins` returns every plugin with its capabilities, its reasons, and
what it last managed to read. `POST /api/plugins` grants, revokes, connects and
disconnects. `PUT /api/plugins/settings` writes a plugin's own fields. All three
are also served under `/xana/plugins`.

### The two-engine mind

`think()` picks between two engines, and the split is deliberate:

- **The LLM shapes what she says. The local engine decides what she does.**
  Intent resolution always runs locally first, so a model can never invent a
  calendar entry. A write-back behaves identically whichever engine is warm.
- **No key, no problem.** Without a key the local engine handles capture,
  scheduling, completion, logging, recall, briefings and reflections, and
  replies in her voice.
- **Opt in explicitly.** A key in your environment is not enough — the model has
  to be switched on in Settings too. Someone with `OPENAI_API_KEY` exported for
  another tool has not thereby agreed to Xana spending it.
- **Fallback, not failure.** If the model times out mid-turn she answers
  locally rather than erroring.

### The live state

Everything reads through one cached assembly. `/api/state` serves the cheap
ambient poll from the last-known state; `/xana/context` and `/api/context`
force a real read. A write-back invalidates **both** the gateway cache and every
adapter's cached slice — otherwise the UI would contradict what she just said.
A settings write invalidates both too, so a new token or feed URL takes effect
on the next request rather than on the next restart.

---

## The orb

The orb is a hand-written 3D renderer on a 2D canvas (`src/components/xana/orb/`).
Not CSS `rotate3d`, and not three.js: a few hundred points on a real sphere,
orbit rings sampled as tilted circles, and ripples expanding in the orb's own
equatorial plane — all rotated, perspective-projected, and drawn with size and
alpha derived from each vertex's depth every frame.

Two reasons for hand-rolling it. The obvious one is size: three.js would add
~600 KB to a local-first assistant that must work with no network and no build
step, to draw one object. The subtler one is that the orb is the interface. Its
easing *is* the personality — the half-lives that make it lean toward your
cursor rather than mirror it, the mismatched drift periods that keep the sway
from settling into a loop, the tint that crossfades slowest of all so a change
of activity reads as a mood rather than a colour switch. That is easier to get
right with the maths in front of you than through an engine's abstractions.

It reacts: move the pointer and it leans; drag it and it spins with inertia;
each reply sends a wave out from the core. Reduced motion stops the loop
entirely and draws one still, fully-rendered frame instead — an object that
rotates forever is exactly what someone asking for less motion asked not to
have.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/state` | Ambient poll: presence, headline, energy, attention count |
| `GET` | `/xana/context` | The unified life-state gateway (canonical) |
| `GET` | `/api/context` | Alias of the above, for the UI's `/api` prefix |
| `POST` | `/api/chat` | `{ message, sessionId?, modality? }` → `{ message, lifeState }` |
| `POST` | `/api/action` | `{ action: ActionIntent }` → `{ outcome }` |
| `GET` | `/xana/settings` | Current settings, every secret masked (canonical) |
| `GET` | `/api/settings` | Alias of the above |
| `PUT` | `/api/settings` | Merge a settings patch. `{ testModel: true }` probes without saving |
| `GET` | `/xana/plugins` | Every plugin: capabilities, reasons, settings presence, last read (canonical) |
| `GET` | `/api/plugins` | Alias of the above |
| `POST` | `/api/plugins` | `{ id, action }` — `grant`, `revoke`, `connect`, `disconnect` |
| `PUT` | `/api/plugins/settings` | `{ values }` — one plugin's own fields, then rebuild its adapter |
| `GET` | `/api/plugins/google/callback` | Where Google returns the browser. Exchanges the code, checks `state` |
| `GET` | `/xana/cave` | My cave: the goal board with computed pace, and a page of memories |
| `POST` | `/xana/cave` | `{ op, ...args }` — one of fourteen fixed goal and memory operations |

---

## My cave

A room for the two things worth editing directly rather than talking about: your
goals, and what she remembers. Reachable from **My cave** in the header.

**The goal board.** Three columns — working on, set aside, done — and you drag
cards between them. Each card holds its own editing: title, the reason it
matters, a horizon, a deadline, milestones you tick off, and a **moved today**
button for the goals that have no steps to tick. A goal with no milestones has
nothing to complete, so without that button its "last movement" would always be
the day you wrote it down and it would be marked stalled forever.

Drag writes a single float, not a renumbering: dropping between two cards stores
the midpoint of their positions, so a move is one row. Cards you have never
dragged are backfilled with an explicit position on first boot, so adding a goal
does not drop it below ones written before the feature existed.

**The memory room.** Everything she has learned, with three controls that answer
the three questions a user actually has:

- **Pin** — *this matters, don't let it fade.* Pinned entries skip the relevance
  cutoff entirely. A pin is a guarantee, not a nudge to the ranking.
- **Edit** — *this is nearly right.* The embedding is rebuilt on save, so the
  corrected wording is what recall searches, not the words you removed.
- **Forget** — *this should not be known.* A hard delete, twice confirmed. A
  soft delete would leave it reachable by a later high-scoring recall, which is
  not what forgetting means.

You can also write a memory by hand, marked as yours so it outranks what she
infers from conversation.

**What she does with it.** Recalled memories and standing facts are presented to
the model separately, because they mean different things: a match is relevant to
the question, a pin is background that may be entirely unrelated. Merging them
into one list invites an answer about your budget that mentions where the spare
key is.


Types for all of them live in `src/lib/api/contract.ts` and
`src/lib/settings/types.ts`; the UI imports them, so the contract cannot drift
from the implementation.

---

## Configuration

**Settings first.** Everything below can be set from **Settings → Plugins**,
which writes `data/settings.json`. Environment variables still work, and are the
right answer for a container or a shared machine — but a value set in the UI wins
over one from the environment.

The old flat `XANA_*` names still resolve, so an exported variable keeps working.
They are listed under **Settings → Connections** purely so an older value can be
cleared; new configuration belongs in the plugin that owns it.

| Variable | Effect when set |
|---|---|
| `XANA_LLM_API_KEY` | Enables the generative voice |
| `XANA_LLM_BASE_URL` / `_MODEL` / `_PROVIDER` | Any OpenAI-compatible endpoint (OpenAI, DeepSeek, Groq, OpenRouter, Ollama, llama.cpp) or Anthropic |
| `XANA_CALENDAR_ICS_URLS` | Live calendar from any published ICS feed (Google, Outlook, Fastmail). Comma-separated. Superseded by `calendar.icsUrls` |
| `XANA_TODOIST_TOKEN` | Merges Todoist tasks with the local list. Superseded by `tasks.token` |
| `XANA_OBSIDIAN_VAULT` | Reads a Markdown vault, stripping syntax before embedding. Superseded by `notes.vault` |
| `XANA_HEALTH_DIR` | Imports Apple Health / Google Fit JSON exports. Superseded by `health.folder` |
| `XANA_NOWPLAYING_URL` / `_FILE` | Now-playing from any local bridge. Superseded by `media.url` / `media.file` |
| `XANA_MAIL_URL` / `_FILE` | Ambient mail signals as JSON. Superseded by `mail.url` / `mail.file` |
| `XANA_FINANCE_SYMBOLS` | Quote symbols (default: `^spx,^ndq,eurusd,gbpusd`). Superseded by `markets.symbols` |
| `XANA_LAT` / `XANA_LON` / `XANA_LOCATION_LABEL` | Pins the weather location. Superseded by `weather.latitude` / `weather.longitude` / `weather.place` |
| `XANA_DATA_DIR` | Moves both the database and the settings file |

Environment variables do **not** grant permission. A token in your shell and an
ungranted `net.read` means the token is read and nothing is fetched — the
capability is stored in the settings file only, precisely so that reaching into
your environment is not a way to widen what Xana may do.

### Google Calendar

Two ways in, and they are not equivalent.

**An ICS feed** (the `calendar` plugin) is the right choice for reading. Google,
Outlook and Fastmail all publish a private address under their calendar
settings; paste it, allow `net.read`, and today's schedule appears. No OAuth app,
no client secret, no token custody.

**The `google-calendar` plugin** is for writing, and for a grant you can revoke
from Google's side as well as Xana's. It creates events in your real calendar
when you allow `remote.write`.

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   create a project and **enable the Google Calendar API**.
2. Configure the OAuth consent screen. Add yourself as a test user if the app is
   in Testing.
3. Create a credential. **Desktop app** is simplest — it has no client secret and
   the flow below is built for it. A **Web application** client works too; add
   `http://127.0.0.1:4310/api/plugins/google/callback` as an authorized redirect
   URI and paste the client secret as well.
4. Paste the client ID in **Settings → Plugins → Google Calendar**, press
   **Allow**, then **Connect**. A browser tab opens at Google; approving it
   redirects back to this machine and the tab closes itself.

Scopes are `calendar.readonly`, plus `calendar.events` if you allowed
`remote.write` — not full `calendar`, which would also grant control of sharing
and deletion. `access_type=offline` and `prompt=consent` are both sent, because
Google only issues a refresh token on the first consent for a client and would
otherwise hand back an access token that dies an hour later with no explanation.
Disconnecting revokes the token at Google and clears it locally.

**Where your key goes.** `data/settings.json`, written atomically and `0600`
where the platform supports it. It is never sent back to the browser: the
settings API returns a mask and a presence flag, and the UI sends a sentinel
meaning "leave the stored key alone" whenever you did not retype the field. The
write is one-way by design. Plugin secrets are the same — the plugins API reports
presence, never a value, not even masked.

---

## Verifying it

```bash
npm run check              # typecheck + demo + route smoke + orb maths
npm run verify:web         # with the server running: the real HTTP surface
npm run verify:browser     # with the server running: a real browser
```

- `npm run typecheck` — `tsc --noEmit`, strict, no `any`, no `@ts-ignore`.
- `npm run demo` — drives the real stack end to end on a throwaway database:
  time parsing, capture, scheduling, recall, habits, goals, reflection,
  briefing, and what she says when she does not understand.
- `npm run smoke` — calls the actual `route.ts` handler modules and checks the
  payloads, status codes and write-back visibility for every endpoint. Runs
  against a scratch database, so it never touches your real life.
- `npm run verify:orb` — the orb's scene and maths on the same TypeScript the
  canvas imports: sphere density, determinism, the presence table, the breath,
  projection, rotation, and frame-rate-independent easing.
- `npm run verify:plugins` — the permission gate, on a scratch database with
  `XANA_DATA_DIR` pointed at a temp directory. The assertions that matter are the
  negative ones: with nothing granted, a `globalThis.fetch` stub counts **zero**
  calls while every plugin is configured and every setting is filled in; with an
  ICS URL saved and `net.read` refused, still zero; and after a revoke, the
  adapter is rebuilt with `gates().network === false` rather than finishing the
  fetch it was already warm for. Plus the PKCE S256 test vector, the
  refresh-token preservation Google's repeat-consent behaviour depends on, and
  that the boot contract actually throws on a descriptor it should reject.
- `npm run verify:web` — the served application: rendered page, inlined theme
  tokens, the stylesheet as it comes through Tailwind, every endpoint, a live
  chat turn, and a settings round trip that changes the theme, proves the next
  page load renders it, and changes it back.
- `npm run verify:browser` — launches headless Edge or Chrome and checks the
  things bytes cannot: that the client bundle hydrated, that the orb canvas is
  *actually painting* (it reads the pixels back), that it is animating between
  two frames, that the settings panel opens on a real click and recolours the
  document, and that nothing overflows at 390px wide. Screenshots land in
  `data/shots/`.
- `scripts/serve.ts` — serves those same handlers over real HTTP when Next's
  worker pool is unavailable. Unlike `smoke`, it uses the **real** database, so
  writes are real; it says so on boot.

Scripts run the TypeScript sources directly under Node 24's native type
stripping, with a small resolve hook for extension-less imports
(`scripts/ts-resolve.mjs`). No build step, and no `tsx` — which would spawn an
esbuild service subprocess.

---

## Design

`DESIGN.md` is the contract for anything visual: palette, type scale, motion
tokens, the orb, layout, voice rules, and the anti-patterns not to ship. Tokens
are defined once in `src/app/globals.css` and never hardcoded elsewhere.

The one structural rule worth stating outright: **accents are stored as raw sRGB
channels** (`--accent-rgb: 111 227 227`), never as a finished colour. Every shade
in the system is composed with `rgb(var(--accent-rgb) / <alpha>)`, so the entire
ramp — borders, washes, glows, gradients, shadows — re-derives itself from three
numbers. That is what makes a theme picker possible without a component
knowing it exists.

Two more:

- **Accent colour occupies well under 5% of the screen.** It marks presence and
  state; it never decorates.
- **`prefers-reduced-motion: reduce` kills the breath, the rotation, the ripple
  and the stagger,** keeping opacity transitions so states still read without
  movement. This is not optional, and the canvas honours it too.

She speaks in short, precise, warm sentences. No filler, no exclamation marks,
no emoji, no "As an AI". When she does not understand something she says so and
offers what she can do — a wrong calendar entry is worse than an honest "I
didn't follow that."

---

## Notes and limitations

- **Data lives in `data/`** — `xana.db` and `settings.json`, both gitignored.
  Delete them and she rebuilds from empty. `npm run seed -- --reset` rebuilds
  deliberately.
- **The memory embedder is local and dependency-free** — a feature-hashing
  model over unigrams, bigrams and character trigrams, blended with lexical
  overlap, salience and recency. It is not a transformer, but for a single
  user's memory it is genuinely useful, and `MemoryStore` accepts any
  `Embedder`, so an API-backed model is a one-line swap.
- **`npm run dev` works everywhere; `next build` does not, in a restricted
  sandbox.** Serving is solved (see above — no fork). `next build` still forks
  workers for its page-data phase, which a process-denying sandbox blocks even
  though compilation itself succeeds. On a normal machine `npm run build` and
  `npm start` work as usual, and `npm run smoke` / `scripts/serve.ts` cover the
  routes when the build cannot.
- **`npm run verify:browser` cannot run in a sandbox that denies process
  creation.** Chromium is a multi-process application built on named pipes; if
  either is blocked it exits on launch, and the script reports that as a skip
  with the reason rather than as a failure. It is the only check here that has
  not been executed in the environment it was written in, so treat it as
  unverified until it passes once on your machine.
- **Reflections are generated on demand**, not on a scheduler — ask for one, or
  the `reflect` action produces it. They are deterministic and local, so they
  read the same every time.
- **The Google Calendar connect flow has not been completed against Google from
  this machine.** Everything around it is tested: the PKCE verifier against the
  RFC 7636 vector, the authorization URL's parameters, `state` mismatch and
  expiry, the token exchange with a stubbed endpoint, refresh-token preservation,
  and that a refused `remote.write` stops the write. What has not happened is a
  real consent screen and a real refresh token, because the sandbox this was
  built in has no browser. Treat the first connect as the test.
- **Permissions are not access control.** There is one user, the server listens
  on loopback, and anything that can reach these routes could read the SQLite
  file directly. A capability describes what Xana is permitted to send off this
  machine and what she is permitted to change. Claiming more than that would be
  security theatre, and the settings file is readable by anyone who can read the
  directory.

