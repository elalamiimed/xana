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

**The same bug exists one layer up, and it survived longer.** A *permission*
change is a configuration change, and it used to drop the epoch and the adapter
caches while leaving the assembled state in place — so granting `net.read` and
reading the state within the gateway's four-second window returned the state as
it was before the grant. The panel's own question, "did that permission do
anything", answered no. `afterConfigChange()` in `lib/plugins/automation.ts` now
calls `invalidateContext()` too, dynamically, for the reason that file gives: a
static import of the gateway from the plugin layer would close a cycle for the
sake of one function. Bounded at four seconds, invisible in the panel, and worth
fixing anyway — a permission that appears not to have applied invites a second
click.

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

Consequence for any new secret field: a connection declares it in its
descriptor's `config` with `kind: "secret"` — the legacy flat keys in
`SOURCE_GROUPS` follow the same rule — and the form treats it as replace-or-keep.
There is no path that reads a secret back out.

### 11. The model must be switched on, not merely present

`modelActive()` requires **both** a key and `model.enabled`. Someone with
`OPENAI_API_KEY` exported for another tool has not thereby agreed to Xana
spending it. Silently beginning to bill a user because they happened to have a
key in their environment is the kind of behaviour that is very hard to forgive.

The same reasoning is why the model panel's test button runs against the
**unsaved** form: the point is to validate what is on screen, and it should cost
nothing but a request to do so.

### 12. One surface, one name: Connections

`plugins` and `connections` were two settings screens under two names. "Plugins"
held the permission cards and the API keys; "Connections" held the legacy flat
`XANA_*` values. Neither was the place you looked for everything she can reach,
and a key could be set on one screen that the other never mentioned.

They are one list now, grouped by what it takes to connect — your data, a
service, a device, or something bundled — because that is the user's actual
question on opening the screen: what does this cost me in configuration. The
grouping is computed on the server, in `ConnectionGroup` (`lib/plugins/types.ts`),
and shipped with the response, so a heading cannot end up disagreeing with the
cards under it.

The old names still answer. `GET`/`POST /api/plugins`,
`PUT /api/plugins/settings`, `GET /api/plugins/google/callback` and
`/xana/plugins` re-export the canonical handlers, and the client's old function
names are aliases rather than copies. The rename was for the user, not for the
wire: a bookmark or a script written before it should keep working. Two names for
one behaviour is only a problem when the second one is a second implementation,
and none of these are.

### 13. The phone's token is the authorisation, not a capability

`POST /api/health/ingest` needs no grant, deliberately rather than by omission.
`local.read` describes Xana reading a folder the user named; it does not describe
a request arriving from the network, so requiring it here would be a permission
that means nothing and gets clicked through.

What protects the endpoint is the token: generated on this machine, held only in
`data/settings.json` and on the phone, and compared with `timingSafeEqual` on
equal-length buffers. It is never echoed by the ingest response; the connections
card does show the stored value, deliberately, because it exists to be copied onto
another device. The switch
(`health.ingest`) is off by default, so a fresh install has no endpoint that
accepts anything — and the token is checked *before* the switch, so an
unauthenticated caller cannot use the route to learn whether ingest is on at all.

The consequence for anyone extending this: an unauthenticated device path is a
token-shaped problem. If a second device needs in, it gets its own token and the
same constant-time comparison, not a new capability kind.

---

### 14. A local database is not the same as a saved one

Xana writes to SQLite in `data/xana.db`, and for a long time that was the whole
answer to "where does my data go". It was not a good enough answer, and the
evidence was sitting in the repository's own `data/` directory: a **2.9 MB
`-wal` file beside a 320 KB database**.

WAL mode puts a committed write in a separate log and folds it back on a
checkpoint. Nothing ever checkpointed and nothing ever closed the connection, so:

- the file a user would copy to back up their data was roughly a tenth of the
  data, and copying it produced something that opened perfectly and was missing
  most of the history;
- every open replayed a log larger than the database it belonged to.

Three changes, in the order they matter if a crash is the thing you are
defending against:

1. **Checkpoint on open** (`TRUNCATE`). The log is folded in before anything
   reads, so the file on disk is complete from the first second. This is the one
   that covers `kill -9` and a power cut, because it needs no cooperation from
   the dying process.
2. **Checkpoint on `SIGINT`/`SIGTERM` and on process exit**, via
   `src/instrumentation.ts` — Next calls `register()` once per server process
   however it was launched, so `next dev`, `next start` and `scripts/dev.mjs` all
   get it. Registering it in `dev.mjs` alone was the first attempt and was wrong
   for exactly that reason.
3. **`synchronous = NORMAL`, stated rather than inherited.** The SQLite
   documentation pairs it with WAL: a committed transaction survives an
   application crash and is lost only if the OS loses power first. `FULL` fsyncs
   per commit (a stall per utterance, for a guarantee nobody asked for); `OFF`
   silently permits losing committed data. Naming it makes it a decision.

`npm run backup` copies the database through SQLite's **Online Backup API**, not
a file copy, so it is a consistent instant even while she is writing — plus
`settings.json`, because a backup that omits the keys and grants is a backup that
loses half the state. `data/backups/` stays gitignored for the same reason the
settings file is: it contains the keys.

