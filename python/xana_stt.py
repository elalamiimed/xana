#!/usr/bin/env python3
"""
Xana's local speech-to-text sidecar.

WHY THIS EXISTS

The mic button used the browser's own speech service. That service is not
local, it is not available in every browser, and it stops listening after a
pause, which is why the button "does not listen". This is the alternative: a
small HTTP service, bound to loopback, that transcribes audio on this machine
with Whisper, so there is no key, no upload and no browser speech service in
the path at all.

WHAT IT PROMISES

  * /health never says ready:true unless a backend is importable AND a model
    actually loaded. When it cannot work it says so, and names the command that
    fixes it. That is the whole reason the route exists: the app asks before it
    decides whether to use this service or fall back.
  * /transcribe never answers 500. A transcription that fails is an empty
    string, because "heard nothing" is a legitimate answer from a microphone
    and a crash-shaped one is not.
  * The service stays on loopback unless XANA_STT_HOST says otherwise, and
    says so loudly when it does.
  * Standard library only. faster-whisper and openai-whisper are optional and
    imported lazily, so this file can be compiled, self-tested and served on a
    machine where neither is installed.

RUN IT

    python xana_stt.py                  # serve on http://127.0.0.1:4319
    python xana_stt.py --selftest       # asserts the HTTP contract; needs no
                                        # model, no microphone and no network
    python xana_stt.py --wake-selftest  # asserts the wake-word port below

The wake-word section near the top is a port of
`src/components/xana/wake-word.ts` (the browser's canonical matcher).
`scripts/check-stt.mjs` re-derives the expected answers for a corpus by running
that TypeScript file under Node and fails if this port drifts from it, so the
two implementations cannot quietly disagree.
"""

from __future__ import annotations

import argparse
import http.client
import io
import json
import os
import re
import sys
import threading
import time
import unicodedata
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Dict, List, NamedTuple, Optional, Sequence, Tuple

SERVICE = "xana-stt"
VERSION = "1"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 4319
DEFAULT_MODEL = "base"
DEFAULT_BACKEND = "auto"
BACKENDS = ("auto", "faster-whisper", "whisper")

HEALTH_PATH = "/health"
TRANSCRIBE_PATH = "/transcribe"

#: 10 MB, inclusive. A minute of 16 kHz mono PCM is about 1.9 MB, so this is
#: roughly five minutes of audio: enough for an utterance, small enough that a
#: hostile or confused caller cannot exhaust memory.
MAX_BODY_BYTES = 10 * 1024 * 1024

#: Whisper's sample rate. Everything handed to a backend is 16 kHz mono.
SAMPLE_RATE = 16000

#: How long /health will wait for a model load that is already in flight before
#: answering "still loading" instead. A local int8 load takes a second or two;
#: the bound exists so a status route can never hang a browser.
HEALTH_PROBE_WAIT_SECONDS = 5.0

#: After a failed load, do not try again on every poll. A user who is fixing the
#: problem (downloading the model, installing a backend) gets a fresh attempt
#: within half a minute, and a broken install does not spin the disk per request.
LOAD_RETRY_SECONDS = 30.0

#: Origins allowed to see a response. Loopback only, anchored, and matched
#: case-insensitively: "http://127.0.0.1:4310" is the app, and
#: "http://127.0.0.1.evil.example" is not, even though it starts the same way.
LOOPBACK_ORIGIN = re.compile(r"^http://(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$", re.IGNORECASE)

#: Content types accepted by /transcribe, mapped to the container family the
#: decoder will be asked for. The four families the browser client can produce,
#: plus the aliases real encoders use for the same containers.
AUDIO_TYPES: Dict[str, str] = {
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/vnd.wave": "wav",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/oga": "ogg",
    "audio/mp4": "mp4",
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
}

#: The friendly name used for each accepted family in error messages.
KIND_LABELS = {"wav": "audio/wav", "webm": "audio/webm", "ogg": "audio/ogg", "mp4": "audio/mp4", "m4a": "audio/mp4"}


# ======================================================================
# Wake word: a port of src/components/xana/wake-word.ts
# ======================================================================
#
# Speech recognisers do not return the string that was said. "Xana" comes back
# as "Zana", "Xena", "ex Anna" and worse, so the match runs on a normalised
# form: lowercased, punctuation dropped, homophone letters folded, and a small
# edit budget allowed. The name must be near the START of the transcript,
# because a wake word is how a sentence is addressed rather than something it
# contains.
#
# The constants below are kept identical to the TypeScript ones on purpose: a
# phrase list that drifts between the browser and this service is a bug that
# only shows up as a wake word that works in one of them.

#: Letters a recogniser swaps for each other. `c` is deliberately NOT folded:
#: folding it would turn "can" into "xan", one edit from "xana", and "can I ask
#: you something" would wake her.
FOLDINGS: Tuple[Tuple[str, str], ...] = (("ph", "f"), ("v", "f"))

_LEADING_FOLD = re.compile(r"^[zs]")

#: Words that may precede the name without changing the fact that she is being
#: addressed.
LEADING_FILLERS: Tuple[str, ...] = (
    "hey",
    "hi",
    "ok",
    "okay",
    "yo",
    "um",
    "uh",
    "so",
    "hello",
    "please",
)

#: The default ways of saying her name. The folded forms these produce are
#: `xana`, `exanna` and `xena`; everything within the edit budget of those is
#: covered by tolerance, which is why `xanna` and `zara` are absent.
DEFAULT_WAKE_PHRASES: Tuple[str, ...] = ("xana", "exanna", "xena", "zena")

#: A filler glued to the front of a token by a recogniser: "heyzana", "okzana".
GLUED_FILLERS = re.compile(r"^(hey|hi|ok|okay|yo)")


def _is_letter(character: str) -> bool:
    """True for a Unicode letter, which is what JS `\\p{L}` means."""
    return unicodedata.category(character).startswith("L")


def normalize_transcript(text: str) -> str:
    """
    Lowercase, strip anything that is not a letter or a space, collapse runs of
    spaces.

    Apostrophes are removed rather than treated as separators, so "Xana's"
    normalises to "xanas" - one token, still a match, instead of two tokens
    where the second is a stray "s". Digits are dropped because a recogniser
    writing "Xana 2" is noise, not a request.

    The TypeScript does this in two steps - `[^\\p{L}\\s]` to a space, then
    `\\s+` to one space - and the two are worth collapsing here. The sets of
    characters the two languages call whitespace are not identical (JS counts
    U+FEFF, Python counts U+001C..U+001F), but everything that is not a letter
    ends up as a single space either way, so the difference cannot reach the
    output and this port does not have to track it.
    """
    lowered = text.lower()
    for apostrophe in ("'", "\u2019", "\u02bc", "`"):
        lowered = lowered.replace(apostrophe, "")

    pieces = [character if _is_letter(character) else " " for character in lowered]

    collapsed: List[str] = []
    for character in pieces:
        if character == " ":
            if collapsed and collapsed[-1] == " ":
                continue
            collapsed.append(" ")
        else:
            collapsed.append(character)
    return "".join(collapsed).strip(" ")


def fold_token(token: str) -> str:
    """
    Fold a single token to its comparison form.

    Applied to both the transcript tokens and the configured phrases, so the two
    sides of the comparison are always transformed the same way: folding only
    one side is the classic way this kind of matching silently stops working.
    """
    folded = _LEADING_FOLD.sub("x", token, count=1)
    for pattern, replacement in FOLDINGS:
        folded = folded.replace(pattern, replacement)
    return folded


def fold_phrase(phrase: str) -> str:
    """The comparison form of a whole phrase: normalised, folded, spaces gone."""
    return fold_token("".join(character for character in normalize_transcript(phrase) if _is_letter(character)))


def edit_distance(a: str, b: str, limit: int) -> int:
    """
    Levenshtein distance, bounded.

    Bounded because the only question ever asked is "is this within `limit`?",
    and an unbounded implementation spends its time on tails that cannot change
    the answer. Standard rolling-row dynamic programming, two rows instead of a
    matrix, with the early exit the TypeScript version has: once every cell in a
    row exceeds the budget, no later row can come back under it.

    The matcher itself no longer leans on this - the doubled-sound and
    opening-sound rules it uses now are structural, because no arithmetic budget
    can separate "xanna" from "xanax". It is kept because it is part of the
    public surface of the TypeScript module and is exercised directly.
    """
    if a == b:
        return 0
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    if not a:
        return len(b)
    if not b:
        return len(a)

    previous = list(range(len(b) + 1))

    for i in range(1, len(a) + 1):
        current = [i]
        row_best = i
        for j in range(1, len(b) + 1):
            substitution = previous[j - 1] + (0 if a[i - 1] == b[j - 1] else 1)
            insertion = current[j - 1] + 1
            deletion = previous[j] + 1
            value = min(substitution, insertion, deletion)
            current.append(value)
            if value < row_best:
                row_best = value
        if row_best > limit:
            return limit + 1
        previous = current

    return previous[len(b)]


