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
an API key, or open **Connections** and allow one. Nothing in there is required.

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

Everything local works with nothing granted. Weather and quotes — markets and
crypto — need a click first: they are the built-ins whose answer has to come from
off the machine, and Open-Meteo would otherwise geolocate you by IP on the first
page load. A vault folder, a health export directory, a now-playing file and a
mail bridge are asked for too, because they are files outside Xana's own
database. So is a phone that posts a day of health readings: the token you paste
into it is the whole of that permission, and there is no capability to grant.

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
| **Plugins** | `src/lib/plugins/` | One descriptor per connection, the capability gate, the grouping vocabulary, and the Google Calendar OAuth client |
| **Adapters** | `src/lib/adapters/` | One file per life-data source. Never throw; report mode honestly; told what they may do |
| **Derived** | `src/lib/derived/` | Energy forecast, goal pace, habit health, pattern detection, nudges, reflections, memory ingestion |
| **Context** | `src/lib/context/gateway.ts` | The unified `/xana/context` gateway — one "life state" object |
| **Actions** | `src/lib/actions/` | Every write-back in one place, and the remote mirror that repeats a local write elsewhere |
| **Settings** | `src/lib/settings/` | The typed settings store, theme presets, and the one function that turns client input into stored state |
| **Mind** | `src/lib/mind/` | LLM client, local deterministic intent engine, prompt construction |
| **UI** | `src/app/`, `src/components/xana/` | The orb, its 3D renderer, the composer, peripheral cards, the settings surface |

### Connections and permission

Every life-data source is a **connection** with a descriptor that declares what it
needs. Nothing it wants to do happens until the matching capability has been
granted in **Settings → Connections**, and the grant is a value in the settings
file you can read and revoke.

The code still says *plugin* where it means the mechanism rather than the screen:
`src/lib/plugins/` holds the descriptors, and `runPlugin` is the gate. That is the
one word the rename left alone, and it is why the file paths below still read
`plugins` while nothing in the interface does.

One list, grouped by what it takes to connect, because that is the question
someone opening the screen actually has:

- **Your data** — an ICS feed, her own calendar, a notes folder, a health export,
  Google Calendar. Things you already have; most need no key.
- **Services** — weather, Todoist, markets, crypto. Reached over the internet.
- **Devices** — now playing, mail. Something you run or carry that reports to her
  on your own network.
- **Bundled** — what is part of Xana rather than a subscription, so there is
  nothing to connect and nothing to pay.