The trap to remember: **a backup that has never been opened is a file, not a
backup.** The script opens every copy and compares row counts before it reports
success, and deletes the folder if the copy will not open.

### 15. A recogniser session is not a transcript

The browser's `SpeechRecognition` does not hand you a growing transcript. It
hands you the result list for the **current session**, and a session does not
survive a pause: Chromium ends it after a few seconds of silence, `onend` fires,
and the next `start()` begins an empty list.

This matters because the obvious implementation is one line — read every result
in the event and use that as the text — and it is wrong:

- **It deletes what the user said.** Rebuilding the field from a fresh session's
  list drops everything heard before the pause. Nothing errors and nothing logs;
  the words simply disappear while the user watches. That is the worst thing
  dictation can do, and it is what happened the first time continuous dictation
  was turned on here.
- **It multiplies the sentence.** `event.results` is re-sent in full on every
  event, so re-reading from zero commits every final result again. Honouring
  `event.resultIndex` is what stops it.
- **It doubles partial words.** A partial result is revised **at the same
  index**, so appending each revision produces `remindremind me`. The tail has to
  be *rebuilt* from the unsettled entries, not appended to.

So the accumulation is three pieces of state, not one string: `committed` (every
final result, across sessions, only ever grows), `committedCount` (how many
results of this session are already folded in), and `lastFinal` (so a browser
that re-sends a final cannot write it twice). The session boundary is passed in
by the caller, **not inferred from `resultIndex === 0`** — that guess is
ambiguous, because a session whose first result is also its last fires it too,
and the first attempt at this wiped the live tail on ordinary events.

It lives in `src/components/xana/dictation.ts` as a pure function, because the
bug needs a browser that ends a session mid-sentence to reproduce, which is
exactly what cannot be arranged on demand. `npm run verify:dictation` drives it
through the real event stream instead.

### 16. A wake word must be tested on what it must NOT match

Every failure mode of a wake word is asymmetric. Missing the name is annoying and
instantly obvious — the user says it again. Firing on a sentence that merely
*contains* the name is silent: the listener swallows the rest of the sentence as
a command and answers something nobody asked, and the user never learns that is
what happened, only that the thing is unreliable.

So matching is anchored to the **start** of an utterance — at most two fillers
("hey", "okay") before the name, and nothing else — because a wake word is how a
sentence is *addressed*, not something it contains. And the negative cases are
first-class tests: "I told Xana to remind me", "the banana is ripe", "can I ask
you something", "I need a nap".

Four versions of the matching were wrong, and only the test file caught any of
them:

- No latitude under five letters rejected `Zana` and `Zara` — the most likely way
  her own name comes back.
- A bonus edit for sharing an opening sound let `sonar` through.
- Folding `c` → `x` turned `can` into `xan`, one edit from `xana`, so "can I ask
  you something" woke her.
- A `break` in the window loop discarded the name itself: in "okay Xana", the
  token after the filler is the name, not a filler, and the loop quit one step
  before finding her — while still answering "can a person do that".

The rules that survived: a token may not be shorter than the name; position 0 is
folding's job, so a substitution there is a different word rather than a
near-miss; and one extra letter is allowed only as a **doubled sound** (`xanna`,
the middle `n` heard twice), which is what separates `Xanna` from `Xanax` —
arithmetic cannot, since they are the same edit distance.

### 17. An open microphone has to be visible, and the browser owns it

Two halves, and both are about honesty rather than code.

**Visible.** A microphone that is open without saying so is the most
objectionable thing an always-on assistant can do. The line above the input
always states which of two genuinely different states she is in — *watching for
her name* (nothing you say is a request) versus *listening for the request* (the
next thing you say is the question) — and it echoes the words as they arrive, so
a misheard name is distinguishable from a microphone that is not working.

**Borrowed.** In Edge on Windows the audio goes to Microsoft's speech service; in
Chrome, Google's. Neither is Xana, neither is DeepSeek, and no key is involved —
but it does leave the machine, and saying otherwise would be a lie. Xana does not
force on-device recognition, because setting `processLocally` where no model is
installed makes `start()` fail outright: a mic that works beats a mic that is
private and dead. It detects the model when present and retries on-device
automatically when the cloud path fails.

The microphone is also **one resource**. Manual dictation and always-listening
both want it, so pressing the mic button takes it synchronously (`wake.stop()`,
not a settings write) and hands it back when done (`wake.resume()`). The first
version freed it by *saving* `wakeEnabled: false` through the settings API — a
network round trip racing the permission prompt, arriving long after
`getUserMedia` had already been called.

### 18. An edit is not a delete-and-retype, and a partial edit is a promise

The task list could be added to, ticked off and deleted — and nothing else. The
most common edit there is, moving something to another day, therefore meant
deleting the task and retyping it, which throws away the id, the creation date
and anything attached to it. `setTaskStatus` even said so in a comment: "title
and date edits are the chat's job for now." They were nobody's job, and an
overdue item stayed overdue because fixing it cost more than ignoring it.

Two rules came out of building the missing verb, and both are about partial
updates:

**Absent is not empty.** A patch must touch only the fields it mentions.
`undefined` means "leave it", `null` means "clear it", and the two are not
interchangeable — a rename that blanked the due date would silently drop a
commitment, and the code that does it looks completely reasonable. The check for
this is a title-only patch followed by an assertion that the date survived.