def tolerance_for(length: int) -> int:
    """
    How many edits a token may differ by and still count as the name.

    Length is the honest proxy for how much of the name a token actually
    carries. Three earlier versions of this in the TypeScript original were
    wrong in ways only a test caught; this port keeps the current numbers rather
    than re-deriving them.
    """
    if length <= 3:
        return 0
    if length <= 6:
        return 1
    return 2


def padding_is_not_a_different_word(folded: str, target: str) -> bool:
    """
    One extra letter is allowed, but only as the doubled sound.

    A recogniser writes "Xana" as "Xanna" - the middle `n` heard twice - and that
    must match. "Xanax" is the same length and must NOT, because it is a word
    people say for reasons that have nothing to do with her. Arithmetic cannot
    separate those two: any budget that admits `xanna` admits `xanax`.

    So the rule is structural. The extra letter has to duplicate the one before
    it, anywhere in the token - a doubled sound, not an appended letter.
    """
    if len(folded) != len(target) + 1:
        return False
    for index in range(len(folded)):
        # `index == 0` is skipped explicitly. In the TypeScript, `folded[-1]` is
        # `undefined` and can never equal `folded[0]`; in Python it is the LAST
        # character, so the port would happily treat a word ending in the same
        # letter it starts with as a doubled sound.
        if index == 0 or folded[index] != folded[index - 1]:
            continue
        if folded[:index] + folded[index + 1 :] == target:
            return True
    return False


def forgivable_edit(folded: str, target: str) -> bool:
    """
    Whether a one-edit difference can be forgiven.

    Folding already handles the opening consonant (`zana`, `sana` -> `xana`), so
    a substitution at position 0 is never a near-miss - it is a different word
    that happens to look like a shifted version of hers. `cana` is exactly that.
    Refusing position 0 is what keeps "can a person do that" and "cana" from
    waking her while `Dana`, `Zara` and `Sara` still match.
    """
    if len(folded) != len(target):
        return False
    differences = 0
    for index in range(len(folded)):
        if folded[index] == target[index]:
            continue
        if index == 0:
            return False
        differences += 1
        if differences > 1:
            return False
    return differences == 1


def long_enough_to_be_the_phrase(folded: str, target: str) -> bool:
    """
    A candidate shorter than the name carries less of it than the name has, so
    there is nothing to forgive. `can` is refused here, which matters because
    nothing else would refuse it.
    """
    return len(folded) >= len(target)


def is_wake_token(token: str, phrases: Sequence[str] = DEFAULT_WAKE_PHRASES) -> bool:
    """Whether one transcript token is the name, in any of its spellings."""
    # One or two letters is never the name, whatever phrase is configured: a
    # guard against matching `a` and `i`, and against a phrase list edited down
    # to something that would.
    if len(token) < 3:
        return False

    folded = fold_token(token)
    for phrase in phrases:
        target = fold_phrase(phrase)
        if not target:
            continue
        if folded == target:
            return True
        if not long_enough_to_be_the_phrase(folded, target):
            continue
        # An over-long candidate is ONLY the doubled sound. Failing here is
        # decisive rather than something a budget can rescue.
        if len(folded) > len(target):
            if padding_is_not_a_different_word(folded, target):
                return True
            continue
        if forgivable_edit(folded, target):
            return True
    return False


def strip_glued_filler(token: str, phrases: Sequence[str] = DEFAULT_WAKE_PHRASES) -> Optional[str]:
    """
    Peel a filler a recogniser glued to the front of a token: "heyzana".

    Only peeled when doing so turns the token into something that could actually
    be the name, which is what stops it from mangling ordinary words: "history"
    begins with "hi", and a naive strip would hand the matcher "story".
    """
    stripped = GLUED_FILLERS.sub("", token, count=1)
    if stripped == token or stripped == "":
        return None
    return stripped if is_wake_token(stripped, phrases) else None


class WakeMatch(NamedTuple):
    """The result of matching one transcript, including the diagnostic token."""

    matched: bool
    command: str
    heard: str


NO_MATCH = WakeMatch(False, "", "")


def find_wake(tokens: Sequence[str], phrases: Sequence[str] = DEFAULT_WAKE_PHRASES) -> Optional[Tuple[int, int]]:
    """
    Locate the name in the leading window, returning (start, end) indices.

    The first candidate wins. Short-circuiting is load-bearing: without it a
    transcript like "can I ask you something" keeps hunting rightwards until
    something looks name-like, and answering a sentence nobody addressed to her
    is the failure that makes an always-on listener unbearable.
    """
    # Where the current phrase attempt began. A filler is skipped over rather
    # than ending the search: "hey Xana" and "hey hey Xana" are both addresses,
    # and the alternative is a listener that ignores a user who stammers.
    start = 0

    for index in range(min(len(tokens), 3)):
        token = tokens[index]
        if not token:
            continue

        if index > 0 and token not in LEADING_FILLERS:
            # Not a filler, so - if everything before it was - this is a NEW
            # phrase starting here. Breaking instead would test the token before
            # asking whether it is the name, and so throw away the name itself:
            # in "okay Xana" the token at index 1 is `xana`, not a filler.
            all_before_were_fillers = all(
                earlier in LEADING_FILLERS or earlier == "" for earlier in tokens[:index]
            )
            if not all_before_were_fillers:
                break
            start = index

        # A name is not one or two letters, and is_wake_token refuses those -
        # but only once it is called. The window's own rule otherwise lets a
        # bare `a` or `i` at the front count as an address.
        if len(fold_token(token)) < 3:
            continue
        if is_wake_token(token, phrases):
            return (start, index)

        # A recogniser that ran the filler into the name: "heyzana", "okzana".
        # Index 0 only: strip_glued_filler would otherwise peel the "hi" off
        # "history" and hand the matcher "story".
        if index == 0 and strip_glued_filler(token, phrases):
            return (0, 0)

    # The name split across two tokens, which is what a recogniser returns for
    # "ex anna" and, with a Chinese acoustic model, for "za na". Only the
    # immediate pair is considered, so the window cannot creep rightwards
    # through a sentence hunting for a name that is not there.
    if len(tokens) >= 2:
        first = tokens[0]
        second = tokens[1]
        # BOTH tokens must carry part of the name, and the second must be a
        # near-miss on its own. Joining anything with anything is too generous:
        # "can" + "a" makes `cana`, which reads like a shifted version of hers,
        # and that is how "can a person do that" once woke her. `anna` is its
        # own near-miss, `a` is not.
        both_carry_the_name = is_wake_token(second, phrases) or len(fold_token(second)) >= 3
        if both_carry_the_name:
            joined = first + second
            # The unglued join is tried first: "hey" + "zana" is the pair as the
            # user said it, and peeling "hey" off before looking is what makes
            # an earlier version of this miss "hey zana" entirely.
            if is_wake_token(joined, phrases) or strip_glued_filler(joined, phrases):
                return (0, 1)

    return None


def match_wake_full(transcript: str, phrases: Sequence[str] = DEFAULT_WAKE_PHRASES) -> WakeMatch:
    """
    Decide whether a transcript is addressed to her, and what it asks for.

    The search window is deliberately one-sided: the name has to appear within
    the first three tokens, after at most a run of leading fillers.
    """
    normalized = normalize_transcript(transcript)
    if not normalized:
        return NO_MATCH

    tokens = [token for token in normalized.split(" ") if token]
    if not tokens:
        return NO_MATCH

    found = find_wake(tokens, phrases)
    if found is None:
        return NO_MATCH

    start, end = found
    command = " ".join(tokens[end + 1 :])
    heard = " ".join(tokens[start : end + 1])
    return WakeMatch(True, command, heard)


def match_wake(transcript: str, phrases: Sequence[str] = DEFAULT_WAKE_PHRASES) -> Tuple[bool, str]:
    """
    The contract the sidecar exposes for the browser's matcher.

    Returns (matched, command). An empty command with matched True means the
    name alone was heard: she should listen for a request rather than treat
    silence as one.
    """
    result = match_wake_full(transcript, phrases)
    return (result.matched, result.command)


def strip_wake(transcript: str, phrases: Sequence[str] = DEFAULT_WAKE_PHRASES) -> str:
    """Just the request, for callers that have already matched."""
    return match_wake_full(transcript, phrases).command


# ======================================================================
# The fixtures, and why they are written down twice
# ======================================================================
#
# These expected values were OBSERVED by running the TypeScript matcher, not
# derived by hand. They are pinned here so `--wake-selftest` needs nothing but
# Python, and `scripts/check-stt.mjs` re-derives the answers from the TypeScript
# file at check time and fails if the two implementations have drifted apart. A
# hand-written expectation is a guess; this one is a recording.
#
# The cases are the ones in `scripts/check-wake-word.ts`, which is the canonical
# list: when a case changes there, it has to change here too, and the parity
# check is what makes that a failure rather than a silent disagreement about
# when she was called.

