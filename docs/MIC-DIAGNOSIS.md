# Why the mic button does not listen

Diagnosis of "When I click the microphone XANA does not listen", for Xana at
`http://127.0.0.1:4310` in Microsoft Edge **154.0.4258.48** on Windows.

Written while `src/components/xana/Composer.tsx`, `src/components/xana/speech.ts`
and `src/app/page.tsx` were being edited. **The code moved underneath this
analysis.** `Composer.tsx` went from 286 to 397 lines *during* the session, so
every line number below is paired with the quoted code — trust the quote, not
the number. Revision analysed: `HEAD = d63fabb` with `Composer.tsx` (397 lines),
`speech.ts` (297 lines) and `page.tsx` (352 lines) as dirty working-tree
revisions.

---

## 0. The verdict in one paragraph

The microphone is not being refused by Windows, and it is not being refused by
Edge: the OS consent store says `Allow`, Edge's own permission for
`http://127.0.0.1:4310` is `setting: 1` (allow) and it records that the mic was
actually opened for that origin. The failure is downstream of "we got the
microphone". Edge's `SpeechRecognition` is **cloud-only** on a stable build —
Microsoft's own policy documentation says *"The Microsoft Edge implementation of
the Web Speech API uses Azure Cognitive Services, so voice data leaves the
machine"* — and the endpoint is baked into this exact installed binary
(`speech.platform.bing.com/speech/recognition/edge/interactive/v1`). So a mic
that opens and then produces nothing is the expected shape of a failed round
trip. On top of that, the *new* dictation code has a defect that destroys the
very fix it was written for: **every time the recogniser auto-restarts, the field
is rebuilt from the frozen `baseText` plus only the current session's results, so
everything dictated before the restart is silently deleted.** That is
"it stopped listening" made literal, and it happens with a perfectly working
speech service.

---

## 1. Every path from the mic click to on-screen text

`Composer.tsx`, current revision. The click handler:

```tsx
// Composer.tsx:360
onClick={() => (dictating ? stopDictation() : startDictation())}
```

`startDictation()` (`Composer.tsx:204-255`), in order:

| # | Step | Code | If it fails |
|---|---|---|---|
| 1 | Get the constructor | `const Recognition = getSpeechRecognition(); if (!Recognition) return;` (205-206) | **Silent.** Returns. Unreachable in practice: the button is only rendered when `micAvailable` (357), which is set by the same test. |
| 2 | Hand the mic over to the wake listener | `onTakeMicrophone?.();` (210) | See §6 — it *persists a settings change* rather than stopping the listener, so the handover is not ordered. |
| 3 | Ask for the microphone with `getUserMedia` | `navigator.mediaDevices.getUserMedia({ audio: true })` (243-244) | **Named.** `.catch` → `setDictationNote(buildDictationNote(error))` (251-254). This is the good path. |
| 4 | Release the probe stream | `for (const track of stream.getTracks()) track.stop();` (248) | — |
| 5 | Build the recogniser | `buildRecognizer(instance, false)` (224) | Sets `continuous = true`, `interimResults = true`, `lang = navigator.language` (135-142). |
| 6 | Start it | `instance.start();` (228) inside `try` → note `"Dictation could not start. Press the mic again."` (229-233) | **Named** (this was fixed). |
| 7 | Results arrive | `setHeard(spoken)` / `setValue(prefix ? \`${prefix} ${spoken}\` : spoken)` (146-150) | **This is where the text is lost.** §2, cause 1. |
| 8 | Errors | `onerror` (152-182) → either the on-device retry or `dictationFailure(reason, local)` | **The retry path is unguarded** — §2, cause 2. |
| 9 | Session ends | `onend` (183-199) restarts while the user still wants dictation | Bookkeeping bug — §2, cause 3. |

Two paths in the *old* revision are now gone and are worth recording as refuted,
because they were the standing hypotheses:

- `instance.continuous = false` — **gone**. `Composer.tsx:140` now reads
  `instance.continuous = true;` with the comment *"Continuous, unlike the
  original. One press means 'listen until I say stop', not 'listen to one
  sentence'"*. On the revision this task was briefed against (286 lines, old line
  104) it was `false`, and that genuinely produced "one utterance, then it stops".
- `onresult` concatenating non-final results — see §2, cause 1 for the precise
  reframe: it does not *duplicate*, it *replaces and loses*.

---

## 2. Ranked causes

Ranked by how well each explains "clicked, nothing happened", weighted by how
certain the evidence is. Confidence is stated per item; nothing here is padded.

### Cause 1 — CODE, certain. The dictation text is discarded on every recogniser restart

**Evidence.** The field is not appended to; it is rebuilt from a frozen prefix
plus the *live session's* whole result list:

```tsx
// Composer.tsx:145-151
instance.onresult = (event) => {
  const spoken = transcriptFrom(event);
  if (!spoken) return;
  setHeard(spoken);
  const prefix = baseText.current;
  setValue(prefix ? `${prefix} ${spoken}` : spoken);
};
```

```tsx
// speech.ts:182-190
export function transcriptFrom(event: SpeechResultEvent): string {
  let text = "";
  for (let index = 0; index < event.results.length; index += 1) {
    const result = event.results[index];
    const alternative = result?.[0];
    if (alternative) text += alternative.transcript;
  }
  return text.trim();
}
```

`baseText.current` is set exactly once, at the start of dictation:

```tsx
// Composer.tsx:212
baseText.current = value;
```

And the session is restarted on its own `onend` while the user still wants to
dictate:

```tsx
// Composer.tsx:183-190
instance.onend = () => {
  // A session that ended on its own is restarted while the user still
  // wants to dictate. ...
  if (!stopping.current && recognizer.current === instance) {
    try {
      instance.start();
      return;
    } catch {
```