**A value the server cannot read must be refused, not coerced.** `cleanDate`
returns `null` for an unparseable string, and mapping that straight into the
patch turned `due: "next tuesday"` into a DELETED deadline — a typo in the most
common edit there is, destroying the field it was trying to set. The three
intentions have to stay distinct: a valid date sets it, an explicit `null` or `""`
clears it, and anything else is a 400 that says what format to use. The test
asserts the deadline is still there after the refusal, which is the part a
status-code check would miss.

The general shape, and it applies well beyond tasks: **when a field can mean
"unset" and "do not touch", those must be different values all the way down.**
Collapsing them is how a form silently eats data.

Status keeps its own verb because it carries `completed_at`, which the "what did
I finish" briefing reads. Folding it into the general update would make every
rename decide what to do about a completion timestamp it has no business
touching.

### 19. `network` is not a microphone problem, and retrying is not a fix

The mic button and the wake word both failed with nothing on screen. The flight
recorder answered it in one reading:

```
composer.mount  micButton=true  onDevice=true  secure=true  hasMediaDevices=true
wake.session.open                       <- the microphone opened, every time
wake.error reason=network               <- ten times, never anything else
```

Permission was granted, the hardware was there, the session opened — and then
`network`. `SpeechRecognition` does not transcribe anything itself: Edge sends
the audio to Microsoft's speech service and Chrome to Google's. On a network
behind a proxy that blocks that endpoint, **every** attempt fails this way, no
matter how good the microphone is. The sandbox this was built in cannot reach
`speech.platform.bing.com` either, which is how the diagnosis was confirmed from
both ends.

Three lessons, and the first one cost the most time:

**A diagnostic that reports the *shape* of an event is worth more than any amount
of reasoning about it.** Every code-level fix attempted before the recorder
existed was a guess, and two of those guesses were wrong. One log line ended it.
The recorder sends event names, error names and lengths — never transcript text —
and it is the single most useful thing built in this whole area.

**`network` is terminal, not transient.** `planRestart` treats an unknown error as
retryable with a backoff, which is right in general and wrong here: it retried
four times into a blocked socket and then gave up with "Listening kept failing, so
I switched off." Retrying cannot fix an unreachable host. The honest move is to
stop immediately and say the service is unreachable.