WAKE_FIXTURES: List[Tuple[str, bool, str]] = [
    # -- the name alone
    ("Xana", True, ""),
    ("xana", True, ""),
    ("Xana!", True, ""),
    ("Xana?", True, ""),
    ("Zana", True, ""),
    ("Sana", True, ""),
    ("Xena", True, ""),
    ("exanna", True, ""),
    ("Xanna", True, ""),
    # -- a filler in front of the name
    ("Hey Xana", True, ""),
    ("hey xana", True, ""),
    ("OK Xana", True, ""),
    ("okay, xana", True, ""),
    ("Hi Xana", True, ""),
    ("Yo Xana", True, ""),
    ("hello Xana", True, ""),
    # -- the request is what follows the name
    ("Xana what's the weather", True, "whats the weather"),
    ("Xana, what's the weather?", True, "whats the weather"),
    ("hey Xana what's the weather", True, "whats the weather"),
    ("OK Xana, add milk to my list", True, "add milk to my list"),
    ("Hey Zana, what is on my calendar", True, "what is on my calendar"),
    ("Xana: how are the markets", True, "how are the markets"),
    ("xana remind me to call mum", True, "remind me to call mum"),
    ("hey hey xana what time is it", True, "what time is it"),
    ("um, Xana, are you there", True, "are you there"),
    # -- split or run together by the recogniser
    ("ex anna what's up", True, "whats up"),
    ("hey zana what's the weather", True, "whats the weather"),
    ("heyzana what's the weather", True, "whats the weather"),
    ("okzana stop", True, "stop"),
    # -- the near-miss spellings an acoustic model returns
    ("Zara", True, ""),
    ("Sara", True, ""),
    ("Zena", True, ""),
    ("zanna", True, ""),
    # -- one step past the line
    ("cana", False, ""),
    ("Dana", False, ""),
    ("xanadu", False, ""),
    ("Xanax", False, ""),
    # -- the name in the middle of a sentence: the misses that matter
    ("I told Xana to remind me", False, ""),
    ("I asked Xana about the weather yesterday", False, ""),
    ("does xana work offline", False, ""),
    ("the notes xana wrote are wrong", False, ""),
    ("what did xana say about the meeting", False, ""),
    ("I wish xana would stop interrupting", False, ""),
    ("so anyway xana said the markets were closed", False, ""),
    # -- ordinary speech that merely sounds like the name
    ("can I ask you something", False, ""),
    ("can a person do that", False, ""),
    ("the banana is ripe", False, ""),
    ("anaconda is a long snake", False, ""),
    ("the analysis is done", False, ""),
    ("anyway I was saying", False, ""),
    ("in a minute", False, ""),
    ("a nana would know", False, ""),
    ("sonar is a kind of radar", False, ""),
    ("I need a nap", False, ""),
    # -- single letters and stray words
    ("a", False, ""),
    ("i", False, ""),
    ("an", False, ""),
    ("in", False, ""),
    ("on", False, ""),
    ("so", False, ""),
    ("the", False, ""),
    ("is", False, ""),
    ("ok", False, ""),
    ("hey", False, ""),
    ("", False, ""),
    ("   ", False, ""),
    ("...", False, ""),
    (" , . ", False, ""),
    # -- a sentence that begins with something else
    ("the xana is offline", False, ""),
    ("when xana is ready tell me", False, ""),
    ("if xana can do it", False, ""),
    ("please xana tell me", True, "tell me"),
    ("I think xana should", False, ""),
    # -- the window is bounded
    ("word xana what is the weather", False, ""),
    ("word " * 40 + "xana what is the weather", False, ""),
    # -- known limits, recorded rather than hidden
    ("Zara what's the weather", True, "whats the weather"),
    # -- awkward shapes for a port: encoding, digits, apostrophes
    ("xana's", False, ""),
    ("Xana\u2019s reminder", False, ""),
    ("caf\u00e9 xana", False, ""),
    ("xana\u2026 are you there", True, "are you there"),
    ("xana 2 pm remind me", True, "pm remind me"),
    ("Xana, remind me Friday at 3", True, "remind me friday at"),
    ("xana xana hello", True, "xana hello"),
    ("\u00a0 xana \u00a0", True, ""),
    ("XANA STOP", True, "stop"),
    ("12345", False, ""),
    ("a xana", False, ""),
    ("ex-anna play", True, "play"),
    ("za na play music", False, ""),
    ("xen a play music", False, ""),
    ("he zana stop", False, ""),
    ("hi story", False, ""),
    ("history", False, ""),
    ("hey story", False, ""),
    ("tell xana to stop", False, ""),
    ("what did zana say", False, ""),
]

WAKE_PHRASE_FIXTURES: List[Tuple[str, List[str], bool, str]] = [
    # The escape hatch: a user whose name really does come back as "Dana" adds
    # it to the phrase list, and then it matches - without loosening the
    # default strictness for everybody.
    ("Dana", ["dana"], True, ""),
    ("jarvis what's up", ["jarvis"], True, "whats up"),
    ("xana hello", [], False, ""),
    ("computadora enciende las luces", ["computadora"], True, "enciende las luces"),
    ("hey computadora, enciende las luces", ["computadora"], True, "enciende las luces"),
    ("xana play music", ["computadora"], False, ""),
    ("hey zana play music", ["xana", "zana"], True, "play music"),
    ("a play music", ["a"], False, ""),
    ("ex anna stop", ["exanna"], True, "stop"),
    ("xana", ["xana", "exanna", "xena", "zena"], True, ""),
    ("exanna", ["xana", "exanna", "xena", "zena"], True, ""),
    ("xena", ["xana", "exanna", "xena", "zena"], True, ""),
    ("zena", ["xana", "exanna", "xena", "zena"], True, ""),
]

NORMALIZE_FIXTURES: List[Tuple[str, str]] = [
    ("Xana, what's the weather?", "xana whats the weather"),
    ("Xana's notes", "xanas notes"),
    ("ZANA", "zana"),
    ("  hey   Xana  ", "hey xana"),
    ("Xana\u2014stop", "xana stop"),
    ("Xana 2", "xana"),
    ("   ", ""),
    ("", ""),
    ("xana \u5929\u6c14", "xana \u5929\u6c14"),
    ("caf\u00e9 xana", "caf\u00e9 xana"),
    ("ex-anna", "ex anna"),
    ("a\u2019b\u02bcc`d", "abcd"),
    ("\u00a0 xana \u00a0", "xana"),
    ("...", ""),
]

FOLD_FIXTURES: List[Tuple[str, str]] = [
    ("zana", "xana"),
    ("sana", "xana"),
    ("xana", "xana"),
    ("vera", "fera"),
    ("cana", "cana"),
    ("Zana", "Zana"),
    ("philip", "filip"),
    ("zv", "xf"),
    ("xenaphone", "xenafone"),
    ("", ""),
    ("scz", "xcz"),
    ("zz", "xz"),
]

DISTANCE_FIXTURES: List[Tuple[str, str, int, int]] = [
    ("xana", "xana", 2, 0),
    ("xana", "xena", 2, 1),
    ("xana", "xanna", 2, 1),
    ("xanna", "xana", 2, 1),
    ("xana", "xnaa", 3, 2),
    ("", "xana", 4, 4),
    ("xana", "zzzz", 1, 2),
    ("kat", "kitten", 3, 4),
    ("zara", "xana", 2, 2),
]

TOLERANCE_FIXTURES: List[Tuple[int, int]] = [
    (0, 0),
    (1, 0),
    (2, 0),
    (3, 0),
    (4, 1),
    (5, 1),
    (6, 1),
    (7, 2),
    (8, 2),
    (10, 2),
    (12, 2),
]


# ======================================================================
# Configuration
# ======================================================================


class Config(NamedTuple):
    """Everything the service needs to start."""

    host: str
    port: int
    model: str
    backend: str
    model_dir: str
    quiet: bool = False


def default_model_dir() -> str:
    """
    Where a downloaded model lives.

    Deliberately under the user's own cache directory rather than beside this
    file: the model is data, it is large, and a checkout that grows by a
    gigabyte because someone pressed the mic button is a checkout nobody wants.
    """
    override = os.environ.get("XANA_STT_MODEL_DIR")
    if override:
        return os.path.abspath(os.path.expanduser(override))

    home = os.path.expanduser("~")
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
    else:
        base = os.environ.get("XDG_CACHE_HOME") or os.path.join(home, ".cache")
    return os.path.join(base, "xana-stt", "models")


def is_loopback(host: str) -> bool:
    """Whether a bind address is reachable only from this machine."""
    return host in ("127.0.0.1", "localhost", "::1") or host.startswith("127.")


def audio_kind(content_type: Optional[str]) -> Optional[str]:
    """The container family of a request body, or None when it is not audio we accept."""
    if not content_type:
        return None
    media = content_type.split(";", 1)[0].strip().lower()
    return AUDIO_TYPES.get(media)


# ======================================================================
# The engine: which backend, whether the model is really there, and running it
# ======================================================================


class DecodeFailed(Exception):
    """The audio could not be turned into samples: a missing decoder, or a bad container."""


class TranscriptionFailed(Exception):
    """The model ran and did not produce usable text."""


class HealthState(NamedTuple):
    """What /health reports. `reason` is empty exactly when `ready` is true."""

    backend: str
    ready: bool
    reason: str