`event.results` is the *current session's* list, and `resultIndex` exists
precisely because results are session-scoped. A restarted session therefore
starts a fresh list, so the next `onresult` computes `spoken` = only what was
said after the restart, and writes `baseText + that` — **rewriting the field
without the text that came before the restart**. Chromium ends a `continuous`
session after a run of silence regardless of the hint (the Lead's own module
comment in `useWakeListener.ts:19-24` says exactly this: *"continuous = true is a
hint, not a guarantee: Chromium ends the session after a few seconds of silence"*),
so the restart is the normal case, not an edge case.

Net behaviour on a machine where everything works: speak a sentence, pause to
think, speak another — the first one disappears. That is indistinguishable from
"it stopped listening".

**Confirm in 30 seconds.** In the app's DevTools console, run:

```js
const r = new webkitSpeechRecognition();
r.continuous = true; r.interimResults = true;
r.onresult = (e) => console.log("resultIndex", e.resultIndex, "len", e.results.length,
  [...e.results].map((x) => x[0].transcript).join("|"));
r.onend = () => console.log("END");
r.start();
```

Say "one two three", stop talking until `END` prints, then say "four". If the
second session logs `resultIndex 0 len 1 four`, the list is per-session and the
field is being wiped exactly as described. (Alternatively: dictate "one two
three", wait ten seconds in silence, say "four" — if the composer ends up holding
only "four", this is the bug.)

**Fix.** Make dictation append-only. Either fold the committed text into the base
at each restart:

```tsx
// in onend, before restarting
baseText.current = valueRef.current;   // value read from a ref, not the closure
```

or keep the transcript in a ref (`committed.current`) and render
`committed.current + liveSessionText`, never re-deriving the field from
`baseText`. Either way, `transcriptFrom` should also honour the session boundary
— it currently ignores `event.resultIndex` entirely (`speech.ts:184` iterates
from 0).

### Cause 2 — CODE, high. The on-device retry can strand the UI with a plugged microphone and no note

Three separate problems in one branch.

(a) `retry.start()` is not protected, unlike every other `start()` in the file:

```tsx
// Composer.tsx:169-177
const Recognition = getSpeechRecognition();
if (Recognition) {
  const retry = new Recognition();
  buildRecognizer(retry, true);
  recognizer.current = retry;
  setDictating(true);
  retry.start();          // <- throws straight out of an event handler
  return;
}
```

Compare the careful version in `begin()` (`Composer.tsx:227-233`), which wraps
`instance.start()` in `try/catch` and sets a note. The retry path has no such
guard, and the project's own typing says why it can throw:

```ts
// speech.ts:54-56
 * Setting it where there is no model makes `start()` fail, which is why it is
 * opt-in here rather than on.
```

If it throws, the note already shown is
`"That needed the browser's speech service. Switching to the on-device model — the first run downloads it."`
(`Composer.tsx:166-168`), `setDictating(true)` has already run (174), and the
exception escapes into `onerror`. The user sees the mic lit, a promise about a
model download, and then nothing at all — for as long as they leave the page open.

**And the retry can be reached with no model installed.** `onDevice` is decided
purely by the presence of two static functions:

```ts
// speech.ts:105-109
const withStatics = ctor as unknown as { available?: unknown; install?: unknown };
return typeof withStatics.available === "function" && typeof withStatics.install === "function";
```

I scanned the installed `msedge.dll` (154.0.4258.48) and **both the flag string
`"Speech Recognition with on-device model"` and the identifier `processLocally`
are present in a stable build**, while Microsoft's own documentation places the
*model* behind an `edge://flags` toggle on Canary/Dev only:

> "The local speech recognition model is available in Microsoft Edge Canary or
> Dev (version 150.0.4076 or later)."
> — [Convert speech to text with the SpeechRecognition API](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/speech-recognition-api)

> "In Microsoft Edge Canary or Dev, open a new tab … enter **Speech Recognition
> with on-device model** … select **Enabled**"
> — same page

So the API surface can exist while the model does not, which is exactly the case
`hasOnDeviceRecognition()` cannot detect, and exactly the case the retry assumes
away. Microsoft's documented sequence is `SpeechRecognition.available()` first,
then `install()`, then `start()` — the Composer calls none of them.

Corroborating — but weak — negative evidence: the Edge profile's
`profile.content_settings.exceptions.ondevice_languages_downloaded` group is
**empty**. That group covers on-device language packs generally (translation as
well as speech), so it does not prove the speech model is absent; it only says no
language pack of any kind has been recorded as downloaded in this profile.

(b) The aborted first recogniser clears the retry's bookkeeping. `onend` guards
the *restart* with an identity check but not the *cleanup*:

```tsx
// Composer.tsx:183-198
instance.onend = () => {
  if (!stopping.current && recognizer.current === instance) {
    try { instance.start(); return; } catch { }
  }
  recognizer.current = null;   // runs for the OLD instance even when the ref
  setDictating(false);         // now points at the RETRY
  setHeard("");
};
```

Sequence: `onerror` fires → `recognizer.current?.abort()` on instance A (164) →
ref set to instance B (173) → instance A's `end` event fires on the next task →
`recognizer.current === instance` is false, so it skips the restart and falls
through to lines 196-198, nulling the ref and setting `dictating = false`. The
retry keeps recording (its own `onresult` still writes to the field) but the
component no longer knows it exists: the mic button shows "not dictating" and
offers to start a *second* recogniser, and the unmount cleanup
(`Composer.tsx:258-264`, `recognizer.current?.abort()`) aborts nothing, so the
microphone indicator can stay on after the page is gone.

**Confirm in 30 seconds.** Allow dictation to fail once and watch the mic button:
if it lights up, the note says it is switching to the on-device model, and the
button then goes dark within a second or two while nothing further happens, both
(a) and (b) have fired. Console version: `new webkitSpeechRecognition()` →
`start()` → check `typeof SpeechRecognition.available` and
`typeof SpeechRecognition.install`; if they are `function`, this machine will
take the retry branch on any `network` error.

**Fix.** In order: (1) wrap the retry's `start()` in `try/catch` and set a real
note on failure; (2) gate the retry on `await SpeechRecognition.available({ langs: [lang], processLocally: true })`
returning `"available"` (or call `install()` and wait) instead of on the presence
of the functions; (3) make the cleanup branch conditional —
`if (recognizer.current === instance) { recognizer.current = null; setDictating(false); setHeard(""); }`.

### Cause 3 — ENVIRONMENT, high. Edge's recognition is a cloud round trip, and this machine's egress is filtered

This is the cause that decides whether "no cloud = no dictation" is true for this
user. **It is true for Edge on a stable build**, from primary sources:

- Microsoft, on the Edge policy that gates this API:
  > "Set whether websites can use the W3C Web Speech API to recognize speech from
  > the user. **The Microsoft Edge implementation of the Web Speech API uses Azure
  > Cognitive Services, so voice data leaves the machine.**"
  > — [SpeechRecognitionEnabled policy](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/speechrecognitionenabled)
- Microsoft's own developer page for local recognition states the network
  property of the *cloud* path by contrast:
  > "**Network independence:** Beyond the initial model download, there's no
  > network latency when using this API to convert speech"
  > — [SpeechRecognition API](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/speech-recognition-api)
- And the endpoint is in the installed binary. Strings extracted from
  `C:\Program Files (x86)\Microsoft\Edge\Application\154.0.4258.48\msedge.dll`:

  ```
  speech.platform.bing.com/speech/recognition/edge/interactive/v1?TrustedClientToken=    &language=    msSpeech
  /stt/speech/recognition/interactive/cognitiveservices/v1
  https://eastus-edge.tts.speech.microsoft.com/synthesize/health
  ```

  The recognition URL carries `&language=`, so the language tag the app sets is
  sent to the service, and it is a distinctively **Edge** path
  (`/speech/recognition/edge/interactive/v1`), which is the Edge-vs-Chrome
  difference in one string.

**What happens when it is unreachable.** MDN's enumeration (which mirrors the
spec's error list):

> `network` — "Network communication required for completing the recognition
> failed."
> `service-not-allowed` — "The user agent disallowed the requested speech
> recognition service …"
> — [SpeechRecognitionErrorEvent: error](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognitionErrorEvent/error)

A firewall, hosts-file entry, DNS block or captive/proxied network therefore
surfaces as `network`, and a policy (`SpeechRecognitionEnabled = 0`, or a build
without the service) surfaces as `service-not-allowed`. What the code does with
each is in `speech.ts:128-148`: `network` → *"Speech recognition needs a working
connection in this browser — the audio is sent to the browser's own service, not
to Xana."*; `service-not-allowed` → *"This browser will not run speech
recognition…"*. So a blocked cloud path is not silent any more — but the
recovery it attempts first is Cause 2.

**What I measured on this machine (mixed news, do not skip this).**

| Probe | Result |
|---|---|
| `GET https://speech.platform.bing.com/` direct from Node | **HTTP 400 in 914 ms** — the host answers |
| `CONNECT speech.platform.bing.com:443` through the aTrust proxy `127.0.0.1:12000` | **`HTTP/1.1 200 Connection established`** — the proxy permits it |
| `GET https://www.google.com/` direct | timeout after 6 s (blocked) |
| Node `dns.resolve4()` (c-ares) for the speech hosts and `www.google.com` | `ETIMEOUT`, while Windows' own resolver answered fine |
| `speech.platform.bing.com` A record via `Resolve-DnsName` | 150.171.28.10, 150.171.27.x |
| `www.google.com` A record via `Resolve-DnsName` | **69.171.235.22** (a Facebook netblock) plus Google ranges — DNS is being rewritten |

There is a Sangfor zero-trust agent on this machine (`aTrustService`,
`SangforPWEx`, `SangforSP` all **Running**), a system proxy
`ProxyEnable=1, ProxyServer=127.0.0.1:12000`, and the hosts file contains an
agent-injected line (`127.0.0.1 localhost.sangfor.com.cn` with the comment *"This
line is auto added by aTrustAgent"*). So the network *is* filtered — but the
specific Microsoft speech host is reachable both directly and by CONNECT. I could
**not** verify that Edge's actual recognition request succeeds, because I cannot
run a browser here. That is the single most valuable 30 seconds the user can
spend (§5).

**Fix.** Two independent things:
1. Give dictation a path that does not need Microsoft: the local Whisper sidecar
   already in this repo (`python/xana_stt.py`, `POST /transcribe` on
   `127.0.0.1:4319`). §4 answers whether that is viable — it is, with one caveat
   about containers.
2. If the cloud path is wanted, the endpoint is a single host: allow
   `speech.platform.bing.com:443` through aTrust/proxy and confirm no
   `SpeechRecognitionEnabled=0` policy (there is none on this machine — see §3).

### Cause 4 — ENVIRONMENT, medium, unverified. The default capture device may be a virtual one that carries silence

The registry lists only two ACTIVE capture endpoints, and one of them is not
hardware:

```
1  name=麦克风阵列                      (Microphone Array — Intel Smart Sound / Realtek)  xana-encoding-ok
1  name=麦克风                          (Voice Changer Virtual Audio Device (WDM))       xana-encoding-ok
268435457 name=立体声混音                (Stereo Mix — loopback, not an input)            xana-encoding-ok
8  name=Headset Microphone              (UNPLUGGED)
```

`麦克风` <!-- xana-encoding-ok: the device's real Windows name, quoted --> at `DeviceState = 1` is **`Voice Changer Virtual Audio Device (WDM)`** —
a virtual driver, not a microphone. If Windows' default input device is that one
(as voice-changer apps commonly make themselves), Chromium opens it, receives
silence, and the recogniser eventually reports `no-speech` or `network` with
nothing useful to say about why. This is the classic "the mic opens and hears
nothing" cause and it produces no diagnostic anywhere in the app.

**Confirm in 30 seconds.** Settings → System → Sound → **Input**: read the
selected device's name, and speak — the level meter must move. If it does not,
no browser API can transcribe anything.

**Fix.** Set Windows' input to `麦克风阵列` <!-- xana-encoding-ok: real device name -->, then in Edge
`edge://settings/content/microphone` confirm `http://127.0.0.1:4310` is allowed.
(The app's `getUserMedia` probe, `Composer.tsx:243-254`, does surface
`NotFoundError`/`NotReadableError` properly — `speech.ts:163-179` — but a device
that opens and returns silence is not an error at all, so it cannot be caught in
code.)

### Cause 5 — CODE, medium. The language tag is inherited, and the error it would produce has no case

```tsx
// Composer.tsx:135
instance.lang = navigator.language || "en-US";
```

`lang` is passed through unvalidated, and Microsoft's own example for this API
pins a real locale instead:

```js
recognition.lang = "en-US";
```
— [SpeechRecognition API](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/speech-recognition-api)

On this machine `navigator.language` is very likely the bare string **`"en"`**.
Edge's profile carries `intl.accept_languages = "en,zh-CN,en-GB,en-US"` and
`selected_languages` the same; Chromium derives `navigator.languages` /
`navigator.language` from that preference, and the profile's own Read Aloud
preference is `{"language":"en","voiceURI":"Microsoft Aria Online (Natural) -
English (United States)"}`. The OS is genuinely mixed: `MachinePreferredUILanguages
= zh-CN` while the user locale (`HKCU\Control Panel\International\LocaleName`) is
`en-US`. **Inference, not observation** — I could not read `navigator.language`
in a browser from here.

Why it matters even so: the endpoint URL is
`.../edge/interactive/v1?TrustedClientToken=…&language=…`, so an unsupported tag
is decided server-side, and the failure MDN documents for it is
`language-not-supported` — *"The user agent does not support the language
specified in the `lang` attribute … The set of supported languages is
browser-dependent, and there is no way to programmatically determine from
front-end code the languages a user's browser supports"*
([error property](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognitionErrorEvent/error)).
That value has **no case** in `dictationFailure` (`speech.ts:129-147`), so it falls
to `default: return "Dictation stopped."` — the one message that names nothing the
user can act on. The same gap exists in the wake-word matcher, where every error
other than four named ones becomes `error-other` and is retried four times before
giving up with *"Listening kept failing, so I stopped."*
(`wake-word.ts:528-544`, `485-525`).

**Confirm in 30 seconds.** In the console: `navigator.language` and
`navigator.languages`. If it prints `en`, that is what is being sent as the
recognition language.

**Fix.** Default to `en-US` (not `navigator.language`), make it a Voice setting,
and add `language-not-supported` plus `bad-grammar`/`phrases-not-supported`
cases to `dictationFailure`. Cheap, and it converts the app's most useless
sentence into a real instruction.

**RESOLVED — and this was the reported symptom.** The fix above was applied, and
then made general, because "default to `en-US`" was right about the value and
wrong about the shape: a bare language is only one of the ways a tag can fail.

| What was prescribed | Where it lives now |
|---|---|
| Default to `en-US` instead of `navigator.language` | `speech-language.ts` — the tag is normalised (case, `_`/`-`, `;q=`), and a bare language is resolved to a regional model. `en` becomes `en-US`; a tag outside the curated list is still sent as-is, because MDN is explicit that the supported set cannot be read from front-end code |
| Make it a Voice setting | `voice.speechLang`, in Settings → Voice → Dictation language, with the resolved value and its provenance shown beside it. An explicit choice beats the inference and gets no fallback ladder |
| `language-not-supported` in `dictationFailure` | Done, and it now names the tag that was refused and points at the setting rather than at the browser's language menu |
| `bad-grammar` / `phrases-not-supported` | Done, with their own sentence: nothing in Xana sends a grammar, so those mean an extension is substituting its own recognition configuration |
| — | **Added:** a refusal is retried down a finite ladder of other regional variants of the *same* language, never a different one, and never a tag already refused. The app chose the tag, so correcting it is the app's job |
| — | **Added:** the Composer, the wake listener and this page's recogniser all take their four shared options from `configureRecognizer`, so a language can no longer be set in one place and not another |

`npm run verify:speech` drives the decision through the reported case
(`["en", "zh-CN", "en-GB", "en-US"]` → `en-US`), the ladder's finiteness, and the
rule that a fallback never changes language. MEMORY.md §21 has the reasoning;
§22 records the second half of the report — the shell never read the saved
transcription setting until the settings panel had been opened, so a saved
"transcribe on this machine" was ignored on every fresh page load and this
browser's recogniser was used anyway.

### Refuted — do not spend time here

| Hypothesis | Verdict | Evidence |
|---|---|---|
| Windows microphone privacy blocks Edge | **Refuted** | `HKLM\…\CapabilityAccessManager\ConsentStore\microphone` → `Value = Allow`; the `NonPackaged` entry for `…Microsoft\Edge\Application\msedge.exe` exists with no explicit deny. |
| Edge site permission for the app is blocked | **Refuted** | `…\Edge\User Data\Default\Preferences` → `profile.content_settings.exceptions.media_stream_mic["http://127.0.0.1:4310,*"].setting = 1` (**allow**), `last_modified` = 2026-09-30T03:17:56Z, `last_used` = **2026-09-30T03:18:19Z** — the microphone *was* opened for this origin, ~23 s after the permission was recorded (now = 2026-10-01T22:50+08:00). `not-allowed` is therefore not the explanation. |
| An enterprise policy disables speech recognition | **Refuted** | `HKLM\SOFTWARE\Policies\Microsoft\Edge` contains only `LocalNetworkAccessAllowedForUrls`; no `SpeechRecognitionEnabled`, no `AudioCaptureAllowed`, nothing under `HKCU`. |
| `http://` (not `https://`) breaks the microphone | **Refuted** | `127.0.0.1` is a potentially trustworthy origin, so the page is a secure context; Edge treats it as a normal origin and stores an ordinary permission for it. |
| `continuous = false` ends dictation after one sentence | **True of the briefed revision, fixed now** | `Composer.tsx:140` is `instance.continuous = true;` in the current revision; the old 286-line revision had `false` at line 104. |
| `onresult` duplicates text by concatenating non-final results | **Refuted as duplication; confirmed as data loss** | Because the field is rewritten as `baseText + transcriptFrom(event)` (`Composer.tsx:149-150`) with `baseText` frozen, interim updates replace rather than append — no duplication. The same mechanism deletes text across a restart: Cause 1. |
| `transcriptFrom` ignoring `resultIndex` is harmless | **Refuted for `continuous = true`** | `speech.ts:184` iterates from index 0 and ignores `event.resultIndex`; harmless for a single-session one-shot, wrong the moment sessions restart. Cause 1. |

---

## 3. Edge + Web Speech API: what the primary sources say

**Does Edge's `SpeechRecognition` need a network round trip?** Yes, on the
default and on stable. Microsoft documents its own implementation as using Azure
Cognitive Services and states plainly that *"voice data leaves the machine"*
([policy doc](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/speechrecognitionenabled)).
The only network-free option is the on-device model, which Microsoft documents as
Canary/Dev-only and gated behind `edge://flags` → *Speech Recognition with
on-device model*
([developer doc](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/speech-recognition-api)).

**Which service?** Microsoft's — not Google's. The installed Edge 154 binary
contains the recognition path
`speech.platform.bing.com/speech/recognition/edge/interactive/v1?TrustedClientToken=…&language=…`,
plus the Azure-style path `/stt/speech/recognition/interactive/cognitiveservices/v1`
(strings extracted from `msedge.dll`, above). This is the Edge-vs-Chrome
distinction: the same `webkitSpeechRecognition` identifier routes to different
vendors' services depending on the build, which is why a Chrome-shaped
assumption ("it goes to Google") is wrong here — and why a hosts-file or
proxy block aimed at the wrong vendor would look like magic.

**Failure modes when unreachable.** MDN's list is the citable enumeration
([error property](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognitionErrorEvent/error)):
`network` (the round trip failed), `service-not-allowed` (the service is
disallowed), `not-allowed` (permission/security/privacy), `audio-capture` (capture
failed), `no-speech`, `language-not-supported`, `aborted`. The app maps all of
these in `speech.ts:128-148` except `language-not-supported`.

**`start()` behaviour.** MDN documents `InvalidStateError` only for the
`start(audioTrack)` overload with a track that is not `audio`/`live`
([start()](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/start)).
It does **not** document a throw for the no-argument form — so the project's
comment in `wake-word.ts:459-461` ("Chromium throws `InvalidStateError` when a new
recogniser starts in the same tick as the previous one ending") is browser
behaviour, not spec, and should be treated as a defensive assumption rather than
a documented guarantee. The `try/catch` around `start()` in the current Composer
(`227-233`) and in `useWakeListener.ts:323-330` is correct to have in any case.

**This machine, checked directly:** no policy blocks it (§2, refuted table), the
endpoint host answers (HTTP 400 in 914 ms), and the proxy permits CONNECT to it.
The residual question is whether the browser's *specific* request completes —
only DevTools can answer that.

---

## 4. Is `MediaRecorder` + `getUserMedia` viable in Edge 154, without the Google/Microsoft speech service?

**Yes — and it is the right fallback.** `getUserMedia` + `MediaRecorder` is a
standard, `MediaRecorder` is Baseline "widely available", and
`MediaRecorder.isTypeSupported()` is the API that answers the mime-type question
per browser ([isTypeSupported()](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static)):

```js
MediaRecorder.isTypeSupported("audio/webm;codecs=opus")   // the one to check first
MediaRecorder.isTypeSupported("audio/webm")
MediaRecorder.isTypeSupported("audio/mp4")
MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
```

Chromium's `MediaRecorder` default for an audio-only stream is
`audio/webm;codecs=opus`, which is also the example MDN leads with
(`"audio/webm;codecs=opus"` in the doc's own `types` array). It is the mime type
to try first, with `audio/webm` as the fallback for a browser that refuses the
`codecs` parameter.

**What I could and could not verify about Edge 154 specifically.** `audio/webm`
and `MediaRecorder` are both present as strings in the installed `msedge.dll`,
and `audio/webm` is in `ffmpeg.dll`; the fully-formed literal
`audio/webm;codecs=opus` is **not** present as a contiguous string, which is
expected because Chromium assembles codec-qualified types at runtime. That is
consistent with support but is not proof. The 10-second proof is to run the
`isTypeSupported` lines above in the user's Edge — that is the check I would
trust, and I could not run it here.

**Two things that make this fallback work with the sidecar already in this repo**
(`python/xana_stt.py`):

1. `POST /transcribe` already accepts what `MediaRecorder` produces:
   `AUDIO_TYPES` covers `audio/wav`, `audio/webm`, `audio/ogg`, `audio/mp4`,
   `audio/m4a`, and `audio_kind()` splits on `;` — so a blob typed
   `audio/webm;codecs=opus` is classified as `webm` and accepted
   (`xana_stt.py:97-108, 615-620`).
2. But the *decode* side has a sharp edge. With the `faster-whisper` backend the
   container is decoded through the backend's own `decode_audio`
   (`xana_stt.py:936-947`), which needs PyAV installed; with the `openai-whisper`
   backend non-WAV input is **refused by design**:
   `"the openai-whisper fallback reads WAV only. Install faster-whisper for %s, or send audio/wav."`
   (`xana_stt.py:1042-1050`). And the file's own comment states the intended
   client shape: *"only used on a path the browser client does not normally take
   (**it sends 16 kHz mono PCM**)"* (`xana_stt.py:987-989`).

**Recommendation.** Send **16 kHz mono WAV**, not `MediaRecorder`'s webm/opus, as
the primary path: capture raw PCM (an `AudioWorklet` tap on the `getUserMedia`
stream, resampled to 16 kHz, wrapped in a 44-byte WAV header in the browser) and
`POST` it as `Content-Type: audio/wav`. That matches what the sidecar says it
expects, removes the PyAV/ffmpeg dependency from the critical path, works with
either Whisper backend, and lets you drop `MediaRecorder` entirely. Keep
`MediaRecorder` as the fallback for browsers where the worklet is unavailable,
and feature-detect with `isTypeSupported` before choosing.

Two implementation notes that will bite otherwise:

- The sidecar is on a **different origin** (`127.0.0.1:4319` vs `127.0.0.1:4310`),
  so the request is cross-origin and `Content-Type: audio/wav` is not a
  CORS-safelisted value — a preflight `OPTIONS` **will** happen. The sidecar
  handles it (`do_OPTIONS`, `Access-Control-Allow-Headers: Content-Type`,
  `xana_stt.py:1187-1190, 1132-1152`) and reflects a loopback `Origin` only, which
  is correct. Note the `Origin` the browser sends is
  `http://127.0.0.1:4310`, which matches `LOOPBACK_ORIGIN`
  (`xana_stt.py:92`) — good. Do not proxy it through Next unless you want to
  re-do the CORS work for nothing.
- Chromium's newer **Local Network Access** permission model is present in this
  profile (`local_network_access` and `loopback_network` content-setting groups,
  plus a machine policy `LocalNetworkAccessAllowedForUrls`) but both groups are
  **empty**, and a loopback page requesting a loopback address is not a
  more-public→more-private downgrade, so no prompt is expected. Worth watching,
  not worth designing around.

---

## 5. Where a wake-word listener belongs, and what it must not fight

The listener is already mounted and it is in a defensible place:

```tsx
// page.tsx:127-135
const wake = useWakeListener({
  enabled: wakeEnabled,
  phrases: wakePhrases,
  paused: thinking || speaking,
  onSubmit: (text) => { nudge(); void send(text, "voice"); },
});
```

with `thinking` defined as `presence === "thinking" || sending` (`page.tsx:68`),
`speaking` as its own state cleared from the utterance's `onend`/`onerror`
(`page.tsx:106-118`, via the new `onDone` in `speech.ts:245-278`), and the
indicator rendered above the composer (`page.tsx:283-289`).

**Is `page.tsx` the right home?** For today's app, yes — it is the shell: it owns
`useXana()` (`lifeState, analysis, ready, presence, messages, engine, sending,
rippleKey, greet, notice, send, act, refreshContext`), it calls
`useShellSettings()` (which is *not* a provider — it is a hook called once here,
`page.tsx:53`), and `<Settings>` / `<Cave>` are mounted as siblings with `open`
props rather than conditionally, so nothing in the tree unmounts while the panel
or the cave opens and closes. The listener therefore survives everything that
happens inside this route.

**The durable home, if a second route ever appears:** a client component rendered
from `src/app/layout.tsx` as a sibling of `{children}` (`layout.tsx:67-81`).
`layout.tsx` is a *server* component, so this means either a small
`"use client"` wrapper that takes its inputs as props, or — the honest version —
hoisting `useXana`/`useShellSettings` into a provider so a layout-level client
component can reach them. That is a real refactor, not a move, and it buys
nothing today (there is exactly one page: `src/app/page.tsx`). Do not mount it
in `Composer` (it would be re-created with the composer and would race the
dictation recogniser for the microphone) and do not mount it in `Settings` (its
lifecycle is tied to a panel).

**Real names to wire against.**

| Need | Name | Where |
|---|---|---|
| The hook | `useWakeListener({ enabled, phrases, paused, onSubmit })` | `useWakeListener.ts:107-112` |
| Its state | `{ state: WakeState, note, active, draft, retry }` | `useWakeListener.ts:79-89` |
| `WakeState` | `"off" \| "starting" \| "armed" \| "listening" \| "paused" \| "failed"` | `useWakeListener.ts:67` |
| The switch and the phrase list | `shell.voice.wakeEnabled`, `shell.voice.wakePhrases` | `useShellSettings.tsx:142-143`, `lib/settings/types.ts:98,107` (default `false`, store `store.ts:137-139`) |
| Her speaking state | `speaking` (local state) + `speak(..., { onDone })` | `page.tsx:106-118`, `speech.ts:245-278` |
| Her thinking state | `thinking = presence === "thinking" || sending` | `page.tsx:68` |
| Sending a hands-free request | `send(text, modality)` with `modality: "text" \| "voice"` | `page.tsx:133`, `ComposerProps.onSubmit` (`Composer.tsx:60`) |
| The indicator | `<WakeIndicator state draft note onRetry onDismiss />` | `WakeIndicator.tsx:37-47` |

**Three conflicts that are still live.**

1. **`paused` cannot see dictation.** `Composer`'s `dictating` is component-local
   (`Composer.tsx:76`) and is not part of `paused` (`page.tsx:130`). The
   handover is done by *writing the user's setting to disk*:

   ```tsx
   // page.tsx:296-298
   onTakeMicrophone={() => {
     if (wakeEnabled) void shell.controller.save({ voice: { wakeEnabled: false } });
   }}
   ```

   Two problems. It **persists** "always-listening off" as a side effect of
   pressing the mic button — the user's preference is silently changed and
   written to `data/settings.json`, and hands-free does not come back when
   dictation stops. And it is **not ordered**: `save()` is a network round trip
   while `startDictation()` continues synchronously to `begin()` and
   `instance.start()`, so the wake recogniser is still holding the microphone when
   dictation opens it — the opposite of the comment above it ("the button takes it
   over first"). Give `WakeListener` a synchronous verb
   (`stop: () => void`, or `pause()`) and call that from `onTakeMicrophone`; leave
   the preference alone. Alternatively lift `dictating` out of `Composer` via an
   `onDictatingChange` prop and fold it into `paused`, which also fixes it without
   a new verb.

2. **Both recognisers are the same cloud API.** A wake word built on
   `SpeechRecognition` inherits every property of Cause 3: it is Edge-only, it
   needs Microsoft's service, and it stops working when the network does. That is
   a design decision, not a bug — but it means *the wake word cannot be the
   offline feature*. The only architecture in which "always listening" works with
   no network is `getUserMedia` → local STT (the sidecar) → the wake matcher,
   and the matcher is already portable: `wake-word.ts` has a line-for-line Python
   port with fixtures in `xana_stt.py` (`match_wake`, `WAKE_FIXTURES`) plus
   `scripts/check-stt.mjs` to keep the two from drifting. If that is the
   direction, the listener should own the microphone permanently and the
   `Composer` mic button should become a *session* control over the same stream,
   not a second `SpeechRecognition`.

3. **Echo.** `paused` covers `speaking` (`page.tsx:130`), and `speaking` is now
   cleared from the utterance's own `onend`/`onerror` rather than a timer
   (`speech.ts:265-274`) — that is correct and worth keeping. One caveat:
   `speak()` calls `synth.cancel()` and returns (253-276); `stopSpeaking()`
   (`speech.ts:280-282`) cancels without firing the callback, so a page that
   cancels her mid-sentence via `stopSpeaking()` relies on the utterance's
   `onerror`/`onend` firing to un-pause the listener. The `finished` latch makes
   it fire at most once, but if a build does not fire either event after
   `cancel()`, `speaking` stays `true` and the wake listener stays paused
   forever. Cheap insurance: have `stopSpeaking()` accept the same `onDone`, or
   set `speaking = false` in the `stopSpeaking()` call site in `page.tsx:139-141`.

---

## 6. What the user must check

Ordered so that each step rules out a cause above.

1. **Does Windows hear anything at all?** Settings → **System → Sound → Input**.
   The device must be **麦克风阵列 <!-- xana-encoding-ok: real device name --> (Microphone Array)**, not `麦克风 <!-- xana-encoding-ok --> (Voice Changer
   Virtual Audio Device (WDM))`. Speak and watch the level meter — it must move.
   (Cause 4.)
2. **Is the app allowed the microphone in Edge?** Visit `edge://settings/content/microphone`
   and confirm `http://127.0.0.1:4310` is under **Allowed**. While the mic is on,
   the microphone icon in the address bar must be present. (Already verified as
   allowed on this machine; re-check after any Edge profile reset.)
3. **Is the OS allowing desktop apps the microphone?** Settings → **Privacy &
   security → Microphone** → *"Let desktop apps access your microphone"* must be
   **On**, and `Microsoft Edge` must appear under the app list with access on.
   (Verified `Allow` in the registry on this machine.)
4. **Is recognition reaching Microsoft?** Open the app with DevTools (F12) →
   **Network**, filter `recognition`, press the mic, speak. Expected:
   a request to `speech.platform.bing.com/speech/recognition/edge/interactive/v1`.
   - No request at all → the browser never started recognition (Cause 2).
   - Request failed / `(failed)` / `ERR_*` → the network path (Cause 3).
   - Request `200` and no text → the audio or the language (Causes 4, 5).
   - Filter `console` too: the app writes nothing there, so add the one-liner
     from Cause 1 to see results directly.
5. **What language is being sent?** In the DevTools console: `navigator.language`.
   If it is not `en-US` (or whatever the user actually speaks), that is Cause 5.
6. **Is the on-device model even present?** In the console:
   `typeof SpeechRecognition.available`, `typeof SpeechRecognition.install`, and
   `SpeechRecognition.available({ langs: ["en-US"], processLocally: true })`.
   The app treats the first two existing as "on-device is available"
   (`speech.ts:105-109`); Microsoft's docs put the *model* behind
   `edge://flags` → **Speech Recognition with on-device model** → Enabled on
   Canary/Dev only. If `available()` says `downloadable`, the model is not
   installed and the retry path in Cause 2 cannot work.
7. **Is anything above the browser rewriting the network?** This machine runs
   Sangfor aTrust (`aTrustService`, `SangforPWEx`, `SangforSP`) with a system
   proxy at `127.0.0.1:12000`, an agent-injected hosts entry, and DNS answers for
   `www.google.com` pointing at a Facebook netblock. If step 4 shows a failure,
   `speech.platform.bing.com:443` has to be allowed through that agent — it
   answers from a plain client, so the host itself is not down.
8. **Enterprises only:** `HKLM\SOFTWARE\Policies\Microsoft\Edge` must not contain
   `SpeechRecognitionEnabled = 0` (or `AudioCaptureAllowed = 0`). There is none on
   this machine.

---

## 7. Uncertain / could not verify

Stated plainly, because a diagnosis that hides its gaps is a guess wearing a
table.

- **I could not run a browser.** A Chromium browser cannot start in this sandbox
  (no process creation, no named pipes), and Edge exits `0x80000003`; that is
  established already, not re-derived here. Every statement about *runtime*
  behaviour of `SpeechRecognition` in this Edge build is therefore either from
  documentation, from the binary's strings, or explicitly labelled an inference.
- **Whether Edge's recognition request actually succeeds on this machine.** The
  host answers (HTTP 400 in 914 ms) and the proxy permits CONNECT, but the
  browser's own request — with its `TrustedClientToken`, headers, and whatever
  aTrust does to that TLS stream — was not observed. Step 4 of §6 is the test.
- **Whether `SpeechRecognition.available`/`install` are exposed in stable Edge
  154.** The flag string and `processLocally` are in `msedge.dll`; whether the
  feature is *enabled by default* in a stable channel build is not something I can
  determine from strings or from a doc that says Canary/Dev. Consequence: I cannot
  say whether the retry in Cause 2 is dead code on this machine or a live trap.
  One console line settles it.
- **Whether `navigator.language` is `"en"` in this Edge.** I inferred it from
  `intl.accept_languages = "en,zh-CN,en-GB,en-US"` in the profile. I did not read
  it from a running browser, and I did not fetch a primary source stating that
  Chromium's `navigator.language` is derived from that preference — so treat the
  value as likely, not certain.
- **Whether `audio/webm;codecs=opus` is accepted by Edge 154's `MediaRecorder`.**
  `audio/webm` and `MediaRecorder` are in the binary; the codec-qualified literal
  is not (expected, since it is assembled at runtime). MDN's Baseline claim and
  example support it. `MediaRecorder.isTypeSupported(...)` in the user's Edge is
  the only real answer, and it takes ten seconds.
- **Whether a restarted `SpeechRecognition` session resets `event.results`.**
  Cause 1 rests on that (session-scoped results, hence `resultIndex`). It is how
  the API is specified and implemented in Chromium as far as I know, but I did not
  fetch the spec clause and could not test it. The 30-second console experiment in
  Cause 1 decides it, and the fix is correct either way — an append-only design
  cannot lose text regardless.
- **The exact error Chromium raises when the Windows privacy toggle is off.** MDN
  gives `not-allowed` for "security, privacy or user preference" and
  `audio-capture` for a failed capture; which one a blocked OS microphone
  produces, I did not verify — on this machine it is moot, because both the OS
  setting and the Edge permission are permissive.
- **Chrome's counterpart endpoint.** I tried to compare against an installed
  `chrome.dll` to prove the Edge-vs-Chrome service difference from both binaries;
  no `chrome.dll` exists under the standard `Program Files`/`Program Files (x86)`
  paths on this machine, so I have Edge's binary evidence only. For Chrome, the
  network dependency of `SpeechRecognition` is asserted from general knowledge
  and **not** from a fetched primary source — do not quote me as having verified
  Chrome.
- **Two probe results are weaker than they look.** My first hand-rolled
  `CONNECT` tunnel through the aTrust proxy returned `ECONNRESET` while a raw
  CONNECT to the same host returned `HTTP/1.1 200 Connection established`; the
  reset is an artifact of my minimal TLS-over-CONNECT client, not evidence that
  the proxy blocks the host. And Node's c-ares DNS queries time out for hosts that
  Windows' resolver resolves fine — a property of this filtered environment, not
  of Xana.
- **The Microsoft Edge endpoint-allowlist page** (`microsoft-edge-security-endpoints`)
  appeared in search results and would have named the speech hosts officially; I
  did not fetch it, so it is not cited as a source here. The endpoint claim in §3
  rests on the strings in `msedge.dll`.

---

## 8. Machine evidence, so it can be re-taken

Everything below was read, not assumed. Read-only commands; no source file was
modified by this diagnosis.

| Fact | Where it came from |
|---|---|
| Edge `154.0.4258.48` (the brief said `.37` — it has updated since) | `HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{56EB18F8-…}\pv` |
| Mic allowed for the app, and used | `%LOCALAPPDATA%\Microsoft\Edge\User Data\Default\Preferences` → `profile.content_settings.exceptions.media_stream_mic` |
| `intl.accept_languages = "en,zh-CN,en-GB,en-US"` | same file |
| No on-device language pack downloaded | same file → `…exceptions.ondevice_languages_downloaded` (empty) |
| No Edge policy blocks speech | `HKLM\SOFTWARE\Policies\Microsoft\Edge`, `HKCU\…` |
| OS microphone consent `Allow`; Edge desktop-app entry present without a deny | `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone` (+ `\NonPackaged`) |
| Only two ACTIVE capture endpoints; one is `Voice Changer Virtual Audio Device (WDM)`; headset UNPLUGGED | `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture\*` (`DeviceState`, friendly name from the endpoint `Properties`) |
| `MachinePreferredUILanguages = zh-CN`, user locale `en-US` | `HKCU\Control Panel\Desktop\MuiCached`, `HKCU\Control Panel\International` |
| Sangfor aTrust running; system proxy `127.0.0.1:12000`; agent-injected hosts line | `Get-Service`, `HKCU\…\Internet Settings`, `C:\Windows\System32\drivers\etc\hosts` |
| `speech.platform.bing.com` reachable (HTTP 400, 914 ms), CONNECT allowed, `www.google.com` blocked/timeout, DNS rewritten | Node `https`/`net` probes from this machine, `Resolve-DnsName` |
| Recognition endpoint, on-device flag string, `processLocally`, `audio/webm` | strings extracted from `msedge.dll` 154.0.4258.48 |

### Sources fetched (only these are cited)

- [Microsoft Edge Browser Policy Documentation — SpeechRecognitionEnabled](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/speechrecognitionenabled) — *"The Microsoft Edge implementation of the Web Speech API uses Azure Cognitive Services, so voice data leaves the machine."*
- [Convert speech to text with the SpeechRecognition API — Microsoft Edge Developer documentation](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/speech-recognition-api) — on-device model on Canary/Dev 150.0.4076+, the `edge://flags` toggle, `processLocally`, `available()`/`install()`, `lang = "en-US"`, and the network-independence contrast.
- [SpeechRecognitionErrorEvent: error property — MDN](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognitionErrorEvent/error) — the error enumeration and each value's meaning.
- [SpeechRecognition: start() method — MDN](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/start) — `start()` and its documented exception.
- [MediaRecorder: isTypeSupported() static method — MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static) — `isTypeSupported`, Baseline availability, and `audio/webm;codecs=opus`.
