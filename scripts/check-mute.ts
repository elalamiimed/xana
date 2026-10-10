/**
 * The mute button: one press, and she stops talking.
 *
 *   node --import ./scripts/ts-loader.mjs scripts/check-mute.ts
 *
 * WHY THIS FILE EXISTS
 *
 * The request was a sentence about the moment, not about a setting: "whenever i
 * text xana she just keeps on talking, and it is annoying. add a button to mute
 * her." Reading replies aloud was already a switch in Settings, and a switch in
 * a panel is the wrong shape for that complaint — while a sentence is playing it
 * is four actions away, three of them behind the sound. So the feature is a
 * button, and the two properties that make it a button rather than a remote
 * control for the panel are what this file measures:
 *
 *   1. **It is instant.** The mute is read out of a ref that the press writes,
 *      not out of React state, because a reply can land between the press and
 *      the re-render — the setting travels by PUT and the message by fetch — and
 *      a reply that arrives in that window would be spoken by the very control
 *      the user pressed to silence her. That is not a timing detail; it is the
 *      difference between a mute and a mute that sometimes does not work.
 *
 *   2. **It is not the setting.** It writes `voice.muted`, never
 *      `voice.speakReplies`, so unmuting gives back exactly the preference the
 *      user chose. A second switch that quietly rewrote the first is a control
 *      people stop trusting, and the failure is invisible: the panel would
 *      simply be wrong the next time it opened.
 *
 * WHAT IS ASSERTED
 *
 *   - the identity: putting the mute back gives back what was there;
 *   - the one interaction between the two, at the store, because that is the
 *     only place both writers pass through: asking for her voice switches the
 *     mute off, and no other patch touches it;
 *   - the value survives the real settings file, written and read back, with a
 *     hand-edited file coerced rather than trusted;
 *   - the four pieces of wiring that make it instant: the ref, the synchronous
 *     write, the `stopSpeaking()` call beside it, and the microphone being
 *     released rather than left shut.
 *
 * The last group is a source reading, and it is the assertion that keeps the
 * feature from silently un-shipping itself. Every line it names looked correct
 * in the version without the button — that is the failure mode `check-pause`
 * describes and this file inherits.
 */

import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function group(title: string, run: () => void): void {
  console.log(`\n${title}\n`);
  try {
    run();
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${title} threw — ${err instanceof Error ? err.message : String(err)}`);
  }
}

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/* ------------------------------------------------------------------ */
/* The store, through a real settings file                             */
/* ------------------------------------------------------------------ */

/**
 * A throwaway data directory, so this never touches the user's own settings.
 *
 * `XANA_DATA_DIR` is set before the import because the store resolves its
 * directory at module load — the same reason `check-pause` imports dynamically.
 */
const scratch = mkdtempSync(join(tmpdir(), "xana-mute-"));
process.env.XANA_DATA_DIR = scratch;

const settings = await import("../src/lib/settings/store");

/** The value on disk, re-read so the cache cannot answer for the file. */
const stored = (): { speakReplies: boolean; muted: boolean } => {
  settings.invalidateSettingsCache();
  const voice = settings.loadSettings().voice;
  return { speakReplies: voice.speakReplies, muted: voice.muted };
};

const patch = (voice: Parameters<typeof settings.mergePatch>[1]["voice"]) => {
  settings.saveSettings(settings.mergePatch(settings.loadSettings(), { voice }));
  return stored();
};

group("A mute that can be taken back", () => {
  const before = stored();
  check("a fresh install is not muted", before.muted === false, String(before.muted));

  // The preference is switched on first, which is the state the report came
  // from: she reads every reply aloud.
  const speaking = patch({ speakReplies: true });
  check("she can be set to read replies aloud", speaking.speakReplies === true);

  const silenced = patch({ muted: true });
  check("the mute is stored", silenced.muted === true);
  check(
    "and the preference is untouched by it",
    silenced.speakReplies === true,
    `speakReplies=${silenced.speakReplies}`,
  );

  // The property that makes the button safe to press. If the mute had been
  // written as `speakReplies: false` this is where it would show: the switch
  // would come back off and the user would have to find it again.
  const back = patch({ muted: false });
  check("unmuting gives back exactly what was there", back.speakReplies === true && back.muted === false);
});

group("Editing anything else leaves the mute alone", () => {
  patch({ speakReplies: true, muted: true });
  check("muted with the preference on", stored().muted === true && stored().speakReplies === true);

  /**
   * THE BUG A REVIEW FOUND, and the reason this group is shaped this way.
   *
   * The first version of the store rule was "a patch with `speakReplies: true`
   * and no `muted` lifts the mute". The Voice panel always sends `speakReplies`,
   * so moving the Speed slider — or pressing Save with nothing changed at all —
   * silently unmuted her. The panel's own copy promised the opposite. The rule
   * is a transition now, and this is the patch that caught it: byte for byte
   * what `VoicePanel.save()` sends after a Speed change.
   */
  const afterRateSave = patch({
    speakReplies: true,
    voiceName: "",
    rate: 0.95,
    pitch: 1,
    wakeEnabled: false,
    wakePhrases: "xana",
    transcribe: "local",
    speechLang: "",
    pauseMs: 4_000,
  });
  check(
    "saving the voice panel with an unrelated change does not unmute her",
    afterRateSave.muted === true,
    `muted=${afterRateSave.muted} — this is the panel's own Save, and it must not lift the mute`,
  );
  check("and it really did save the thing that was changed", afterRateSave.speakReplies === true);

  // Pressing Save with nothing changed is the same patch, and must be equally
  // harmless.
  const afterNoopSave = patch({ speakReplies: true, rate: 1 });
  check("nor does pressing Save without changing anything", afterNoopSave.muted === true);

  // The preference moving is what clears it, in both directions.
  const switchedOff = patch({ speakReplies: false });
  check("switching the preference off clears the mute", switchedOff.muted === false);
  check("and the preference is off", switchedOff.speakReplies === false);

  const switchedOn = patch({ speakReplies: true });
  check("switching it on clears it too, so she is heard", switchedOn.muted === false);
  check("and the preference is on", switchedOn.speakReplies === true);

  // An explicit mute in the same patch still wins, so a scripted caller keeps
  // full control rather than being corrected by the store.
  const both = patch({ speakReplies: false, muted: true });
  check("an explicit mute in the same patch wins", both.muted === true);
  patch({ muted: false, speakReplies: false });
});