class Transcription(NamedTuple):
    """One /transcribe result. `error` is empty when the run was clean."""

    text: str
    language: str
    duration_ms: int
    error: str
    unsupported: bool


def _try_import(name: str) -> Tuple[Optional[object], str]:
    """
    Import a backend module, reporting failure instead of raising it.

    Any exception counts, not just ImportError: a half-installed wheel fails
    with an OSError from a missing shared library, and that is exactly the case
    where the user needs /health to say so rather than the service to die.
    """
    try:
        if name == "faster-whisper":
            import faster_whisper  # noqa: F401  (imported for its side effect: availability)

            return faster_whisper, ""
        import whisper  # noqa: F401

        return whisper, ""
    except Exception as exc:  # noqa: BLE001 - the whole point is to report, not to raise
        return None, "%s: %s" % (type(exc).__name__, exc)


class Engine:
    """
    The backend, the lazily loaded model, and the honesty about both.

    State lives here rather than in the request handler so that the selftest can
    build an engine without a model, and so that "is it ready" is answered in
    exactly one place. The locks are ordered: `_model_lock` is taken first and
    `_state_lock` inside it, never the other way round.
    """

    def __init__(self, config: Config):
        self.model_name = config.model
        self.model_dir = config.model_dir
        self.backend_preference = config.backend

        self._state_lock = threading.RLock()
        self._model_lock = threading.Lock()

        self._impl: Optional[object] = None
        self._impl_errors: List[str] = []
        self._backend: Optional[str] = None
        self._select_backend()

        self._model: Optional[object] = None
        self._load_error = ""
        self._loading = False
        self._last_attempt = 0.0
        self._warm_started = False
        self._warm_done = threading.Event()
        self._warm_done.set()

    # -- backend selection ---------------------------------------------

    def _select_backend(self) -> None:
        order = {
            "auto": ("faster-whisper", "whisper"),
            "faster-whisper": ("faster-whisper",),
            "whisper": ("whisper",),
        }[self.backend_preference]

        for name in order:
            module, error = _try_import(name)
            if module is not None:
                self._backend = name
                self._impl = module
                return
            self._impl_errors.append("%s (%s)" % (name, error))

    @property
    def backend(self) -> str:
        """The backend in use, or "none" when nothing is importable."""
        return self._backend or "none"

    def _install_reason(self) -> str:
        """
        One short sentence, and the exact command that fixes it.

        The import errors that produced this are deliberately NOT in here: this
        string is shown to a user, and "ModuleNotFoundError" is not a sentence
        anybody wants to read. `backend_detail` carries them for the banner,
        where someone debugging can see them.
        """
        if self.backend_preference == "whisper":
            return "No local speech engine is installed. Run: pip install openai-whisper"
        return "No local speech engine is installed. Run: pip install faster-whisper"

    def backend_detail(self) -> str:
        """Why each candidate backend was refused, for the startup banner."""
        return "; ".join(self._impl_errors)

    def _not_downloaded_reason(self) -> str:
        return (
            "The '%s' model is not downloaded yet. The first transcription downloads it once "
            "(that needs internet); after that it works offline." % self.model_name
        )

    # -- where a downloaded model would be -----------------------------

    def _search_roots(self) -> List[str]:
        roots = [self.model_dir]
        home = os.path.expanduser("~")
        for extra in (
            os.path.join(home, ".cache", "huggingface", "hub"),
            os.path.join(home, ".cache", "whisper"),
        ):
            if extra not in roots:
                roots.append(extra)
        return roots

    def _faster_whisper_cache_names(self) -> List[str]:
        if "/" in self.model_name:
            repository = self.model_name
        else:
            repository = "Systran/faster-whisper-%s" % self.model_name
        return [
            "models--" + repository.replace("/", "--"),
            "faster-whisper-%s" % self.model_name,
            self.model_name,
        ]

    def _local_model_root(self) -> Optional[str]:
        """
        A directory the model can be loaded from with no network, or None.

        This is a filesystem probe, not a load: it answers "is a download going
        to be needed", which is the question that decides whether a status check
        may touch the disk at all. Whether the files are *usable* is only ever
        decided by actually loading, and the result of that is what /health
        reports.
        """
        if os.path.isdir(self.model_name):
            return self.model_name  # an explicit path to a converted model

        for root in self._search_roots():
            for name in self._faster_whisper_cache_names():
                if os.path.isdir(os.path.join(root, name)):
                    return root
        if self._backend == "whisper":
            for root in self._search_roots():
                if os.path.isfile(os.path.join(root, "%s.pt" % self.model_name)):
                    return root
        return None

    # -- loading -------------------------------------------------------

    def _build_model(self, local_root: Optional[str]) -> object:
        """Construct the backend's model object. Raises whatever the backend raises."""
        if os.path.isdir(self.model_name):
            # An explicit path to a downloaded model: no cache, no download.
            model_argument = self.model_name
            download_root = None
            local_only = True
        elif local_root is not None:
            model_argument = self.model_name
            download_root = local_root
            local_only = True
        else:
            model_argument = self.model_name
            download_root = self.model_dir
            local_only = False

        if download_root:
            try:
                os.makedirs(download_root, exist_ok=True)
            except OSError as exc:
                raise RuntimeError("cannot create the model directory %s: %s" % (download_root, exc)) from exc

        if self._backend == "faster-whisper":
            def build(compute_type: str) -> object:
                kwargs: Dict[str, object] = {"device": "cpu", "compute_type": compute_type}
                if download_root:
                    kwargs["download_root"] = download_root
                if local_only:
                    kwargs["local_files_only"] = True
                return self._impl.WhisperModel(model_argument, **kwargs)  # type: ignore[attr-defined]

            try:
                return build("int8")
            except Exception:  # noqa: BLE001 - int8 is not supported on every CPU or build
                return build("float32")

        kwargs = {}
        if download_root:
            kwargs["download_root"] = download_root
        return self._impl.load_model(model_argument, **kwargs)  # type: ignore[attr-defined]

    def _load_locked(self, allow_download: bool) -> Tuple[bool, str]:
        """
        Load the model if it is not loaded. The caller must hold `_model_lock`.

        Never raises: a load failure is a fact the service reports, not an error
        that reaches a client as a stack trace.
        """
        with self._state_lock:
            if self._model is not None:
                return True, ""
            if self._backend is None:
                return False, self._install_reason()
            local_root = self._local_model_root()
            if local_root is None and not allow_download:
                return False, self._not_downloaded_reason()
            self._loading = True
            self._warm_done.clear()

        model: Optional[object] = None
        error = ""
        try:
            model = self._build_model(local_root)
        except Exception as exc:  # noqa: BLE001 - reported through /health, never raised
            error = "Could not load the '%s' model: %s: %s" % (self.model_name, type(exc).__name__, exc)
        finally:
            with self._state_lock:
                self._loading = False
                self._last_attempt = time.monotonic()
                if model is not None:
                    self._model = model
                    self._load_error = ""
                else:
                    self._load_error = error or self._not_downloaded_reason()
                self._warm_done.set()

        if model is None:
            return False, self._load_error
        return True, ""

    # -- readiness -----------------------------------------------------

    def _maybe_start_warmup(self) -> None:
        """
        Start one background load when the model is already on disk.

        Only then: a status route must never begin a download. The one exception
        is /transcribe, which is allowed to fetch the model because a request
        that carries audio is a request to use it.
        """
        with self._state_lock:
            if self._model is not None or self._loading or self._backend is None:
                return
            retry_due = bool(self._load_error) and (time.monotonic() - self._last_attempt) >= LOAD_RETRY_SECONDS
            if self._warm_started and not retry_due:
                return
            if self._local_model_root() is None:
                return
            self._warm_started = True
            self._warm_done.clear()

        thread = threading.Thread(target=self._warm_worker, name="xana-stt-warmup", daemon=True)
        thread.start()

    def _warm_worker(self) -> None:
        with self._model_lock:
            self._load_locked(allow_download=False)

    def start_preload(self) -> None:
        """Ask for a background load at startup, so the first /health is cheap."""
        self._maybe_start_warmup()

    def snapshot(self) -> HealthState:
        """The readiness at this instant, without waiting for anything."""
        if self._backend is None:
            return HealthState("none", False, self._install_reason())
        with self._state_lock:
            if self._model is not None:
                return HealthState(self.backend, True, "")
            if self._loading:
                return HealthState(self.backend, False, "The '%s' model is still loading." % self.model_name)
            if self._load_error:
                return HealthState(self.backend, False, self._load_error)
            return HealthState(self.backend, False, self._not_downloaded_reason())

    def health(self) -> HealthState:
        """
        Readiness for /health, waiting briefly for a load already in flight.

        The wait is bounded and never begins a download, so the answer is honest
        ("ready" is only true once a model object exists) without a status route
        that can hang.
        """
        self._maybe_start_warmup()
        if self._backend is not None:
            self._warm_done.wait(HEALTH_PROBE_WAIT_SECONDS)
        return self.snapshot()

    # -- transcription -------------------------------------------------

    def _run_faster_whisper(self, model: object, source: io.BytesIO) -> Tuple[str, str, int]:
        audio_module = getattr(self._impl, "audio", None)
        decoder = getattr(audio_module, "decode_audio", None) if audio_module is not None else None

        samples = None
        if decoder is not None:
            # Decoding through the backend's own reader keeps a container
            # failure separate from a model failure, which is what lets the
            # handler answer 415 for "I cannot read this" and 200-with-no-text
            # for "I read it and heard nothing".
            try:
                samples = decoder(source, sampling_rate=SAMPLE_RATE)
            except Exception as exc:  # noqa: BLE001 - classified, then reported
                raise DecodeFailed("%s: %s" % (type(exc).__name__, exc)) from exc

        if samples is not None:
            audio_input: object = samples
        else:
            # Older faster-whisper builds have no separate decoder, so the
            # stream goes to `transcribe` itself.
            audio_input = source
        vad_enabled = os.environ.get("XANA_STT_VAD", "1") not in ("0", "false", "no")

        def run(vad: bool):
            if samples is None:
                # Every attempt starts at the top of the stream: a retry must not
                # inherit the position the first attempt left behind.
                source.seek(0)
            segments, info = model.transcribe(  # type: ignore[attr-defined]
                audio_input, language=None, beam_size=5, vad_filter=vad
            )
            text = " ".join((segment.text or "").strip() for segment in segments).strip()
            return text, info

        try:
            text, info = run(vad_enabled)
        except Exception as exc:  # noqa: BLE001
            if vad_enabled:
                # A voice-activity filter that cannot load (onnxruntime missing,
                # for instance) must not cost a transcription.
                try:
                    text, info = run(False)
                except Exception as retry_exc:  # noqa: BLE001
                    raise TranscriptionFailed("%s: %s" % (type(retry_exc).__name__, retry_exc)) from retry_exc
            else:
                raise TranscriptionFailed("%s: %s" % (type(exc).__name__, exc)) from exc

        language = getattr(info, "language", "") or ""
        if samples is not None:
            duration_ms = int(round(len(samples) * 1000.0 / SAMPLE_RATE))
        else:
            duration_ms = int(round(float(getattr(info, "duration", 0.0) or 0.0) * 1000.0))
        return text, language, duration_ms

    def _decode_wav_16k_mono(self, source: io.BytesIO) -> object:
        """
        Read a WAV stream with the standard library, downmix to mono, resample
        to 16 kHz.

        This exists so the openai-whisper fallback can transcribe a WAV without
        shelling out to ffmpeg for it: whisper's own `load_audio` spawns ffmpeg
        for every input, including this one. Linear interpolation is not the
        best resampler in the world, but it is honest, dependency-free, and only
        used on a path the browser client does not normally take (it sends
        16 kHz mono PCM).
        """
        try:
            import numpy  # noqa: F401  (openai-whisper depends on it; this file does not)
        except Exception as exc:  # noqa: BLE001
            raise DecodeFailed("numpy is required by openai-whisper: %s" % exc) from exc

        try:
            # `wave` closes only a file it opened itself, so the caller's stream
            # survives this block.
            with wave.open(source, "rb") as handle:
                channels = handle.getnchannels()
                width = handle.getsampwidth()
                rate = handle.getframerate()
                frames = handle.readframes(handle.getnframes())
        except (wave.Error, EOFError, OSError, ValueError) as exc:
            raise DecodeFailed("not a readable WAV file: %s" % exc) from exc

        if channels < 1 or rate <= 0:
            raise DecodeFailed("the WAV file has no channels or no sample rate")
        if width not in (1, 2, 3, 4):
            raise DecodeFailed("unsupported WAV sample width: %d bytes" % width)

        frame_bytes = channels * width
        usable = len(frames) - (len(frames) % frame_bytes)
        if usable <= 0:
            raise DecodeFailed("the WAV file contains no audio frames")

        import numpy as np

        raw = np.frombuffer(frames[:usable], dtype=np.uint8)
        if width == 1:
            samples = (raw.astype(np.float32) - 128.0) / 128.0
        elif width == 2:
            samples = raw.view("<i2").astype(np.float32) / 32768.0
        elif width == 3:
            triplets = raw.reshape(-1, 3).astype(np.int32)
            values = triplets[:, 0] | (triplets[:, 1] << 8) | (triplets[:, 2] << 16)
            values = np.where(values >= 0x800000, values - 0x1000000, values)
            samples = values.astype(np.float32) / 8388608.0
        else:
            samples = raw.view("<i4").astype(np.float32) / 2147483648.0

        if channels > 1:
            samples = samples.reshape(-1, channels).mean(axis=1)

        if rate != SAMPLE_RATE and samples.size:
            count = int(round(len(samples) * float(SAMPLE_RATE) / rate))
            if count < 1:
                raise DecodeFailed("the WAV file is too short to resample")
            source_positions = np.arange(count, dtype=np.float64) * (float(rate) / SAMPLE_RATE)
            samples = np.interp(source_positions, np.arange(len(samples), dtype=np.float64), samples)

        return samples.astype(np.float32)

    def _run_whisper(self, model: object, source: io.BytesIO, kind: str) -> Tuple[str, str, int]:
        if kind != "wav":
            # openai-whisper decodes anything else by spawning ffmpeg, and this
            # service does not shell out. Saying so is better than a failure the
            # user cannot act on.
            raise DecodeFailed(
                "the openai-whisper fallback reads WAV only. Install faster-whisper for %s, or send audio/wav."
                % KIND_LABELS.get(kind, "this container")
            )

        samples = self._decode_wav_16k_mono(source)
        try:
            result = model.transcribe(samples, language=None, fp16=False, verbose=False)  # type: ignore[attr-defined]
        except Exception as exc:  # noqa: BLE001
            raise TranscriptionFailed("%s: %s" % (type(exc).__name__, exc)) from exc

        text = (result.get("text") or "").strip()
        language = result.get("language") or ""
        duration_ms = int(round(len(samples) * 1000.0 / SAMPLE_RATE))
        return text, language, duration_ms

    def transcribe(self, body: bytes, kind: str) -> Transcription:
        """
        Transcribe one request body. Never raises, and never answers 500.

        The model lock is held across the whole run so two requests cannot drive
        one model at the same time; the service is otherwise sequential by
        design, because a Whisper model is a CPU-bound singleton and pretending
        otherwise only makes both requests slower.
        """
        with self._model_lock:
            with self._state_lock:
                if self._backend is None:
                    return Transcription("", "", 0, self._install_reason(), False)
                loaded = self._model is not None
            if not loaded:
                ok, error = self._load_locked(allow_download=True)
                if not ok:
                    return Transcription("", "", 0, error, False)
                loaded = True

            try:
                # The audio goes to the backend as a stream, never as a file.
                # There is nothing to clean up, nothing left behind if the
                # process dies mid-request, and no dependency on a writable temp
                # directory: this runs in sandboxes where the system temp folder
                # refuses writes, and a recording of somebody's voice is not
                # something to leave on disk for the sake of a file path.
                source = io.BytesIO(body)
                if self._backend == "faster-whisper":
                    text, language, duration_ms = self._run_faster_whisper(self._model, source)
                else:
                    text, language, duration_ms = self._run_whisper(self._model, source, kind)
                return Transcription(text, language, duration_ms, "", False)
            except DecodeFailed as exc:
                # A container we cannot read is a 415 for the client; a WAV file
                # that is corrupt is "heard nothing", because that is what the
                # microphone effectively delivered.
                if kind == "wav":
                    return Transcription("", "", 0, str(exc), False)
                return Transcription("", "", 0, str(exc), True)
            except TranscriptionFailed as exc:
                return Transcription("", "", 0, str(exc), False)
            except OSError as exc:
                return Transcription("", "", 0, "could not read the audio: %s" % exc, False)