**The fix is not a better retry, it is a different transport.** `local-speech.ts`
records with `MediaRecorder`, finds the end of the sentence from the waveform
(`AnalyserNode`, an adaptive threshold against the room's own noise floor), and
posts the clip to a Whisper service on `127.0.0.1`. No network, nothing to block,
and the audio does not leave the machine. The browser path stays the default
because it is faster where it works — but "where it works" is not everywhere, and
assuming otherwise is what made this look like broken hardware.

The general shape: **when a feature fails with `network` and the user's
microphone is fine, the feature has a transport problem, not a hardware one.**

### 20. "Blocked" is usually "unreachable from where I was standing"

The local transcriber was written, tested at the HTTP layer, and shipped with an
honest note that its core was unexercised: PyPI was unreachable, so
faster-whisper was never installed and Whisper's decode path had never run.
**That note was the defect, not the caveat.** A feature whose central path has
never executed is not "verified with a limitation"; it is unfinished.

The fix was not to accept the network. It was to find a route through it:

- **`pip install faster-whisper` stalled** against `pypi.org`. But TCP to
  `pypi.org:443` connected fine — the request stalled, which is what a
  deep-inspection proxy does. The **Tsinghua mirror installed it in seconds.**
- **Hugging Face is where the model weights live, and it is blocked the same
  way** — `SSL: UNEXPECTED_EOF_WHILE_READING`, immediately, on both the real host
  and `hf-mirror.com`. **ModelScope served the same weights in 9 seconds.**
- **WinRT speech needs a live session** it does not have here, so the built-in
  Windows recognizer (`zh-CN Embedded DNN v11.1`) is real but unusable from a
  background process. Worth knowing before designing around it.

Two lessons, and the second is the one that generalises:

**A half-installed dependency is worse than a missing one.** After the library
went in, the service still reported `ready:false` because the weights had not
arrived — a state that reads as "broken install" rather than "one more download
needed". So `setup.ps1` fetches the weights too, and `serve.ps1` finds both the
venv and the model folder by itself. A setup script that leaves the launcher
guessing has not finished its job.

**Confirm a limitation before shipping it.** "PyPI is unreachable from my
sandbox" was true and became "no real transcription has ever run" — which was
also true, and should have been unacceptable. Two commands found a working
route. The unverified path is now covered by `npm run verify:transcribe`, which
runs the real service against real audio: a decoded WAV, a loaded model, a
computed duration, and a report of exactly what the model heard.

What remains genuinely unproven is **quality** — synthetic audio has no words in
it, so nothing asserts that Whisper transcribes accurately. That is a different
claim from "the path works", and it is the one still owed a real microphone.

### 21. A language tag is not a locale, and the app must not blame the user for its own guess

The sentence was *"This browser cannot recognise your language for dictation.
Change the browser's language, or type instead."* — shown to a user who speaks
English, on a machine set to English, with a working microphone. It is a good
example of a diagnostic that is worse than silence: it names a cause, it is wrong,
and it sends the user to fix something that was never broken.

The cause was one line:

```tsx
instance.lang = navigator.language || "en-US";
```

`docs/MIC-DIAGNOSIS.md` §2 Cause 5 had already identified it. This browser profile
carries `intl.accept_languages = "en,zh-CN,en-GB,en-US"`, so `navigator.language`
is the bare **`en`**; Chromium forwards that tag to its speech service as the
`language=` query parameter; and a service that needs a **locale** refuses a
**language**. `en` is a language. `en-US` is the model to ask for — and en-GB and
en-IN are different models of the same language.

Three things were wrong, and only fixing all three is a fix:

**The app sent a value it had not read.** A tag is normalised (case, `_`/`-`,
`;q=` qualifiers), and a bare language is resolved to a regional model before it
goes out. The list of tags is a curated *starting set*, never an authority: MDN is
plain that there is no way to determine from front-end code which languages a
browser supports, so a tag outside the list is still sent as-is. Refusing it in
the app would be inventing a restriction the browser never stated.

**A refusal was not answered.** `language-not-supported` is a refusal of the tag,
not of the user, and the tag was chosen here — so the next attempt is another
regional variant of the *same* language, walked as a finite ladder that never
re-offers a tag already refused. The tempting shortcut is to fall back to `en-US`
come what may; it is refused, and the reason is the whole point of §2's honesty
rule. Falling back to English for a Chinese user's refusal produces confident
English nonsense, and wrong words are indistinguishable from a bad microphone — so
the user buys a new headset instead of changing one setting. A ladder that stays
inside one language can only ever change the *accent model*, which is the most a
retry can honestly do.

**The user could not disagree.** The inference can still be wrong, and
`voice.speechLang` (Settings → Voice → Dictation language) overrules it. A
deliberate choice gets no ladder at all — second-guessing the user with a
different language is the same mistake wearing a helpful expression.

The general shape, and it applies to every inference this app makes on a user's
behalf: **when a guess fails, correct the guess before reporting a fault.** A
message that tells someone to reconfigure their environment is, nine times in ten,
a message that should have been code.

### 22. A setting that changes behaviour cannot be loaded only when its editor is opened

`useSettings` fetched `/api/settings` when the settings panel was opened, and not
before. The reasoning was stated in the file — "the values are only needed when
the panel is on screen" — and it was simply false. The shell reads
`speakReplies`, `voiceName`, `wakeEnabled`, `wakePhrases` and `transcribe` on
every render, so until someone opened Settings, the app ran on **defaults**: replies
silent, always-listening off, and `transcribe` reported as `"browser"` no matter
what was saved.

That is how a user who had already switched to the local Whisper service, to
escape the browser's speech service entirely, kept meeting that service's errors:
the saved choice was real, on disk, and correct — and ignored until the panel had
been opened once in that session. A fix that silently expires on every reload is
not a fix, and it is the worst kind of bug to report because the user's own
workaround appears not to work.

Two lessons, and the second is the one that generalises:

**The read moved to mount.** One request per page load against loopback, for
values the interface cannot be correct without. An external edit is still picked
up (the store memoises on mtime) and the panel keeps its Reload button.

**A settings default is a claim about the app, not a placeholder.** Every
`view?.x ?? default` in a shell is a decision made in the absence of the answer,
and the absence was an artefact of when the fetch happened. Before writing a `??`
in a component, ask who is holding the value and when they got it. The same
question applies to `transcribe` and to the dictation language, which is why both
now arrive before anything can ask for the microphone.

### 23. An inference must be no wider than the gap it fills

§21's fix resolved the *language* of **every** tag the browser reported. That was
one character too wide, and the machine it was written on could not show it: this
profile's first preference is the bare `en`, so `en` → `en-US` looked perfect.
The same line applied to a complete tag silently rewrote it —

| browser asked for | sent before | sent now |
|---|---|---|
| `en` | `en-US` | `en-US` |
| `en-GB` | `en-US` | `en-GB` |
| `fr-CA` | `fr-FR` | `fr-CA` |
| `pt-PT` | `pt-BR` | `pt-PT` |
| `zh-HK` | **`zh-CN`** | `zh-HK` |

The last row is why this is not a cosmetic slip. `zh-HK` is Cantonese and `zh-CN`
is Mandarin: that is not a change of accent model, it is a change of language, and
it is the exact failure §21 refused when it rejected "fall back to `en-US` come
what may". The bug was fixed in one direction and reintroduced in the other — the
app substituting its own answer for one the browser had already given in full.

**The rule is the shape of the tag, not the contents of a list.** `en` names a
language and no model, which is a gap and is filled. `en-GB`, `zh-Hant` and
`es-419` name both, which is an answer and is passed through. `isBareLanguage` is
one `includes("-")`, and `representativeFor` keeps answering for a *language* so
that nothing calls it on a tag again — the confusion was in the helper's name, not
in its arithmetic.

The general shape: **an inference must be no wider than the gap it fills.**
Resolving a bare language fills a gap the browser left; resolving a complete tag
overwrites something it said. Same function, same list, opposite verdicts.

**And the same mistake, one level up.** The microphone button was drawn only
where `SpeechRecognition` existed, while the click handler carried a branch for
"no recogniser, but this machine can record" — a sentence telling the user to
switch to the local transcriber, reachable only from a button that condition had
already hidden. The local path needs no `SpeechRecognition` at all; it is
`MediaRecorder` and Whisper on `127.0.0.1`. A browser that could dictate through
it was offered nothing, and dead code was the only evidence anyone had meant
otherwise. `planDictation` is that decision once — mode, recogniser, recorder — and
both the button and the click read it, which is what `verify:dictation` now
drives across all eight combinations.

Anywhere a control has a *condition* and a *handler*, they are one decision
written twice. The second copy is the one that rots, and it rots silently: the
control simply does not appear, and nothing errors.

### 24. A dependency the user chose is the app's to start

The line was *"Waiting for the local transcriber. Start it with
python/serve.ps1 — this reconnects on its own."* and the reply was one sentence:
**"I assume this should start automatically."** The second half of that line was
true and the first half was an abdication. The user had already chosen "transcribe
on this machine" in Settings; the service that choice depends on is therefore the
app's dependency, not the user's chore. A feature that works only for someone who
read the README is not finished.

**Starting a process is easy; starting it safely is the work.** Three properties,
and each one is a bug that was avoided rather than discovered:

- **Idempotent.** Everything begins with a `/health` probe on loopback. A service
  that answers `ready:true` is left alone, and — the case that matters — one that
  answers `ready:false` because it is still loading a 75 MB model is *waited for*,
  not duplicated. Two copies of a server racing for one port is a state where the
  loser is a process nobody owns and the winner is the one the app cannot stop.
- **Rate-limited.** The browser retries every three seconds, so a naive "start it
  when it is missing" is a fork bomb with a friendly name. One start per minute,
  and concurrent callers share one in-flight promise.
- **Never fatal.** The browser engine is a real fallback, so every failure here is
  a sentence — no interpreter, not set up yet, did not come up — and never a throw
  on a path the user is waiting on.

**The launcher's two lookups are part of the feature.** `serve.ps1` found the
virtual environment and the newest `model.bin` for a human at a terminal, because
neither has a name faster-whisper would guess. The app has to do the same two
lookups, or a completely correct install starts a service that reports "no engine
installed" — which reads as a broken install rather than as a launcher that did
not look. `python/models` and the service's own cache are both searched, because a
machine set up by hand has the weights in one and not the other.

**And it exposed a bug that was always there.** The local path is a loop of
awaited recordings. Two of them would hold the same microphone and submit every
sentence twice, and the window in which that can happen was, until now, the
milliseconds between the click and the first recording. Starting a service moved
the recording twenty seconds away from the click, so a double click could reach
it. Both local loops — the mic's and the wake word's — are now guarded by a ref,
and the wake word's guard is a wrapper rather than a `try/finally` around the
whole loop, because that body returns from a dozen places and every one of them
is a legitimate exit.

The general shape: **when a feature needs a service, the app that offers the
feature owns the service's lifetime.** `npm run dev` starts it at boot, so the
first press does not pay for a model load; `/api/transcriber` starts it on demand,
which is what covers `next start` and a service that dies mid-session; and
`python\serve.ps1` stays for the person who wants to watch it run.

### 25. The microphone that filled a box instead of answering

Two complaints in one sentence, and the flight recorder said the feature was
working perfectly:

    "She is always listening even without me calling her name which is weird and
     against privacy, and also when i ask a question she does not answer it."

    wake.on            engine=local phrases=xana
    wake.local.heard   chars=6   ms=3715
    wake.local.match   matched=false
    ... eight clips, eight transcriptions, no match, and not one submit

Nothing was broken. The microphone transcribed every sentence and looked for a
name that was never in them, and the user had no way to know that "she answers
when you say her name" was the contract — the indicator said *Listening for her
name*, which describes what she was looking for and never mentions that the
device was open. **When a feature leaves a microphone open, the sentence has to
name the microphone.** It now reads *Microphone open — listening for her name*,
and the feature is off unless it is switched on.

**And a microphone that fills a box has not answered anything.** The mic button
transcribed into the composer and stopped, which is right for composing a message
and useless for asking a question — the user watched their own sentence appear in
a field and waited for a reply that was never coming. The two are distinguishable
from outside with one signal, and it is not a subtle one:

    empty box    a question. The first finished sentence is sent, the microphone
                 closes, she answers.
    text in it   a continuation. Everything said is appended, nothing is sent
                 until the user sends it.

That is `spokenInputMode`, one line, named and tested, because it is a contract
rather than an implementation detail. "The first finished sentence" is the
recogniser's own judgement on the browser engine (a final result) and the
waveform's on the local one (sustained quiet after speech) — both are the engine
saying the speaker stopped, which is what an answer has to wait for.

**The model a transcriber runs is a quality decision, and the default was the
worst one.** `setup.ps1` fetched `tiny` — 75 MB, the weakest Whisper model — and
`tiny` mangles an unusual name, which is precisely what a wake word is made of.
`base` is 145 MB and much better, and the app already loads the newest model it
finds, so switching is one command and no configuration. Recorded in the README
rather than left as folklore.

One environment trap came with that download. Hugging Face's `xet` backend writes
its own logs to `%USERPROFILE%\.cache\huggingface\xet\logs`, and under a sandbox
that is an access denial several seconds into a download that otherwise works —
the failure looks like the network, and it is the cache path. `HF_HOME` inside
the project and `HF_HUB_DISABLE_XET=1` is what fixed it.

### 26. A delete you cannot undo is a delete nobody uses

The request: *"i'd like xana to be able to remove and add elements freely inside
the project when i ask her too, and if it fucks up sometime, i would like to keep
a trash bin so i can recover from trash bin later. a validity period in trash bin
of 7 days."*

Adding worked. Removing did not exist at all — no delete intent, no delete
handler, and the model's answer to "remove everything of the list" was a
paragraph about why it could not. So the feature is really two features, and the
second one is the reason the first is safe to ship.

**A ROW THAT IS DELETED MOVES; IT DOES NOT GET A FLAG**

The obvious soft delete is a `deleted_at` column and a filter on every read. That
is a rule which has to be applied correctly, forever, in twenty-five queries —
and the briefing, the derived layers, the adapters, the cave and the seed script
all read these tables. The first query somebody forgets puts a deleted task back
in the briefing, and nothing about the code looks wrong.

So a deleted row is **moved** into a `trash` table, whole, as JSON. Every existing
read is correct by construction, including ones written next year, and the bin is
one query. The cost is the round trip, and it has exactly one sharp edge:
`JSON.stringify` turns a Buffer into `{type: "Buffer", data: [...]}`, so a
restored memory's embedding would be stored as the string `[object Object]` — a
memory that is present, readable, and invisible to recall. `rehydrate` exists for
that one value, and `verify:trash` asserts that a restored memory is still
findable, because that is a bug no reviewer would see.

**THE SENTENCE IS THE FEATURE**

*"Removed 6 open tasks. They're in the trash for 7 days if that was a mistake."*
A destructive action and a reversible one are indistinguishable to the person
performing them unless the app says which one just happened, so every deletion
says where the thing went and how long it has.

**AND THE HARD PART IS WHAT MUST NOT FIRE**

A bulk delete is the most dangerous thing in this codebase, and its risk is not
the delete — it is the sentence that looks like one. "Forget it", "drop it",
"cancel that", "forget about my tasks for now and let's talk about this
loneliness thing" (a real message in this project's own history) all begin with a
verb the removal handler owns. So:

  - the bulk form fires on *everything*, *all*, *the list*, *tasks* — never on a
    bare pronoun;
  - a phrase that names something is resolved against tasks, then the calendar,
    then the board, then memory, and removes exactly one thing;
  - a failure to resolve falls through to the rest of the mind when the phrase is
    long, and is reported when it is short. "Remove the dentist thing" that finds
    nothing deserves an answer; a sentence that merely starts with "forget" does
    not deserve to be argued with.

Six of those sentences are asserted in `verify:trash` against a task that must
survive them. That group is the one to extend first when this handler grows.

The general shape: **when a feature becomes destructive, the tests move from what
it does to what it refuses to do.**

**AND A GOAL'S STEPS ARE NOT SEPARATE ROWS**

Deleting a goal puts its milestones in the bin first, because the cascade would
take them before the goal row could be copied. Listing each of them as its own row
looked honest and was not: "Restore" on a step put back a milestone whose goal was
still in the bin, and "Delete for good" on the goal left the steps behind — rows
that could still be restored, into a board that could never show them.

So the bin shows one row per deleted goal, says how many steps came with it,
restores them with it and deletes them for good with it. A step removed on its own
— the ✕ on a card, with its goal still on the board — is still listed and still
restorable, because that one has a life of its own.

It was found by running `verify:cave` against the live app and *looking in the
bin*: that script's own cleanup assertion passed, because it only knew the ids it
had remembered, and two orphan milestones were sitting beside it. `verify:trash`
now purges a goal and asserts its steps cannot be restored — asserted through
`restoreFromTrash`, because the listing hides them and a test that only read the
listing would pass while the rows piled up.

**AND A DERIVED MEMORY HAS TO STAY FORGOTTEN**

Most memories are projections: a note becomes a note memory, a week of sleep
becomes one average, an open high-priority task becomes a standing intention. Each
carries a `key:` tag so the ingest pass can skip what it has already written — and
that pass read only the live table. So forgetting a derived memory lasted about a
minute: the next refresh saw the key as unknown and wrote the record straight back.

This was watched happening on the real database. A sleep average the user deleted
at 23:52 was in the list again at 23:54, which meant a user emptying the room was
deleting more slowly than the job refilling it — and that everything the Memory
room says about a removed memory was false for anything the ingester owns.

`knownKeys` now counts the bin as known, so a forgotten key stays forgotten for the
life of its tombstone. Past the seven days the tombstone is gone and the fact can
be derived again: that is the bin's window, deliberately, and not a second and
quieter rule about forgetting. To remove a derived memory for good, remove what it
is derived from.

The general shape: **a delete is a decision, and every background job that can
re-create the record has to be able to see it.**

### 27. A screen that never asks looks exactly like an empty life

The report: *"Goals and tasks show empty but we have some goals and tasks in the
front page which is contradictory."*

Both halves were true, and nothing in the app was lying. The cave's five rooms
rendered from state that nothing had ever filled: `useCave` published a `reload()`,
took an `open` flag it never read, and had no effect that called it. Opening My cave
showed "Nothing on the board yet" over a database holding three goals and an open
task, while the front page beside it listed them. Two screens contradicting each
other, one database, and no error anywhere — the route was right, the types were
right, and every component rendered exactly what it was handed.

The shape is worth naming, because it is not a cave bug:

  - **An empty state is a claim.** "Nothing open" is a statement about the
    database, and an array nobody has filled cannot support it. Every room printed
    its sentence unconditionally, so "I have not looked yet" and "there is nothing
    there" were the same pixels.
  - **Every check that talks HTTP passes.** `verify:cave` asserted the route's
    payload and went on passing the whole time the screen was empty. So did `tsc`.
    The only test that could have caught it presses the button.
  - **No browser launches here.** Chromium is multi-process and its IPC is built on
    named pipes, which the sandbox denies: it dies with a Mojo `platform_channel`
    error before DevTools answers. `verify:browser` reports that as a skip rather
    than a failure, which is correct and is also not a pass — so `verify:cave-load`
    holds the two invariants a browser would have observed, against the source, and
    `verify:browser` grew the real version: click **My cave**, compare every room
    against `/api/cave`, change the database behind it, re-open.

The fix is a three-line effect. The half worth keeping is the second change: every
room's empty sentence now goes through one function, `emptyNote`, which says
"Reading…" until an answer has landed — so a request that never returns stays
visibly unfinished instead of quietly reassuring.

The general shape: **when a screen can be empty, "empty" and "not read yet" are
different states, and the interface has to be able to tell them apart.**

---

## Traps that have already bitten

- **`Get-Content | Set-Content` destroys the file's UTF-8.** One `-replace`
  round-trip through the shell turned every em dash in a new file into `\xe2\x80?`
  and the dev server refused to compile it: *"invalid utf-8 sequence of 2 bytes"*.
  Edit source with a tool that reads and writes UTF-8. `npm run check:encoding`
  exists for exactly this and named the three damaged lines in seconds — run it
  after any bulk edit.
- **A detached child still dies with the process that started it under a job
  object.** Windows kills the whole tree on job close regardless of
  `detached: true`, so "the service outlives the server" holds in an ordinary
  terminal and not under a sandbox that wraps commands in one. Worth knowing
  before designing anything that assumes a spawned process survives its parent.
- **`process.exit()` while a detached child handle is closing aborts the process
  on Windows** — `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` from
  `uv_async_send`, exit code `0xC0000409`, which reports a passing check as a
  crash. Set `process.exitCode` and let the process end on its own.
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
- **A design rule that is only written down gets broken.** The visual pass that
  produced the Connections panel found five drifts by eye — an unthemed caret, an
  unthemed native control, a card that was a hairline box instead of `.card`, a
  group heading and a card title both at `h4`, and a 64-character token with
  nowhere to wrap — and every one of them was a *pattern* that the next panel
  could reintroduce. `scripts/check-design.mjs` (`npm run check:design`, wired
  into `npm run check`) now asserts the decidable ones: the 12px type floor, no
  component rendering its own `h1`, no level skip inside a component, every
  scrolling `<code>` wrapping, cards using the class, and `caret-color` /
  `accent-color` resolving from `--accent-rgb`.
  **Write the rule at the level it is actually decidable.** The first version of
  the heading rule assumed a component's first heading sat under the shell's h1
  and flagged six correct `h3`s — a gate that reports on what it cannot know
  teaches people to ignore it, so it now checks only the shape one file can be
  wrong about. The script also earned its keep on first run: it found two real
  un-wrapped `<code>` blocks in `ModelPanel.tsx` and `Settings.tsx` that the
  manual pass had missed.
- **A colour claim needs a number, and the number needs re-taking.** DESIGN.md §1
  documents `--text-faint` being raised twice — once for failing outright at
  3.89:1, once because an unrelated change to `--surface-3` took it from 4.54:1
  to 4.21:1 and nothing failed, since the promise lived in a comment. The answer
  is two scripts at two levels: `verify:web` measures the three text tokens
  against every surface **in the served stylesheet**, so a token that did not
  survive Tailwind is caught; `check:palette` measures the whole of §1 with no
  server — the text floors, the surface ladder's 1.08:1 step, and the semantic
  colours — so it runs inside `npm run check`, where a new token gets measured
  before anyone looks at it. The current worst case is `--text-faint` at 4.71:1;
  if that number moves, one of the two says so.
- **A gate that reports on what it cannot know teaches people to ignore it —
  twice now.** The heading rule flagged six correct `h3`s (above), and
  `check-encoding.mjs` flagged `docs/MIC-DIAGNOSIS.md` for quoting this machine's
  real audio device names, which Windows reports in Chinese. That is the evidence
  the diagnosis rests on; deleting it to satisfy the gate would have been the
  wrong repair.
  The fix is an **explicit per-line marker** (`xana-encoding-ok`), not a loosened
  pattern and not a whole-file exclusion: it is auditable by reading the one line,
  it cannot be inherited by a file that has not earned it, and a mojibake line
  will not have been marked by anyone. The guard still catches real corruption —
  verified by writing a genuinely mangled line alongside a marked one and watching
  it fire on exactly one of them.
  The general shape: when a heuristic has a legitimate counterexample, give the
  counterexample a way to *say so*, rather than widening the heuristic until it
  stops noticing.

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
  skip with the reason rather than a failure. **It has still never been executed
  successfully**, in this environment or any other — its logic is unverified.
  Everything else in `npm run check` and `verify:web` has been run.
  Three things were fixed in that skip path during the session that proved it:
  the script now probes the target before launching anything (a browser pointed
  at a dead port fails every assertion downstream and reads like an app bug);
  the skip kills the half-spawned browser before returning, because leaving it
  alive tore Node down with a libuv assertion instead of exiting cleanly; and it
  sets exit 0 explicitly, since a skip that exits nonzero is indistinguishable
  from a failure in anything that runs it. The message says **"NOTHING WAS
  VERIFIED"** in as many words, because a skip that reads like a pass is worse
  than no check at all.
- **Some hosts are unreachable from this sandbox, and the code cannot tell you
  which.** `github.com`, `api.coingecko.com`, `stooq.com` and
  `www.googleapis.com:443` do not answer here; `api.open-meteo.com`, `ipwho.is`,
  `freeipapi.com` and `api.todoist.com` do. Crypto and Markets are therefore
  verified against a stubbed `fetch` (`npm run verify:crypto`) rather than live
  prices, and the Google connect flow stays unrun against Google for this reason
  as well as the missing browser.
- **A host that answers 403 to `fetch` looks exactly like a host that is
  down.** `ipapi.co` was the weather plugin's only IP-geolocation provider, and
  it now serves a Cloudflare interstitial to a Node request: `HTTP 403`, an HTML
  body, no JSON. The adapter swallowed that as "no location" and the user saw a
  synthetic fallback blaming their missing coordinates. Two things came out of
  it, and both generalize: **name two providers** on any keyless fallback that
  matters, and when a provider is swapped, swap it in the descriptor's `hosts`
  and `dataNote` in the same edit — the consent prompt is the only place a user
  is told which third party learns where they are.
- **A phone cannot reach a loopback server.** `npm run dev` binds `127.0.0.1`, so
  `HOSTNAME=0.0.0.0 npm run dev` is the only way a phone on the same network can
  POST to `/api/health/ingest` — and that same switch exposes this interface,
  settings and all, to that network. The ingest route authenticates itself with a
  device token; nothing else on that surface does.
- **`serverExternalPackages: ["better-sqlite3"]` is redundant** — Next 16
  auto-externalises it — but it is kept as documentation of intent.

---

## Where to extend

| Task | Where | Watch out for |
|---|---|---|
| New connection | A descriptor in `src/lib/plugins/registry.ts`, an adapter in `src/lib/adapters/`, and its settings keys in `PLUGIN_SETTING_KEYS` | Return a status; never throw; declare the true mode; pick the `kind` honestly, because it decides which group the consent card sits under |
| New recognition behaviour | `src/components/xana/speech-language.ts` for anything about *which* language, `configureRecognizer` in `speech.ts` for the four options every recogniser shares | A recogniser is built in three places (Composer, wake listener, mic check) and reads the language from one function; never set `instance.lang` from `navigator` directly |
| New secret | The descriptor's `config`, with `kind: "secret"` | Presence, never a value, on the way back to the browser |
| New device / ingest path | `src/lib/plugins/health-bridge.ts` as the model | The token is the authorisation; check it before revealing whether the feature is on; never echo it |
| New action | `ActionIntent` in `core/types.ts`, then the executor's switch | The exhaustive `never` default will fail the typecheck until handled |
| New pattern | `src/lib/derived/patterns.ts` | Minimum sample, `evidence` strings, and a `patternFamily` prefix |
| New nudge | `src/lib/derived/nudges.ts` | Give it a priority and, where possible, an `ActionIntent` |
| New card | `Card` union in `core/types.ts` | `CardView` has a `never`-typed default; the local mind's `leadInFor` needs a line |
| New legacy `XANA_*` name | `SOURCE_GROUPS` in `settings/types.ts` | Frozen. It exists so names that already resolve can be cleared; new configuration belongs to a connection's `config` |
| New theme | `THEME_PRESETS` in `settings/themes.ts` | Two channel triplets. Tune by eye, not by hue rotation |
| New presence state | `PRESENCE_STYLE` in `orb/scene.ts` | Every field is a target the renderer eases toward |
| New motion | A token in `globals.css`, multiplied by `var(--motion)` | It has to stop under `prefers-reduced-motion` |

The `never`-typed defaults in `executor.ts`, `CardView.tsx` and `leadInFor` are
deliberate: adding a variant without handling it fails `npm run typecheck`
rather than silently doing nothing at runtime.

A note on the settings form: a connection's fields are generated from its
descriptor's `config`, so a new integration needs no UI work at all. That is the
intended shape — if you find yourself hand-writing a field in
`ConnectionsPanel.tsx`, the descriptor is the thing to change instead. The
collapsed older-keys block at the foot of that panel is the one part still
generated from `SOURCE_GROUPS`, and nothing new should be added to it.
