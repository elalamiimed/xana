# MEMORY.md

Why Xana is built the way she is. The README covers *what* she does and how to
run her; this is the reasoning that is not obvious from reading the code, plus
the decisions that would be expensive to reverse.

---

## The load-bearing decisions

### 1. The LLM shapes what she says; the local engine decides what she does

`think()` in `src/lib/mind/index.ts` resolves intent **locally, always**, before
any model is consulted. The LLM receives the resolved action as an
`ACTION RESULT` block and is asked to phrase a confirmation — never to decide
what to write.

This is the single most important structural choice in the project. It means:

- A model can never invent a calendar entry that lands in the database.
- Every write-back is byte-identical whether or not an API key is configured.
- The assistant is fully functional with no network at all.
- Hallucination is contained to wording, where it is a style problem, rather
  than to state, where it is a trust problem.

If you ever add a tool-calling loop that lets the model dispatch actions, you
are trading this property away. Do it deliberately or not at all.

### 2. Adapters never throw, and never lie about their mode

Every adapter returns an `AdapterStatus` declaring `state`
(`connected` / `local` / `offline` / `error`) and `mode` (`live` / `local` /
`synthetic`). A dead integration costs exactly one status row; it can never take
the life state down.

The honesty matters more than it looks. The UI renders these as dots, and a
`local` source that silently returned fabricated data would make every
downstream derived number — energy, patterns, nudges — quietly wrong. When the
weather is synthetic, `WeatherSnapshot.synthetic` is `true` and the UI dims it.
When markets time out, the status says so.

**Do not add an adapter that reports `connected` while serving cached or
invented data.** Degrade the mode instead.

### 3. Writes invalidate two caches, not one

`invalidateContext()` clears the assembled `LifeState` **and** every adapter's
cached slice.

This was a real bug: clearing only the gateway meant the next read rebuilt the
state from adapter caches that still predated the write, so Xana would say
"Noted — call Mom" and then show a task list without it. If you add a cache
anywhere in the read path, it must be reachable from `invalidateContext()`.

### 4. Memory ingestion is idempotent by key

`ingestSnapshot()` walks a freshly collected snapshot and writes durable
memories. Every memory carries a `key:<value>` tag, and `knownKeys()` pre-loads
the set of everything already stored. Re-ingesting the same snapshot adds
nothing.

Without this, the life state is rebuilt on every poll and memories would
multiply without bound. The `key:` convention lives in tags rather than a schema
column specifically so it needed no migration.

### 5. Detection requires evidence and stays silent without it

Every pattern detector has a minimum sample (`>= 6` focus sessions, `>= 8`
paired sleep/mood days, `>= 4` events for crowding) and returns `undefined`
rather than a weak claim. Patterns are then thinned to **one per family**, so
four insights are about four different things rather than three about habits.

An assistant that announces a pattern from three data points is astrology.
Silence is the correct output when the sample is thin — resist the temptation to
lower these thresholds to make the demo busier.

### 6. Ambiguous time expressions return `undefined`

`parseWhen()` in `src/lib/core/nlp.ts` refuses to guess. "Friday" resolves; a
bare "5" does not become 5pm. Bare numerals only count as hours when something
marks them as such — a meridiem, a colon, a preceding "at", or a value that
cannot be anything else (13–23).

The related trap, already hit once: the clock matcher is broad and would find
the "2" in "in 2 hours". Unambiguous forms therefore **return immediately**
before the looser patterns get a look. Any new pattern added here must decide
whether it is authoritative or a fallback, and be placed accordingly.

### 7. `hasTime` is carried through to the confirmation

"Remind me Friday" and "remind me Friday at 3" are different promises. The
`create_reminder` intent carries `hasTime`, so the confirmation does not invent
a clock time the user never gave. Same principle for `formatDay` vs
`formatTime` everywhere: say only what was said.

### 8. Accents are channels, not colours

`--accent-rgb: 111 227 227`, never `--accent: #7fe3e3`. Every shade in the
system is composed at runtime with `rgb(var(--accent-rgb) / <alpha>)`.

This is not a style preference, it is what makes customisation possible at all.
With a finished colour token, offering a theme picker means either shipping a
pre-computed ramp per theme (so a custom colour silently gets the default cyan's
borders and glows) or rewriting every component to compute its own shades. With
channels, changing three integers on `<html>` recolours the entire interface,
including the orb's canvas — which reads the same triplet back out of computed
style, so the 3D renderer and the stylesheet cannot disagree about what the
accent is.