# ======================================================================
# HTTP
# ======================================================================


class SttRequestHandler(BaseHTTPRequestHandler):
    """Two routes, JSON in both directions, and no surprises."""

    server_version = "xana-stt/" + VERSION
    protocol_version = "HTTP/1.1"
    timeout = 60

    # -- plumbing ------------------------------------------------------

    def log_message(self, fmt: str, *args: object) -> None:
        if getattr(self.server, "quiet", False):
            return
        sys.stderr.write("[%s] %s %s\n" % (time.strftime("%H:%M:%S"), self.address_string(), fmt % args))

    def _route(self) -> str:
        raw = self.path or "/"
        path = raw.split("?", 1)[0].split("#", 1)[0]
        if path != "*" and len(path) > 1 and path.endswith("/"):
            path = path[:-1]
        return path or "/"

    def _cors_headers(self, preflight: bool = False) -> None:
        """
        Add the CORS headers, reflecting a loopback Origin and nothing else.

        A wildcard would let any page on the internet read transcripts back out
        of a service on the user's own machine, which is the opposite of what a
        local service is for. With no Origin at all (curl, the phone, the app's
        server side) there is nothing to reflect, so `*` is safe.
        """
        origin = self.headers.get("Origin")
        self.send_header("Vary", "Origin")
        if not origin:
            self.send_header("Access-Control-Allow-Origin", "*")
        elif LOOPBACK_ORIGIN.match(origin.strip()):
            self.send_header("Access-Control-Allow-Origin", origin.strip())
        # A non-loopback Origin gets no header at all, which is what makes the
        # browser refuse to hand the response to that page.
        if preflight:
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "600")

    def _send_json(self, status: int, payload: Dict[str, object], close: bool = False) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self._cors_headers()
        if close:
            # Said out loud rather than merely done: an HTTP/1.1 client that is
            # not told the connection is ending will try to reuse it, and read
            # the close as a failure of the *next* request.
            self.close_connection = True
            self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD" and body:
            try:
                self.wfile.write(body)
            except OSError:
                # The caller hung up mid-response. Nothing to do about it, and
                # nothing worth a traceback in the log.
                self.close_connection = True

    def _read_body(self, length: int) -> Optional[bytes]:
        """Read exactly `length` bytes, or None if the connection ended early."""
        chunks: List[bytes] = []
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(65536, remaining))
            if not chunk:
                return None
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    # -- routes --------------------------------------------------------

    def do_OPTIONS(self) -> None:  # noqa: N802 - the name is the HTTP method
        self.send_response(204)
        self._cors_headers(preflight=True)
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = self._route()
        if path == HEALTH_PATH:
            state = self.server.engine.health()  # type: ignore[attr-defined]
            self._send_json(
                200,
                {
                    "ok": True,
                    "service": SERVICE,
                    "version": VERSION,
                    "backend": state.backend,
                    "model": self.server.engine.model_name,  # type: ignore[attr-defined]
                    "ready": state.ready,
                    "reason": state.reason,
                },
            )
            return

        if path == "/":
            self._send_json(
                200,
                {"ok": True, "service": SERVICE, "version": VERSION, "routes": [HEALTH_PATH, TRANSCRIBE_PATH]},
            )
            return

        self._send_json(404, {"error": "unknown path: %s" % path})

    def do_POST(self) -> None:  # noqa: N802
        path = self._route()
        if path != TRANSCRIBE_PATH:
            self._send_json(404, {"error": "unknown path: %s" % path})
            return

        kind = audio_kind(self.headers.get("Content-Type"))
        if kind is None:
            self._send_json(
                415,
                {
                    "error": "unsupported Content-Type %r. Send raw audio bytes as one of: %s"
                    % (self.headers.get("Content-Type"), ", ".join(sorted(set(KIND_LABELS.values()))))
                },
                close=True,
            )
            return

        transfer = (self.headers.get("Transfer-Encoding") or "").strip().lower()
        if transfer and transfer != "identity":
            self._send_json(415, {"error": "send a Content-Length body, not %s" % transfer}, close=True)
            return

        declared = self.headers.get("Content-Length")
        if declared is None:
            self._send_json(411, {"error": "missing Content-Length"}, close=True)
            return
        try:
            length = int(declared)
        except ValueError:
            self._send_json(400, {"error": "bad Content-Length: %r" % declared}, close=True)
            return
        if length < 0:
            self._send_json(400, {"error": "bad Content-Length: %r" % declared}, close=True)
            return
        if length > MAX_BODY_BYTES:
            # Answered without reading the body, so a caller cannot make this
            # process buffer more than the cap. The connection then closes,
            # because an unread body on a kept-alive socket would be parsed as
            # the next request.
            self._send_json(
                413,
                {"error": "body is %d bytes; the cap is %d bytes" % (length, MAX_BODY_BYTES)},
                close=True,
            )
            return

        body = self._read_body(length)
        if body is None:
            self._send_json(400, {"error": "the request body ended early"}, close=True)
            return

        if not body:
            self._send_json(
                200,
                {
                    "text": "",
                    "language": "",
                    "durationMs": 0,
                    "backend": self.server.engine.backend,  # type: ignore[attr-defined]
                    "model": self.server.engine.model_name,  # type: ignore[attr-defined]
                },
            )
            return

        result = self.server.engine.transcribe(body, kind)  # type: ignore[attr-defined]
        if result.unsupported:
            self._send_json(415, {"error": result.error}, close=True)
            return

        payload: Dict[str, object] = {
            "text": result.text,
            "language": result.language,
            "durationMs": result.duration_ms,
            "backend": self.server.engine.backend,  # type: ignore[attr-defined]
            "model": self.server.engine.model_name,  # type: ignore[attr-defined]
        }
        if result.error:
            payload["error"] = result.error
        self._send_json(200, payload)