group("A hand-edited file is coerced, not trusted", () => {
  const file = settings.settingsPath();
  const write = (voice: unknown) => {
    const current = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    settings.saveSettings(
      settings.coerceSettings({ ...current, voice: { ...(current.voice as object), ...(voice as object) } }),
    );
    return stored();
  };

  check("a string is not a boolean", write({ muted: "yes" }).muted === false);
  check("nor is a number", write({ muted: 1 }).muted === false);
  check("nor is null", write({ muted: null }).muted === false);
  check("a stored false stays false", write({ muted: false }).muted === false);
  check("a stored true survives a reload", write({ muted: true }).muted === true);
  check(
    "and it is a boolean in the file, not a word",
    typeof (JSON.parse(readFileSync(file, "utf8")) as { voice: { muted: unknown } }).voice.muted ===
      "boolean",
  );
  write({ muted: false });
});

/* ------------------------------------------------------------------ */
/* The wiring that makes the press instant                             */
/* ------------------------------------------------------------------ */

group("The press is read synchronously, not from state", () => {
  const page = read("src/app/page.tsx");

  check(
    "the speaking effect consults the mute ref",
    /if \(mutedRef\.current \|\| !speechSynthesisAvailable\(\)\) return;/.test(page),
    "a reply landing in the PUT window would be spoken by the button that silenced her",
  );
  /**
   * And it consults it AFTER claiming the reply.
   *
   * The claim is what stops a sentence being said twice. Returning above it left
   * a muted reply still "unspoken", and this effect re-runs whenever the voice,
   * rate or pitch changes — so muting, texting her, and then moving the Speed
   * slider read out the reply that had already been silenced. A muted reply is
   * done: written, not spoken, never to be spoken.
   */
  check(
    "the reply is claimed before the mute is consulted",
    /spokenRef\.current = latest\.id;\s*\n\s*\n\s*if \(mutedRef\.current/.test(page),
    "otherwise a muted reply stays pending and is read aloud by the next voice change",
  );
  check("the ref exists", /const mutedRef = useRef\(muted\)/.test(page));
  check(
    "the ref is kept in step with the stored value",
    /mutedRef\.current = muted;/.test(page),
    "a mute cleared in the panel would not be honoured here",
  );
  check(
    "the press writes the ref before anything else",
    /const next = !mutedRef\.current;\s*\n\s*mutedRef\.current = next;/.test(page),
  );
  check(
    "and stops the sentence that is playing",
    /mutedRef\.current = next;\s*\n\s*stopSpeaking\(\);/.test(page),
    "the mute would apply to the next reply and not to this one",
  );
});

group("Silencing her does not leave the microphone shut", () => {
  const page = read("src/app/page.tsx");

  /**
   * `speaking` is what holds always-listening paused, so a mute that stopped the
   * audio without clearing it would leave the microphone closed until she
   * happened to speak again — silencer and deafener in one control.
   */
  check(
    "the mute clears the speaking flag",
    /stopSpeaking\(\);\s*\n\s*setSpeaking\(false\);/.test(page),
    "always-listening would stay paused after the mute",
  );
  check(
    "the wake listener is still paused on speaking",
    /paused: thinking \|\| speaking,/.test(page),
  );
  check(
    "and the orb's own stop does the same thing",
    /stopSpeaking\(\);\s*\n\s*\/\/ `stopSpeaking` cancels the utterance/.test(page),
  );
  /**
   * And the orb is not a dead control while she is muted.
   *
   * The tap has two branches: stop a sentence, or open settings. With the mute
   * on there is usually nothing playing, and the first version still took the
   * stop branch — so the one control a person taps when she is too loud did
   * nothing at all, in the state they had just put her in.
   */
  check(
    "and it does not swallow the tap while muted",
    /if \(speakReplies && !muted && speechSynthesisAvailable\(\)\)/.test(page),
    "while muted the orb must fall through to settings, where the voice lives",
  );
});

group("The button does not rewrite the preference", () => {
  const page = read("src/app/page.tsx");
  const header = read("src/components/xana/AdapterDots.tsx");

  check(
    "the toggle writes voice.muted",
    /shell\.controller\.save\(\{ voice: \{ muted: next \} \}\)/.test(page),
  );
  check(
    "and never voice.speakReplies",
    !/save\(\{[^}]*speakReplies/.test(page),
    "the header button must leave the chosen preference alone",
  );
  /**
   * The mute must not wait on the network.
   *
   * This used to slice `page.tsx` around `const toggleMuted` and look for
   * `disabled={saving}` — a check that could not fail for the property it named,
   * twice over: the identifier is not in this file after a rename, so the slice
   * was the empty string and `!/(?!)/.test("")` is true; and the header button
   * lives in `AdapterDots.tsx`, which the slice never looked at. Asserted where
   * the control actually is, and against the props it actually takes.
   */
  check(
    "the mute does not wait on the round trip",
    /const next = !mutedRef\.current;/.test(page) &&
      /const started = speak\(/.test(page) &&
      !/disabled=\{(?:saving|busy)\}/.test(header) &&
      // `MuteButton` takes four props and none of them is a pending flag.
      /speakReplies: boolean;[\s\S]{0,200}ready: boolean;[\s\S]{0,120}onToggle: \(\) => void;/.test(header),
    "the press has to take effect before the PUT, and the control must not be disabled behind it",
  );
});

group("The control is a real, labelled toggle", () => {
  const header = read("src/components/xana/AdapterDots.tsx");

  check("it is a button", /<button[\s\S]{0,200}onClick=\{onToggle\}/.test(header));
  check("it reports its state", /aria-pressed=\{muted\}/.test(header), "a sighted-only state is not a state");
  /**
   * ONE NAME, AND THE STATE SAID ONCE.
   *
   * The W3C APG is explicit for a toggle: the label must not change with the
   * state, and a control that renames itself "Unmute" does not need
   * `aria-pressed` at all. The first version here did both, so a screen reader
   * announced the state twice, in two tenses: "Unmute her voice. She will read
   * replies aloud again., toggle button, pressed".
   */
  check(
    "the label is constant and does not narrate the state",
    /aria-label="Mute her voice\. Replies are still written\."/.test(header),
    "a toggle's name must not change with its state (W3C APG)",
  );
  check(
    "and nothing still switches the label on the state",
    !/aria-label=\{muted \?/.test(header) && !/title=\{muted \?/.test(header),
  );
  /**
   * The icon is the label, so it has to change.
   *
   * The button is icon-only — three word-buttons do not fit at 390px — which
   * makes the glyph the only thing a sighted user can read the state from. A
   * mute that swapped nothing but a border colour would be a colour-only state
   * signal, which DESIGN.md §6 refuses outright, so the crossed-out speaker and
   * the bare one are asserted as two different drawings.
   */
  check(
    "the icon changes with the state",
    /className="icon-tap/.test(header) &&
      /d="M9\.8 5\.6 12\.6 8\.4M12\.6 5\.6 9\.8 8\.4"/.test(header) &&
      /d="M9\.6 5\.5a3\.1 3\.1 0 0 1 0 3M11\.5 4a5\.4 5\.4 0 0 1 0 6"/.test(header),
    "the speaker and the crossed-out speaker must both be drawn",
  );
  check(
    "it carries the tap floor",
    /className="icon-tap /.test(header),
    "an icon-only header control is the easiest one to draw under 44px",
  );
  check(
    "it is drawn only where speech synthesis exists",
    /if \(!ready\) return null;/.test(header) && /speechReady=\{speechReady\}/.test(read("src/app/page.tsx")),
    "a control that cannot do anything is worse than no control",
  );
  check(
    "and only when she is set to read replies aloud",
    /if \(!speakReplies\) return null;/.test(header),
    "with the preference off there is nothing to silence, and a pressed speaker would describe a state that cannot happen",
  );
  check(
    "the guard is not the old `!speakReplies && !muted`",
    !/if \(!speakReplies && !muted\) return null;/.test(header),
    "that form DRAWS the control in the state its comment claims to hide",
  );
  check(
    "the shell passes the preference and the state",
    /speakReplies=\{speakReplies\}/.test(header) && /muted=\{muted\}/.test(header),
  );
});

group("A third control cannot push the header off the phone", () => {
  const header = read("src/components/xana/AdapterDots.tsx");

  /**
   * The regression this feature caused, kept from coming back.
   *
   * Flexbox wraps *between* items, not inside one, so a group that is alone on
   * its own line is never told it is too wide: with three controls the right-hand
   * group measured 435px inside a 326px header and ran to x=467 in a 390px
   * window, while `document.documentElement.scrollWidth` stayed at 390 — because
   * the page never asked to scroll. Every check in this repo passed while
   * Settings was half off the screen.
   *
   * `min-w-0` is the specific fix, and `verify:mute-browser` is the measurement:
   * it reports which header controls, if any, escape the viewport.
   */
  check(
    "the control group may shrink below its content",
    /flex min-w-0 flex-wrap items-center justify-end/.test(header),
    "without min-w-0 a flex item refuses to go below its content and overflows instead of wrapping",
  );
  check(
    "there is slack for it to take when everything fits",
    /<div className="flex-1" aria-hidden="true" \/>/.test(header),
    "the spacer is what keeps one row on a wide screen and lets the row fold on a phone",
  );
  check(
    "and the words are only carried by the two controls that can afford them",
    /max-\[420px\]:px-2/.test(header) && !/\{muted \? "Muted" : "Mute"\}/.test(header),
    "the third label is what overflowed; the icon-tap control carries its name in aria-label instead",
  );
});

group("The other door into the same state", () => {
  const panel = read("src/components/xana/settings/VoicePanel.tsx");

  /**
   * The panel has to be able to say "muted" and to undo it. Without this, the
   * only unmute is a control the user cannot find after they have stopped
   * looking at the header — and a settings screen reporting "read replies
   * aloud: on" over a silent assistant is the app disagreeing with itself.
   *
   * The pattern includes the `{` and the `?` on purpose. The first version of
   * this check read `/view\.voice\.muted/`, which the explanatory COMMENT above
   * the JSX satisfies by itself — so replacing the live read with a
   * `useState(view.voice.muted)` copy seeded on open would still have passed. A
   * check that the prose can satisfy is a check of the prose.
   */
  check(
    "the panel reads the live mute rather than a copy taken on open",
    /\{view\.voice\.muted \? \(/.test(panel),
    "a local copy seeded on open would go on saying 'not muted' over a muted app",
  );
  check(
    "and it is not kept in a state variable",
    !/useState\(\s*view\.voice\.muted/.test(panel),
  );
  check("it says she is muted", /Muted —/.test(panel));
  check(
    "and offers the way out",
    /onClick=\{\(\) => void onSave\(\{ voice: \{ muted: false \} \}\)\}/.test(panel),
  );
  /**
   * The way out is offered whenever the mute is set, not only when the switch
   * agrees with it. Keyed on the switch, a mute left in a hand-edited file with
   * the preference off has no door at all: the header hides itself (correctly)
   * and the panel stays quiet about it.
   */
  check(
    "the way out does not depend on the switch agreeing",
    !/\{speakReplies && view\.voice\.muted \?/.test(panel),
  );
});

/* ------------------------------------------------------------------ */

rmSync(scratch, { recursive: true, force: true });

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