Corollary: a new colour in the UI is *derived*, never authored. If you find
yourself wanting a hex code, you want an alpha step on an existing channel.

### 9. Settings live in a file the app owns, not in `process.env`

`data/settings.json`, read through one `credential()` function with strict
precedence: settings file → environment → default.

The obvious alternative — writing `process.env` at runtime — does work in this
single-process setup, and was researched rather than assumed. It was rejected
anyway, for concrete reasons:

- `@next/env`'s forced reload calls `replaceProcessEnv`, which **deletes** every
  variable not in its boot-time snapshot. Any runtime write is wiped the next
  time env config reloads.
- It is per-process, unavailable to the client without an API hop, and not
  reflected in anything inlined at build time.
- Next's docs are silent on runtime mutation. Working-but-unsupported is a poor
  foundation for the one screen that stores credentials.

A module-scope store with an mtime-memoised read has none of those properties.
`process.env` stays for boot-time configuration, read dynamically.

The file is written atomically (temp file + rename, so a crash mid-write cannot
leave truncated JSON that bricks the next boot) and `0600` where the platform
honours it. A legacy `.xana/settings.json` is migrated on first read.

### 10. The API key is write-only from the browser's point of view

`GET /api/settings` returns a **mask and a presence flag**, never the value. The
UI sends the sentinel `KEEP_KEY` when the user did not retype the field.

Both halves are load-bearing. Without the mask, the key leaks into screenshots,
browser caches and devtools sessions. Without the sentinel, the only way to
"leave it alone" would be to round-trip the mask back — which would store
`••••••••1a2b` as the key and fail at the next message with a baffling 401.

Consequence for any new secret field: it goes in `SOURCE_GROUPS` with
`kind: "secret"`, and the form treats it as replace-or-keep. There is no path
that reads a secret back out.

### 11. The model must be switched on, not merely present

`modelActive()` requires **both** a key and `model.enabled`. Someone with
`OPENAI_API_KEY` exported for another tool has not thereby agreed to Xana
spending it. Silently beginning to bill a user because they happened to have a
key in their environment is the kind of behaviour that is very hard to forgive.

The same reasoning is why the model panel's test button runs against the
**unsaved** form: the point is to validate what is on screen, and it should cost
nothing but a request to do so.

---

## Traps that have already bitten

- **`handleBrief` with no guard.** It returned a briefing unconditionally and,
  sitting in the handler list, swallowed every unmatched utterance — so
  nonsense input produced a confident briefing. Every handler must return
  `undefined` when it does not recognise the input. If you add one, add its
  guard in the same edit.
- **Over-broad word patterns.** `/\b(?:my|the) day\b/` matched "Mon**day**" and
  "birth**day**". Anchor to phrases, not bare words.
- **Booking verbs are not scheduling verbs.** "Book the flights" is a task.
  Treating booking language as calendar events quietly fills a calendar with
  to-dos. An event requires a scheduling noun (meeting, call, appointment) or a
  clock time.
- **Same-day sleep/mood correlation measures the wrong direction.** A bad day
  makes you log less sleep. The pairing is deliberately lagged: mood on day N
  against sleep on day N-1, and only across consecutive days.
- **`createGoal` milestones.** Milestones are passed as drafts; `id` and
  `goalId` are assigned by the store. Do not require callers to build them.
- **`next Wednesday`.** Both "Wednesday" and "next Wednesday" mean the nearest
  future occurrence. `next` implying "skip a week" produced reminders 12 days
  out when 5 was meant.
- **Depth normalised against the wrong radius.** Projection divides a vertex's
  z by the radius of *the object being drawn* to produce a 0..1 depth. Passing
  the orb's radius for a shell that fills only 52% of it squeezed every particle
  into the middle of the range: identical sizes, no front-to-back falloff, and a
  sphere that rendered as a flat disc. Caught by `verify:orb`, which asserts the
  depth range actually spans. The orbit rings had the same bug with the same
  fix.
- **A growth-falloff curve has to be monotonic.** The at-risk habit heuristic
  originally compared cumulative and remaining counts in a way that let a habit
  read as "reachable" while its growth requirement still fell, so the nudge
  fired on habits with a rising deficit.
- **A file watcher that does not exist.** `next dev` watches `.env*` and reloads
  them; the programmatic path in `scripts/dev.mjs` does not, because that
  watcher lives in the CLI's dev bundler. Editing `.env.local` under
  `npm run dev` therefore did nothing, silently. `dev.mjs` now wires the watcher
  back up, and folds the live environment into the snapshot before each reload
  so the reload cannot delete variables set at boot.