class SttServer(ThreadingHTTPServer):
    """A threaded server, with the engine and the log setting on it."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: Tuple[str, int], engine: Engine, quiet: bool = False):
        self.engine = engine
        self.quiet = quiet
        super().__init__(address, SttRequestHandler)


def serve(config: Config) -> int:
    """Run until interrupted. Returns the process exit code."""
    engine = Engine(config)

    if not is_loopback(config.host):
        print("", file=sys.stderr)
        print("=" * 70, file=sys.stderr)
        print("WARNING: XANA_STT_HOST is %r, which is not loopback." % config.host, file=sys.stderr)
        print("This service has no authentication. Every device on this network can", file=sys.stderr)
        print("post audio to it and read the transcripts back. Use 127.0.0.1 unless a", file=sys.stderr)
        print("phone on the same network has to reach it, and know that it then can.", file=sys.stderr)
        print("=" * 70, file=sys.stderr)
        print("", file=sys.stderr)

    try:
        server = SttServer((config.host, config.port), engine, quiet=config.quiet)
    except OSError as exc:
        print("Could not bind %s:%d - %s" % (config.host, config.port, exc), file=sys.stderr)
        print("Another program may already own that port; set XANA_STT_PORT to change it.", file=sys.stderr)
        return 1

    bound_host, bound_port = server.server_address[0], server.server_address[1]
    state = engine.snapshot()

    print("Xana local speech-to-text")
    if bound_host in ("0.0.0.0", "::", ""):
        # A wildcard bind is not "127.0.0.1 with a wider view": saying so
        # plainly, next to the warning, is the difference between a user who
        # knows their network can reach this and one who does not.
        print("  listening  http://%s:%d%s (every interface)" % (bound_host or "0.0.0.0", bound_port, HEALTH_PATH))
        print("             http://127.0.0.1:%d%s on this machine" % (bound_port, HEALTH_PATH))
    else:
        print("  listening  http://%s:%d%s" % (bound_host, bound_port, HEALTH_PATH))
    print("  backend    %s" % state.backend)
    print("  model      %s" % engine.model_name)
    print("  cache      %s" % engine.model_dir)
    if state.ready:
        print("  ready      yes")
        print("  stop       Ctrl+C")
    else:
        print("  ready      no - %s" % state.reason)
        detail = engine.backend_detail()
        if detail:
            print("  why        %s" % detail)
    print("")

    engine.start_preload()

    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        print("\nStopping.")
    finally:
        server.server_close()
    return 0


# ======================================================================
# Self-tests
# ======================================================================


class Checks:
    """Collects PASS/FAIL/SKIP lines and the summary every test prints."""

    def __init__(self, title: str):
        self.title = title
        self.passed = 0
        self.failed = 0
        self.skipped = 0

    def ok(self, label: str, condition: bool, detail: str = "") -> bool:
        if condition:
            self.passed += 1
            print("  PASS  %s%s" % (label, " - %s" % detail if detail else ""))
        else:
            self.failed += 1
            print("  FAIL  %s%s" % (label, " - %s" % detail if detail else ""))
        return condition

    def skip(self, label: str, why: str) -> None:
        self.skipped += 1
        print("  SKIP  %s - %s" % (label, why))

    def summary(self) -> int:
        print("")
        print(
            "%s: %d passed, %d failed%s"
            % (self.title, self.passed, self.failed, ", %d skipped" % self.skipped if self.skipped else "")
        )
        if self.failed:
            print("%s: FAIL" % self.title)
            return 1
        print("%s: PASS" % self.title)
        return 0


def _request(
    port: int,
    method: str,
    path: str,
    body: Optional[bytes] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: float = 30.0,
) -> Tuple[int, Dict[str, str], bytes]:
    """One HTTP request against the selftest server. Returns (status, headers, body)."""
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        lower = {key.lower(): value for key, value in response.getheaders()}
        return response.status, lower, payload
    finally:
        connection.close()


def _json_body(payload: bytes) -> object:
    try:
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None


def _numpy_available() -> bool:
    try:
        import numpy  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False


def _wav_stream(channels: int, width: int, rate: int, values: Sequence[int], signed: bool = True) -> io.BytesIO:
    """A real WAV file, in memory, for testing the decoder without a disk."""
    frames = b"".join(int(value).to_bytes(width, "little", signed=signed) for value in values)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(width)
        handle.setframerate(rate)
        handle.writeframes(frames)
    buffer.seek(0)
    return buffer


def _check_wav_decoder(checks: "Checks", engine: Engine) -> None:
    """
    The decoder the openai-whisper fallback leans on, measured on real bytes.

    This is the one part of the fallback backend that can be exercised without
    the model installed, and it is worth exercising: the samples are built here,
    so a wrong byte order, a missed sign extension or a downmix that drops a
    channel is a failing assertion rather than something the user discovers by
    speaking into it.
    """

    def decode(channels: int, width: int, rate: int, values: Sequence[int], signed: bool = True):
        return engine._decode_wav_16k_mono(_wav_stream(channels, width, rate, values, signed))

    try:
        samples = decode(1, 2, SAMPLE_RATE, [0, 16384, -16384, 32767])
        checks.ok("16 kHz mono PCM16 decodes to one sample per frame", len(samples) == 4, "%d samples" % len(samples))
        checks.ok(
            "and the sample values survive the round trip",
            abs(float(samples[1]) - 0.5) < 0.001 and abs(float(samples[2]) + 0.5) < 0.001,
            "%s" % [round(float(value), 4) for value in samples],
        )
    except DecodeFailed as exc:
        checks.ok("16 kHz mono PCM16 decodes", False, str(exc))

    try:
        second = decode(2, 2, 44100, [16384] * (44100 * 2))
        middle = float(second[SAMPLE_RATE // 2])
        checks.ok(
            "44.1 kHz stereo is downmixed and resampled to 16 kHz",
            len(second) == SAMPLE_RATE and abs(middle - 0.5) < 0.01,
            "%d samples, middle %.4f" % (len(second), middle),
        )
    except DecodeFailed as exc:
        checks.ok("44.1 kHz stereo is downmixed and resampled", False, str(exc))

    try:
        eight = decode(1, 1, SAMPLE_RATE, [128, 192, 64], signed=False)
        twenty_four = decode(1, 3, SAMPLE_RATE, [-1000000])
        thirty_two = decode(1, 4, SAMPLE_RATE, [1073741824])
        checks.ok(
            "8, 24 and 32 bit WAVs decode with the right sign",
            abs(float(eight[1]) - 0.5) < 0.01
            and abs(float(eight[2]) + 0.5) < 0.01
            and abs(float(twenty_four[0]) + 0.1192) < 0.001
            and abs(float(thirty_two[0]) - 0.5) < 0.001,
            "8-bit %.4f, 24-bit %.4f, 32-bit %.4f"
            % (float(eight[1]), float(twenty_four[0]), float(thirty_two[0])),
        )
    except DecodeFailed as exc:
        checks.ok("8, 24 and 32 bit WAVs decode", False, str(exc))

    for label, payload in (
        ("bytes that are not a WAV", b"this is not a riff file at all"),
        ("an empty stream", b""),
    ):
        try:
            engine._decode_wav_16k_mono(io.BytesIO(payload))
            checks.ok("%s is refused, not guessed at" % label, False, "it decoded something")
        except DecodeFailed as exc:
            checks.ok("%s is refused, not guessed at" % label, True, type(exc).__name__)


def run_selftest(config: Config) -> int:
    """
    The contract, asserted against a real server on an ephemeral port.

    This runs with no microphone, no network and no model: it is the only test
    of this file that can run on a machine where PyPI is unreachable, so it is
    written to be honest about the one thing it cannot check (that a real model
    transcribes) rather than to look complete.
    """
    checks = Checks("selftest")
    engine = Engine(config)
    server = SttServer(("127.0.0.1", 0), engine, quiet=True)
    port = server.server_address[1]
    worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    worker.start()

    print("Xana local speech-to-text - selftest on port %d" % port)
    print("  backend %s, model %s, cache %s" % (engine.backend, engine.model_name, engine.model_dir))
    print("")

    try:
        # ---- /health -------------------------------------------------
        status, headers, payload = _request(port, "GET", HEALTH_PATH)
        health = _json_body(payload)
        checks.ok("/health answers 200 with JSON", status == 200 and isinstance(health, dict), "status %d" % status)
        if not isinstance(health, dict):
            health = {}

        expected_keys = {"ok", "service", "version", "backend", "model", "ready", "reason"}
        checks.ok(
            "/health carries exactly the contract keys",
            set(health.keys()) == expected_keys,
            "keys %s" % sorted(health.keys()),
        )
        checks.ok(
            "/health names the service and version",
            health.get("service") == SERVICE and health.get("version") == VERSION,
            "service=%r version=%r" % (health.get("service"), health.get("version")),
        )
        checks.ok(
            "/health reports a known backend",
            health.get("backend") in ("faster-whisper", "whisper", "none"),
            "backend=%r" % health.get("backend"),
        )
        checks.ok("/health reports the configured model", health.get("model") == config.model, "model=%r" % health.get("model"))
        checks.ok(
            "/health says whether it is ready, as a boolean",
            isinstance(health.get("ready"), bool),
            "ready=%r" % health.get("ready"),
        )
        checks.ok(
            "ready:true implies a real backend",
            not health.get("ready") or health.get("backend") in ("faster-whisper", "whisper"),
            "ready=%r backend=%r" % (health.get("ready"), health.get("backend")),
        )
        checks.ok(
            "ready:false carries a reason",
            bool(health.get("ready")) or bool(health.get("reason")),
            "reason=%r" % health.get("reason"),
        )
        if health.get("backend") == "none":
            reason = str(health.get("reason") or "")
            checks.ok(
                "no backend names the install command",
                "pip install" in reason,
                "reason=%r" % reason,
            )
        else:
            checks.skip("no backend names the install command", "a backend is installed here (%s)" % health.get("backend"))
        checks.ok(
            "/health is not cacheable",
            headers.get("cache-control") == "no-store",
            "cache-control=%r" % headers.get("cache-control"),
        )

        # ---- CORS ----------------------------------------------------
        status, headers, _ = _request(port, "GET", HEALTH_PATH, headers={"Origin": "http://localhost:4310"})
        checks.ok(
            "CORS reflects a localhost origin",
            headers.get("access-control-allow-origin") == "http://localhost:4310",
            "allow-origin=%r" % headers.get("access-control-allow-origin"),
        )
        status, headers, _ = _request(port, "GET", HEALTH_PATH, headers={"Origin": "http://127.0.0.1:4310"})
        checks.ok(
            "CORS reflects a 127.0.0.1 origin",
            headers.get("access-control-allow-origin") == "http://127.0.0.1:4310",
            "allow-origin=%r" % headers.get("access-control-allow-origin"),
        )
        status, headers, _ = _request(port, "GET", HEALTH_PATH, headers={"Origin": "https://example.com"})
        checks.ok(
            "CORS does not reflect a foreign origin",
            headers.get("access-control-allow-origin") is None,
            "allow-origin=%r" % headers.get("access-control-allow-origin"),
        )
        status, headers, _ = _request(port, "GET", HEALTH_PATH, headers={"Origin": "http://127.0.0.1.evil.example"})
        checks.ok(
            "CORS does not reflect a lookalike origin",
            headers.get("access-control-allow-origin") is None,
            "allow-origin=%r" % headers.get("access-control-allow-origin"),
        )
        status, headers, _ = _request(port, "GET", HEALTH_PATH)
        checks.ok(
            "CORS sends * when there is no Origin",
            headers.get("access-control-allow-origin") == "*",
            "allow-origin=%r" % headers.get("access-control-allow-origin"),
        )
        status, headers, _ = _request(
            port,
            "OPTIONS",
            TRANSCRIBE_PATH,
            headers={
                "Origin": "http://localhost:4310",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
            },
        )
        allowed_methods = headers.get("access-control-allow-methods") or ""
        checks.ok(
            "OPTIONS is a 204 preflight that allows POST",
            status == 204 and "POST" in allowed_methods and headers.get("access-control-allow-origin") == "http://localhost:4310",
            "status %d, methods %r" % (status, allowed_methods),
        )

        # ---- /transcribe: refusals -----------------------------------
        status, _, payload = _request(
            port, "POST", TRANSCRIBE_PATH, body=b"not audio", headers={"Content-Type": "text/plain"}
        )
        body = _json_body(payload)
        checks.ok(
            "a non-audio Content-Type is 415 with an error",
            status == 415 and isinstance(body, dict) and bool(body.get("error")),
            "status %d, body %r" % (status, body),
        )

        status, _, payload = _request(port, "POST", TRANSCRIBE_PATH, body=b"", headers={"Content-Type": "audio/wav"})
        body = _json_body(payload)
        checks.ok(
            "an empty body is heard-nothing, not an error",
            status == 200 and isinstance(body, dict) and body.get("text") == "",
            "status %d, body %r" % (status, body),
        )

        status, _, payload = _request(
            port, "POST", TRANSCRIBE_PATH, body=b"junk" * 64, headers={"Content-Type": "audio/wav"}
        )
        body = _json_body(payload)
        checks.ok(
            "junk bytes never answer 500",
            status != 500 and isinstance(body, dict),
            "status %d" % status,
        )
        checks.ok(
            "junk bytes answer with an empty transcript",
            isinstance(body, dict) and body.get("text") == "",
            "body %r" % body,
        )
        checks.ok(
            "a failed transcription still names its backend and model",
            isinstance(body, dict) and "backend" in body and "model" in body,
            "body %r" % body,
        )

        # A container the backend may or may not be able to read: either it
        # decodes and hears nothing, or it says 415. Both are clean answers.
        status, _, payload = _request(
            port, "POST", TRANSCRIBE_PATH, body=b"junk" * 64, headers={"Content-Type": "audio/webm"}
        )
        checks.ok(
            "an undecodable container is 415 or heard-nothing, never 500",
            status in (200, 415),
            "status %d" % status,
        )

        # ---- /transcribe: the body cap -------------------------------
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
        try:
            connection.putrequest("POST", TRANSCRIBE_PATH)
            connection.putheader("Content-Type", "audio/wav")
            connection.putheader("Content-Length", str(MAX_BODY_BYTES + 1))
            connection.endheaders()
            response = connection.getresponse()
            payload = response.read()
            oversized_status = response.status
            oversized_headers = {key.lower(): value for key, value in response.getheaders()}
        finally:
            connection.close()
        body = _json_body(payload)
        checks.ok(
            "one byte over the 10 MB cap is 413",
            oversized_status == 413 and isinstance(body, dict) and bool(body.get("error")),
            "status %d, body %r" % (oversized_status, body),
        )
        checks.ok(
            "and the refusal says it is closing, with the body unread",
            oversized_headers.get("connection") == "close",
            "connection=%r" % oversized_headers.get("connection"),
        )

        at_cap = b"\x00" * MAX_BODY_BYTES
        status, _, _ = _request(port, "POST", TRANSCRIBE_PATH, body=at_cap, headers={"Content-Type": "audio/wav"})
        checks.ok(
            "exactly at the cap is not 413",
            status != 413,
            "status %d" % status,
        )
        del at_cap

        # ---- routing -------------------------------------------------
        status, _, payload = _request(port, "GET", "/nope")
        body = _json_body(payload)
        checks.ok(
            "an unknown route is 404 with an error",
            status == 404 and isinstance(body, dict) and bool(body.get("error")),
            "status %d, body %r" % (status, body),
        )

        # ---- the WAV fallback decoder --------------------------------
        if _numpy_available():
            _check_wav_decoder(checks, engine)
        else:
            checks.skip("the WAV fallback decoder", "numpy is not installed on this machine")

        # ---- one request at a time, still answering -------------------
        results: List[int] = []
        lock = threading.Lock()

        def hammer() -> None:
            got, _, _ = _request(port, "GET", HEALTH_PATH)
            with lock:
                results.append(got)

        threads = [threading.Thread(target=hammer) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(20)
        checks.ok(
            "four concurrent /health calls all answer 200",
            results == [200, 200, 200, 200],
            "statuses %s" % sorted(results),
        )
    finally:
        server.shutdown()
        server.server_close()
        worker.join(5)

    print("")
    print("  note: a real transcription needs a backend and a downloaded model;")
    print("  this test proves the contract around it, not the recogniser itself.")
    return checks.summary()


def run_wake_selftest() -> int:
    """The ported matcher, against fixtures recorded from the TypeScript original."""
    checks = Checks("wake-selftest")

    for transcript, expected_matched, expected_command in WAKE_FIXTURES:
        actual = match_wake_full(transcript)
        checks.ok(
            "match %r" % transcript,
            actual.matched == expected_matched and actual.command == expected_command,
            "expected %s/%r, got %s/%r" % (expected_matched, expected_command, actual.matched, actual.command),
        )

    for transcript, phrases, expected_matched, expected_command in WAKE_PHRASE_FIXTURES:
        actual = match_wake_full(transcript, phrases)
        checks.ok(
            "match %r with phrases %s" % (transcript, phrases),
            actual.matched == expected_matched and actual.command == expected_command,
            "expected %s/%r, got %s/%r" % (expected_matched, expected_command, actual.matched, actual.command),
        )

    for text, expected in NORMALIZE_FIXTURES:
        actual = normalize_transcript(text)
        checks.ok("normalize %r" % text, actual == expected, "expected %r, got %r" % (expected, actual))

    for token, expected in FOLD_FIXTURES:
        actual = fold_token(token)
        checks.ok("fold %r" % token, actual == expected, "expected %r, got %r" % (expected, actual))

    for a, b, limit, expected in DISTANCE_FIXTURES:
        actual = edit_distance(a, b, limit)
        checks.ok(
            "distance %r/%r within %d" % (a, b, limit),
            actual == expected,
            "expected %d, got %d" % (expected, actual),
        )

    for length, expected in TOLERANCE_FIXTURES:
        actual = tolerance_for(length)
        checks.ok("tolerance for length %d" % length, actual == expected, "expected %d, got %d" % (expected, actual))

    return checks.summary()


def run_wake_parity(source: str, destination: str) -> int:
    """
    Answer a corpus of transcripts for the differential check.

    Not a user-facing mode: `scripts/check-stt.mjs` writes a corpus of
    [transcript, phrases] pairs here, then compares these answers with the ones
    it gets from the real TypeScript matcher. That comparison is what keeps this
    port from drifting, and it re-derives the truth rather than trusting a
    fixture table that could be stale.
    """
    try:
        with open(source, "r", encoding="utf-8") as handle:
            corpus = json.load(handle)
    except (OSError, ValueError) as exc:
        print("could not read the corpus %s: %s" % (source, exc), file=sys.stderr)
        return 2

    if not isinstance(corpus, list):
        print("the corpus must be a JSON list of [transcript, phrases] pairs", file=sys.stderr)
        return 2

    answers: List[List[object]] = []
    for entry in corpus:
        if not isinstance(entry, list) or not entry:
            print("every corpus entry must be [transcript] or [transcript, phrases]", file=sys.stderr)
            return 2
        transcript = str(entry[0])
        phrases = entry[1] if len(entry) > 1 and entry[1] is not None else list(DEFAULT_WAKE_PHRASES)
        matched, command = match_wake(transcript, [str(phrase) for phrase in phrases])
        answers.append([matched, command])

    try:
        with open(destination, "w", encoding="utf-8") as handle:
            json.dump(answers, handle, ensure_ascii=False)
    except OSError as exc:
        print("could not write %s: %s" % (destination, exc), file=sys.stderr)
        return 2

    return 0


# ======================================================================
# Entry point
# ======================================================================


def _env_int(name: str, fallback: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return fallback
    try:
        return int(raw.strip())
    except ValueError:
        raise SystemExit("%s must be a whole number, not %r" % (name, raw))


def _utf8_console() -> None:
    """
    Keep a PASS/FAIL line printable on a console whose codepage is not UTF-8,
    and keep the startup banner visible when the output goes to a file.

    The second half is not cosmetic: Python block-buffers stdout when it is
    redirected, so the banner - which says which port is listening and whether
    the service is ready - would sit in an 8 KB buffer until it filled or the
    process exited. Redirected output is exactly how a launcher or a log
    captures this program, and a banner nobody can see is not a banner.
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        except (AttributeError, ValueError, OSError):
            pass


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="xana_stt.py",
        description="Xana's local speech-to-text sidecar: a loopback HTTP service over Whisper.",
    )
    parser.add_argument("--host", default=os.environ.get("XANA_STT_HOST") or DEFAULT_HOST, help="bind address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=_env_int("XANA_STT_PORT", DEFAULT_PORT), help="bind port (default 4319)")
    parser.add_argument("--model", default=os.environ.get("XANA_STT_MODEL") or DEFAULT_MODEL, help="Whisper model name (default base)")
    parser.add_argument(
        "--backend",
        default=os.environ.get("XANA_STT_BACKEND") or DEFAULT_BACKEND,
        choices=list(BACKENDS),
        help="which engine to use (default auto)",
    )
    parser.add_argument("--model-dir", default=default_model_dir(), help="where a downloaded model lives")
    parser.add_argument("--quiet", action="store_true", help="do not log every request")
    parser.add_argument("--selftest", action="store_true", help="assert the HTTP contract and exit")
    parser.add_argument("--wake-selftest", action="store_true", help="assert the wake-word port and exit")
    parser.add_argument(
        "--wake-parity",
        nargs=2,
        metavar=("INPUT", "OUTPUT"),
        help="answer a JSON corpus of transcripts (used by scripts/check-stt.mjs)",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    _utf8_console()
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.wake_parity:
        return run_wake_parity(args.wake_parity[0], args.wake_parity[1])

    if args.wake_selftest:
        return run_wake_selftest()

    if not 0 <= args.port <= 65535:
        print("--port must be between 0 and 65535, not %d" % args.port, file=sys.stderr)
        return 2
    if not args.model.strip():
        print("--model must not be empty", file=sys.stderr)
        return 2

    config = Config(
        host=args.host.strip(),
        port=args.port,
        model=args.model.strip(),
        backend=args.backend,
        model_dir=args.model_dir,
        quiet=bool(args.quiet),
    )

    if args.selftest:
        return run_selftest(config)

    return serve(config)


if __name__ == "__main__":
    sys.exit(main())