The health connection carries a second door that is not a capability at all: a
device-token POST endpoint for a phone, described under
[Phone health](#phone-health).

```ts
{
  id: "weather",
  kind: "service",     // which group the card sits in: source | service | device | library
  needs: [
    { kind: "net.read", reason: "Look up the forecast, and geocode a place name.",
      hosts: ["api.open-meteo.com", "geocoding-api.open-meteo.com", "ipwho.is", "freeipapi.com"] },
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
function to call by accident. Revoking drops the assembled state, every adapter
cache, and the built adapter together, so data cannot linger for a TTL after you
withdraw access.

Three things follow, and they are the whole design:

- **Consent and configuration are different questions.** An ungranted plugin
  reads `blocked`; a granted plugin with no URL yet reads `local` and says what
  is missing. Neither looks like the other, and neither looks like a fault.
- **Her own store is not a permission boundary.** Tasks, her own events, habits,
  energy readings and memories live in `data/xana.db`, which she wrote. Two
  plugins are `core` and always run — the local task list, and her own calendar —
  so a fresh install is a working assistant rather than an empty one waiting on
  a permissions screen. A core plugin's `needs` list must be **empty**, and the
  boot contract enforces it.
- **Adapters are told, not asked.** The plugin layer computes a `PluginGates`
  (`{network, remote, localWrite}`) and hands it to the adapter factory. An
  adapter never reads the permission store; when `network` is false the network
  branch is not entered and no request object is built.

**Why `core` needs that rule.** `core` skips the gate, so a capability declared
in a core plugin's `needs` would be decorative — never checked, never reported,
never revocable. The first version of the flag allowed exactly that, and the
result was six plugins reading arbitrary user-named folders — a Markdown vault, a
health export directory, any file for now-playing and mail — on a fresh install
with nothing granted. The capability was named in the descriptor, shown in no UI,
and enforced nowhere. A plugin that touches anything outside `xana.db` is not
core.

**A file read and a network read are separate permissions.** `local.read` covers
a folder or file you name; `net.read` covers an endpoint. Granting one does not
grant the other, and neither happens without a click — a plugin is a unit, not a
set of partial unlocks.

**Grants are read from the file, not from a counter.** The config epoch is an
optimisation for rebuilding adapters, not the enforcement mechanism. A settings
file edited from outside the app still stops the fetch, and `checkConfigDrift`
rebuilds the adapter rather than leaving a warm one holding a permission that has
since been withdrawn.

`GET /api/connections` returns every connection with its capabilities, its
reasons, what it last managed to read, the group it belongs to, and the two
counts the panel header shows. `POST /api/connections` grants, revokes, connects
and disconnects. `PUT /api/connections/settings` writes a connection's own
fields. `/xana/connections` serves the same GET and POST under the gateway
namespace; the settings write has no `/xana` twin.

The pre-rename addresses still answer — `/api/plugins`, `/api/plugins/settings`,
`/api/plugins/google/callback` and `/xana/plugins` — by re-exporting the
canonical handlers rather than reimplementing them. The name was public when it
changed, so a bookmark or a script written against it should keep working; a copy
would have been two behaviours to keep in step, and the second one is the one
that goes stale.

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
| `GET` | `/api/state` | Ambient poll: presence, headline, energy, attention |
| `GET` | `/xana/context` | The unified life-state gateway (canonical) |
| `GET` | `/api/context` | Alias of the above, for the UI's `/api` prefix |
| `POST` | `/api/chat` | `{ message, sessionId?, modality? }` → `{ message, lifeState }` |
| `POST` | `/api/action` | `{ action: ActionIntent }` → `{ outcome }` |
| `GET` | `/xana/settings` | Current settings, every secret masked (canonical) |
| `GET` | `/api/settings` | Alias of the above |
| `PUT` | `/api/settings` | Merge a settings patch. `{ testModel: true }` probes without saving |
| `GET` | `/api/connections` | Every connection: capabilities, reasons, settings presence, last read, its group, and the two counts |
| `POST` | `/api/connections` | `{ id, action }` — `grant`, `revoke`, `connect`, `disconnect` |
| `PUT` | `/api/connections/settings` | `{ values }` — one connection's own fields, then rebuild its adapter |
| `GET` | `/api/connections/google/callback` | Where Google returns the browser. Exchanges the code, checks `state` |
| `GET` | `/xana/connections` | The same GET and POST handlers under the gateway namespace |
| `POST` | `/api/health/ingest` | A phone posts a day of health readings (`X-Device-Token`, no session, no capability) |
| `POST` | `/xana/health/ingest` | The same ingest on the gateway path |
| `GET` | `/api/plugins` | Pre-rename alias of `/api/connections`; `POST` answers there too |
| `PUT` | `/api/plugins/settings` | Pre-rename alias of `/api/connections/settings` |
| `GET` | `/api/plugins/google/callback` | Pre-rename alias of the callback, kept for a redirect URI already registered |
| `GET` | `/xana/plugins` | Pre-rename alias of `/xana/connections`; `POST` answers there too |
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

**Settings first.** Everything below can be set from **Settings → Connections**,
which writes `data/settings.json`. Environment variables still work, and are the
right answer for a container or a shared machine — but a value set in the UI wins
over one from the environment.

The old flat `XANA_*` names still resolve, so an exported variable keeps working.
They live in a collapsed block at the foot of that screen — **Older XANA_*
environment values** — purely so an older value can be cleared; new configuration
belongs to the connection that owns it.

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
| `XANA_CRYPTO_COINS` | CoinGecko ids (default: `bitcoin,ethereum,solana`, up to eight). Superseded by `crypto.coins` |
| `XANA_LAT` / `XANA_LON` / `XANA_LOCATION_LABEL` | Pins the weather location. Superseded by `weather.latitude` / `weather.longitude` / `weather.place` |
| `XANA_DATA_DIR` | Moves both the database and the settings file |

Environment variables do **not** grant permission. A token in your shell and an
ungranted `net.read` means the token is read and nothing is fetched — the
capability is stored in the settings file only, precisely so that reaching into
your environment is not a way to widen what Xana may do.

### Crypto

Coin prices, with no key and no account. CoinGecko serves one `simple/price` call
for a list of ids, and nothing else is sent — which is why this is a connection of
its own rather than a second symbol list under Markets: a ticker list is a
portfolio, a coin list is a price check, and the two are read from different
places.

Set `crypto.coins` to CoinGecko ids — `bitcoin`, `ethereum`, `solana` by default,
up to eight, separated by commas or spaces. Each coin contributes one line to the
same `finance[]` signals Markets writes to, so the briefing, the prompt and the
ambient card pick it up with no separate plumbing: the price in dollars, the 24h
move, and `up`/`down`/`flat` at half a percent either way. The list is cached for
five minutes, because the free endpoint rate-limits by the minute and a price that
is five minutes old is still an honest price. A day the endpoint does not answer
is a status row saying why, not an empty line pretending the coins did not move.

### Google Calendar

Two ways in, and they are not equivalent.

**An ICS feed** (the `calendar` plugin) is the right choice for reading. Google,
Outlook and Fastmail all publish a private address under their calendar
settings; paste it, allow `net.read`, and today's schedule appears. No OAuth app,
no client secret, no token custody.

**The `google-calendar` connection** is for writing, and for a grant you can
revoke from Google's side as well as Xana's. It creates events in your real
calendar when you allow `remote.write`.

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   create a project and **enable the Google Calendar API**.
2. Configure the OAuth consent screen. Add yourself as a test user if the app is
   in Testing.
3. Create a credential. **Desktop app** is simplest — it has no client secret and
   the flow below is built for it. A **Web application** client works too; add
   `http://127.0.0.1:4310/api/connections/google/callback` as an authorized
   redirect URI and paste the client secret as well. The pre-rename path
   `/api/plugins/google/callback` still finishes a sign-in, so a Google Cloud
   project that already registered it does not have to change.
4. Paste the client ID in **Settings → Connections → Google Calendar**, press
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
write is one-way by design. Connection secrets are the same — `/api/connections`
reports presence, never a value, not even masked.

### Phone health

Apple Health and Google Fit have no key to paste: HealthKit is on-device only, and
Google Fit needs OAuth and a cloud round trip. So the phone posts a day's sample
to Xana instead. No app to install, no account to connect, no folder to keep in
sync.

The health connection's card carries the three things this needs — where to post,
which header, and a body to paste — and a shortcut with one `Get Contents of URL`
action is the whole client.

- **URL** — `http://<this machine on your network>:4310/api/health/ingest`, or
  `/xana/health/ingest`
- **Header** — `X-Device-Token: <the token>`; a `token` field in the body works too
- **Body** — `{"date":"2026-02-01","sleepHours":7.4,"steps":8420,"restingHeartRate":54,"mood":"good"}`

An array of those, or `{samples: [...]}`, posts a batch; one POST may carry 500
samples. The keys are the ones the export parser already tolerates, so a body can
be piped from an export straight into a POST, and a day sent twice is updated
rather than counted twice — which is what makes a shortcut safe to run on a
schedule.

**iPhone.** In Shortcuts: Get Health Sample, then Get Contents of URL, method
POST, request body JSON, the body above, and a header named `X-Device-Token`.
**Android.** Health Sync or Health Connect can write an export folder, and
Tasker's HTTP Request action posts the same URL, header and body. With no phone at
all, point `health.folder` at the export folder and she reads the files directly.

**The token is a bearer secret.** Anyone holding it can write health rows to this
machine. No capability is involved — the token *is* the grant, and a permission
that meant "read a folder you named" would describe nothing that happens when a
request arrives from the network. Put a long random string in
`health.deviceToken`, save, and paste the same string into the phone: the card
shows the stored value because this one exists to be copied onto another device.
Xana can mint a 32-byte one herself when a post presents a token and none is
stored yet, but the field is the reliable way to get a value to copy. Either way
it lives in `data/settings.json`, is compared in constant time, and is never
returned by the ingest endpoint; a wrong or *short* token gets the same three
words back, because the time it takes to say no must not say how much of the token
was right.

Set `health.ingest` to `on` to accept posts at all — it is off by default, so a
fresh install has no endpoint that accepts anything, and the token is checked
before the switch so an unauthenticated caller cannot use the route to find out
whether it is on. A phone surfaces the refusals as they come: `400 No device
token`, `403 That token is not right.`, `409 Phone ingest is off.`, and a body
with nothing usable in it is a `400` that says how many entries were rejected.

**Reaching her from the phone.** `npm run dev` listens on loopback, which a phone
cannot reach. Start her with `HOSTNAME=0.0.0.0 npm run dev` to listen on every
interface, and use this machine's address on your network rather than the one
printed. That switch exposes this interface — settings included — to the local
network, so it is for a network you trust: the ingest route authenticates itself,
and nothing else on that surface does.

---

## Verifying it

```bash
npm run check                # typecheck + demo + route smoke + orb maths + craft floor
npm run verify:web           # with the server running: the real HTTP surface
npm run verify:browser       # with the server running: a real browser
npm run verify:crypto        # the keyless quote path, on a stubbed CoinGecko
npm run verify:health-bridge # the phone door: token, statuses, day upserts
```

Three scripts are for operating her rather than verifying her, and they are the
ones to reach for when a connection looks wrong. They are not in `check`,
because each one either writes to your real settings or needs a server:

```bash
node scripts/grant-connections.mjs [id ...]   # grant, one connection at a time
node scripts/pull-now.mjs                     # force a read, show what each got
node scripts/probe-status-rows.mjs 40         # is the one-row-per-connection rule holding?
```

- `scripts/grant-connections.mjs` — grants through `POST /api/connections`, one
  `{ id, action }` per connection, which is the same call the Allow button makes.
  It runs two passes because capabilities accumulate: `weather` needs `net.read`
  **and** `location`, so its first grant leaves it half-allowed, and the second
  pass picks up whatever the first unblocked. It never grants a write capability
  — `local.write`, `net.write` and `remote.write` are absent unless you ask for
  them by id through the API or the panel.
- `scripts/pull-now.mjs` — `?force=1` and then a row per connection with its
  state, provenance and detail, plus the assembled values (weather, finance,
  calendar, health, focus, patterns). This is the answer to "did my grant do
  anything", and it distinguishes the three things a blocked-looking row can be:
  **blocked** (no permission), **local** (permitted, nothing configured yet), and
  **error** (permitted and configured, and the host did not answer).
- `scripts/probe-status-rows.mjs` — hammers `/api/context` and checks that the
  status array never has fewer rows than there are connections. Written to chase
  one intermittent `verify:web` failure; it found nothing in 40 samples and the
  assertion was left as it was, because the rule it checks is real. It exists so
  the next occurrence can be read instead of guessed at.

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
- `npm run verify:crypto` — the crypto connection with `globalThis.fetch` stubbed,
  because CoinGecko is unreachable from the sandbox this was built in: the ids are
  filtered, capped and deduped; the price bands and the trend thresholds hold; a
  body with nothing usable in it is an `error` row rather than a `$NaN` line; a
  rejected request and a dead connection both report instead of throwing; and the
  descriptor as pasted still satisfies the boot contract.
- `npm run verify:health-bridge` — the phone door, and the negative cases are the
  point: a token that is wrong, a *prefix* of the right one, and the right one
  with a character changed are each refused with the same sentence; a refusal
  writes no row, checked by counting rows before and after rather than by reading
  the status code; `400`, `403` and `409` land on the conditions they name; a valid
  day ingests and the same day posted again updates instead of duplicating; and
  both ingest paths run the identical handler.
- `npm run verify:web` — the served application: rendered page, inlined theme
  tokens, the stylesheet as it comes through Tailwind, every endpoint, a live
  chat turn, and a settings round trip that changes the theme, proves the next
  page load renders it, and changes it back.
- `npm run check:design` — the craft floor as a check, for the invariants that
  were only auditable by eye and that a new panel is most likely to break again:
  no `font-light` at 12px or below, no component rendering its own `h1`, no
  heading level skipping a step inside one component, every scrolling `<code>`
  block able to wrap a URL that has no spaces, long values wrapped rather than
  widening a 390px sheet, cards using the project's own `card` class, and the
  caret and native controls resolving from the accent channels. Every rule in it
  earned its place by catching something real — the two `<code>` blocks it
  flagged in `ModelPanel` and `Settings.tsx` were genuine 390px overflow bugs
  nobody had noticed, and the first version of its heading rule was itself a
  false-positive generator, which is why it now checks only what one file can be
  wrong about. Run it with the server up and it reads the *served* stylesheet
  rather than the source.
- `npm run check:palette` — the half of DESIGN.md §1 that needs no server: every
  text token clears 4.5:1 against every surface, each step of the surface ladder
  reads as a step (≥1.08:1, the number the file settled on after a 1.05:1 ladder
  was judged invisible), and the three semantic colours stay legible on the void.
  `verify:web` makes the same text-contrast claim against the *served*
  stylesheet; this one can run in `check`, which is where a new token gets
  measured before anyone looks at it. `--text-faint` currently measures 4.71:1
  at its worst, which is the margin the comment in `globals.css` is about.
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

- **`npm run verify:browser` has still never run here, and that is now proved
  rather than assumed.** Launching headless Edge directly exits during startup
  (`0x80000003`, a breakpoint), and its DevTools port never opens — so no script
  that drives a browser can work in this sandbox, whatever it does. The script
  now also refuses to *start* when nothing is answering at the target (with the
  port `npm run dev` printed, and how to pass a different one), because the other
  way to get a misleading report is a good machine with no server up. What that
  command checks — that the client bundle hydrated, that the orb canvas is
  actually painting and animating, that Settings opens on a real click and
  recolours the document, and that nothing overflows at 390px — is therefore
  still unverified, and the parts of it that *can* be checked without a browser
  are covered by `check:design`, `check:palette`, `check:bundle` and
  `verify:web`. Run it once on a machine with a browser to close it.
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
- **Crypto and Markets cannot be observed live from the sandbox this was built
  in.** `api.coingecko.com`, `stooq.com`, `github.com` and
  `www.googleapis.com:443` are unreachable here, while `api.open-meteo.com`,
  `ipwho.is`, `freeipapi.com` and `api.todoist.com` answer. Neither quote
  connection has been watched returning a real price: both are verified against
  the documented response shape through a stubbed `fetch` (`npm run verify:crypto`),
  and the same missing route is half the reason the Google flow below is unrun.
  Weather *was* watched end to end here: with `net.read` and `location` granted
  and no coordinates set, the IP fallback resolved `ipwho.is` and the card read
  `connected · live · Huizhou`.
- **The weather IP fallback asks two hosts, because one of them is now behind a
  challenge.** It used to ask `ipapi.co` alone, which answers a Node `fetch`
  with a Cloudflare interstitial — HTTP 403 and an HTML body — so a fresh install
  with nothing configured got no forecast and a status row that blamed the
  missing coordinates rather than the provider. `ipwho.is` (1,000 lookups a day,
  no key) is asked first and `freeipapi.com` second; both are named in the
  consent prompt, since a host list that omits one is a lie of omission. The
  adapter's own 15-minute TTL means at most 96 lookups a day.
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