- **`import type` and `node:fs` do not mix.** The settings form is a client
  component and needs the theme presets, the provider list and the source-group
  definitions. Those started in `store.ts` alongside `node:fs`, which put the
  filesystem into the browser bundle. They now live in `settings/types.ts`,
  which imports nothing. If client code needs a constant from the settings
  layer, it belongs in `types.ts`.

---

## Environment constraints encountered

- **pnpm cannot be used here.** It hardcodes its store operation lock at
  `%LOCALAPPDATA%\pnpm-store-operation-locks`, outside the project and not
  configurable via `store-dir` or `state-dir`. npm is configured with an
  in-project cache in `.npmrc` instead.
- **`npm install` needs `--ignore-scripts` under a restrictive sandbox.**
  `better-sqlite3` ships prebuilt binaries in `prebuilds/` (including
  `win32-x64.node`) and resolves them without a build step, so skipping
  lifecycle scripts is safe. `esbuild`'s postinstall is the only casualty, and
  `tsx` is not used for that reason.
- **Scripts run under Node 24's native type stripping**, with
  `scripts/ts-resolve.mjs` handling extension-less imports and the `@/` alias.
  This avoids `tsx` and its spawned esbuild service entirely.
- **`next dev` forks a supervisor; `npm run dev` does not.** The stock CLI parses
  flags and then `child_process.fork()`s the real server, which a
  process-denying sandbox kills with `EPERM` before anything is served. Next
  exposes that server programmatically, so `scripts/dev.mjs` does the
  supervisor's job in-process — same server, same HMR, same routes. It also
  probes the port first: if Xana is already there it prints the URL and exits,
  and if some *other* program owns it, it walks upward for a free port instead
  of dying with `EADDRINUSE`. `npm run dev:next` is the stock CLI.
- **`next build` still forks workers** for its page-data phase, so a restricted
  sandbox blocks it even though compilation succeeds. `npm run smoke` (scratch
  database) and `scripts/serve.ts` (real database) exercise the routes without
  Next's worker pool.
- **A real browser cannot run here, and there is no way around it.** Chromium is
  a multi-process application whose IPC is built on named pipes; this sandbox
  denies both process creation (`spawn EPERM`) and named-pipe access
  (`platform_channel.cc ... Access is denied`), so Edge aborts during startup.
  `scripts/verify-browser.mjs` therefore detects the condition and reports a
  skip with the reason rather than a failure. **It has never been executed
  successfully**, in this environment or any other — its logic is unverified.
  Everything else in `npm run check` and `verify:web` has been run.
- **`serverExternalPackages: ["better-sqlite3"]` is redundant** — Next 16
  auto-externalises it — but it is kept as documentation of intent.

---

## Where to extend

| Task | Where | Watch out for |
|---|---|---|
| New data source | `src/lib/adapters/`, register in `registry.ts`, add its fields to `SOURCE_GROUPS` | Return a status; never throw; declare the true mode |
| New action | `ActionIntent` in `core/types.ts`, then the executor's switch | The exhaustive `never` default will fail the typecheck until handled |
| New pattern | `src/lib/derived/patterns.ts` | Minimum sample, `evidence` strings, and a `patternFamily` prefix |
| New nudge | `src/lib/derived/nudges.ts` | Give it a priority and, where possible, an `ActionIntent` |
| New card | `Card` union in `core/types.ts` | `CardView` has a `never`-typed default; the local mind's `leadInFor` needs a line |
| New config | `SOURCE_GROUPS` in `settings/types.ts` | The form generates itself; absent must be a normal state, not an error |
| New theme | `THEME_PRESETS` in `settings/themes.ts` | Two channel triplets. Tune by eye, not by hue rotation |
| New presence state | `PRESENCE_STYLE` in `orb/scene.ts` | Every field is a target the renderer eases toward |
| New motion | A token in `globals.css`, multiplied by `var(--motion)` | It has to stop under `prefers-reduced-motion` |

The `never`-typed defaults in `executor.ts`, `CardView.tsx` and `leadInFor` are
deliberate: adding a variant without handling it fails `npm run typecheck`
rather than silently doing nothing at runtime.

A note on the settings form: it is generated from `SOURCE_GROUPS`, so a new
integration needs no UI work at all. That is the intended shape — if you find
yourself hand-writing a field in `SourcesPanel.tsx`, the field list is the thing
to change instead.
