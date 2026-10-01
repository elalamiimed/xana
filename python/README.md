# Xana's local speech-to-text

Xana's microphone button can transcribe what you say on this machine instead
of sending it to the browser's speech service. That is what this folder is: a
small program that listens on your own computer, turns speech into text with
Whisper, and hands the text back to Xana.

**None of this is required.** If the service is not running, Xana falls back to
the browser's own speech recognition, and typing always works. This is an
upgrade, not a dependency.

Why you might want it:

- It works offline, so it does not stop when the network does.
- No API key, no account, nothing uploaded.
- It keeps listening the way a microphone should, instead of the browser's
  service going quiet after a pause.

---

## Setting it up

Two commands, once. In a terminal, from the folder that contains Xana:

```
cd python
pip install faster-whisper
```

That is the engine. The first time you actually transcribe something, it also
downloads the speech model (a few hundred MB, once) — **that download needs
internet**; nothing else here does. After it finishes, transcription works with
the network cable unplugged.

If `pip` is not recognised, use `python -m pip install faster-whisper`.

---

## Running it

```
cd python
python xana_stt.py
```

Or, if you would rather not think about Python's command name:

```powershell
powershell -ExecutionPolicy Bypass -File python\serve.ps1
```

Leave that window open while you use Xana. It prints one line per request, and
`Ctrl+C` stops it.

Check it is healthy by opening <http://127.0.0.1:4319/health> in a browser. You
want to see `"ready": true`. If it says `false`, the `reason` field says what is
missing, in plain words.

---

## Settings

All of these are environment variables, so they work from a terminal or from a
shortcut. Defaults are in brackets.

| Variable | What it does |
|---|---|
| `XANA_STT_PORT` | The port to listen on. `[4319]` |
| `XANA_STT_HOST` | The address to bind. `[127.0.0.1]` — see the warning below |
| `XANA_STT_MODEL` | Which Whisper model: `tiny`, `base`, `small`, `medium`, `large-v3`. `[base]` |
| `XANA_STT_BACKEND` | `auto`, `faster-whisper` or `whisper`. `[auto]` picks faster-whisper if it is installed |
| `XANA_STT_MODEL_DIR` | Where the downloaded model is kept. `[%LOCALAPPDATA%\xana-stt\models]` |
| `XANA_STT_VAD` | Set to `0` to turn off silence trimming. `[1]` |

Bigger models are more accurate and slower. `base` is the right place to start
on a laptop; `small` is a noticeable step up if you have the patience.

**On `XANA_STT_HOST`:** leave it alone. It defaults to loopback, which means
only this computer can reach the service. Setting it to `0.0.0.0` lets a phone
on your network post audio here — and lets anything else on that network do the
same, with no password. The service prints a loud warning when you do it, and
the warning is not decorative.

---

## Troubleshooting

| What you see | What it means |
|---|---|
| `/health` says `"backend": "none"` | No engine is installed. Run `pip install faster-whisper`. |
| `/health` says the model is not downloaded | It has not been fetched yet. Transcribe something once with internet connected, or run the download ahead of time: `python xana_stt.py` and then use the mic. |
| `/health` says `"ready": false` with a load error | The model files are there but unusable — usually a half-finished download. Delete the folder named in `XANA_STT_MODEL_DIR` and let it download again. |
| `/health` says the model is still loading | It is loading. Ask again in a second. |
| `Could not bind 127.0.0.1:4319` | Something else owns that port. Set `XANA_STT_PORT=4320` and restart. |
| Xana still does not use it | The app checks `/health` before it decides, so the service has to be running *and* ready. Look at the service window — if there are no requests when you press the mic, the app is not reaching it. |
| Everything works but speech is wrong | Try `XANA_STT_MODEL=small`. `base` is fast and approximate. |

The service keeps a transcript of what it heard only for as long as it takes to
answer: the audio in a request is held in memory and handed to the engine as a
stream, so nothing is written to a temporary file and nothing survives the
reply. The only thing that touches the disk is the model itself, in
`XANA_STT_MODEL_DIR`. The log is one line per request and holds no audio.

---

## For the curious: what the two routes promise

`GET /health` answers 200 with `ok`, `service`, `version`, `backend`, `model`,
`ready` and `reason`. `ready` is true only when an engine is importable **and**
a model actually loaded — it never claims to be ready when it is not, which is
what lets the app trust it. `reason` is a short sentence when it is not ready,
and an empty string when it is.

`POST /transcribe` takes raw audio bytes (not a form upload) with a
`Content-Type` of `audio/wav`, `audio/webm`, `audio/ogg` or `audio/mp4`, and
answers with `text`, `language`, `durationMs`, `backend` and `model`. Bodies
over 10 MB are refused with 413. Audio the engine cannot decode is refused with
415. A transcription that produced nothing — silence, or a corrupt file — is
`{"text": ""}` with status 200, because "I heard nothing" is a normal answer
from a microphone and a 500 is not. A response that is not empty carries an
extra `error` field saying why.

Requests are accepted from a page on this machine only: the CORS header
reflects `http://127.0.0.1:*` and `http://localhost:*` origins and nothing
else, so a website you happen to have open cannot read your transcripts back
out of a service running on your own computer.

---

## Testing it

```
python xana_stt.py --selftest        # the HTTP contract, no model or mic needed
python xana_stt.py --wake-selftest   # the wake-word matcher, no browser needed
node scripts/check-stt.mjs           # both of the above, plus static checks
```

`--selftest` starts a server on a throwaway port, asserts every promise above,
and exits non-zero if one of them stops being true. It runs with no model
installed and no network.

**What that does not prove.** There is no test here that runs Whisper on real
speech: that needs an engine and a multi-hundred-megabyte model, and the
machine this was written on has neither. The contract around the recogniser is
verified; the recogniser itself is verified by you, the first time you speak
into it.

---

## If you prefer a different engine

```
pip install openai-whisper
```

The service prefers `faster-whisper` when both are present, because it is
several times quicker on a CPU. The `openai-whisper` fallback reads WAV only —
for any other container it answers 415 and says so, rather than shelling out to
`ffmpeg`, which this program never does.
