"use client";

import { useEffect, useState } from "react";

import type { SettingsView, VoiceSettings } from "@/lib/settings/types";

import {
  Actions,
  Button,
  Section,
  SelectField,
  Slider,
  StatusLine,
  Switch,
  TextField,
} from "./controls";
import {
  listVoices,
  speak,
  speechSynthesisAvailable,
  stopSpeaking,
} from "../speech";
import { getSpeechRecognition } from "../speech";
import { canRecord, ensureLocalTranscriber, transcriberHealth, type TranscriberHealth } from "../local-speech";
import {
  SPEECH_LANGUAGES,
  browserLanguages,
  languageLabel,
  resolveSpeechLanguage,
} from "../speech-language";
import { DEFAULT_WAKE_PHRASES } from "../wake-word";

/**
 * Voice: how she sounds when she speaks out loud.
 *
 * Every control here has a "hear it" affordance within reach, because
 * speech settings are impossible to choose from a number. Rate is a slider
 * *and* an immediate sample; the voice picker previews on change. Choosing a
 * voice from a dropdown and then discovering it sounds wrong three
 * conversations later is the failure this panel exists to prevent.
 */

const SAMPLE = "Here is the shape of the day. Two things are overdue, and your first meeting moved to eleven.";

export interface VoicePanelProps {
  view: SettingsView;
  onSave: (patch: {
    voice?: Partial<VoiceSettings>;
  }) => Promise<unknown>;
  saving: boolean;
}

export default function VoicePanel({ view, onSave, saving }: VoicePanelProps) {
  const [speakReplies, setSpeakReplies] = useState(view.voice.speakReplies);
  const [voiceName, setVoiceName] = useState(view.voice.voiceName);
  const [rate, setRate] = useState(view.voice.rate);
  const [pitch, setPitch] = useState(view.voice.pitch);
  const [wakeEnabled, setWakeEnabled] = useState(view.voice.wakeEnabled);
  const [wakePhrases, setWakePhrases] = useState(view.voice.wakePhrases);
  const [transcribe, setTranscribe] = useState<"browser" | "local">(view.voice.transcribe);
  const [speechLang, setSpeechLang] = useState(view.voice.speechLang);
  /** Held in milliseconds, shown in seconds. See the slider's comment. */
  const [pauseMs, setPauseMs] = useState(view.voice.pauseMs);
  /** Whether the local transcriber is actually running, measured not assumed. */
  const [localState, setLocalState] = useState<TranscriberHealth | null>(null);
  const [probing, setProbing] = useState(false);
  /** What the app said when it tried to start the service, if it could not. */
  const [startNote, setStartNote] = useState("");

  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [supported, setSupported] = useState(false);
  const [saved, setSaved] = useState(false);
  /**
   * Whether input recognition exists at all.
   *
   * Deliberately separate from `supported`, which is about output. A browser can
   * speak and not listen (no `SpeechRecognition`), and offering a
   * hands-free switch in one would be offering a control that cannot work.
   */
  const [canListen, setCanListen] = useState(false);

  /**
   * Voices arrive late in Chromium: the first `getVoices()` call usually
   * returns an empty array and the list lands on `voiceschanged` shortly
   * after. Without this second read the picker would confidently report
   * that the machine has no voices, which is wrong and confusing.
   */
  useEffect(() => {
    if (!speechSynthesisAvailable()) {
      setSupported(false);
      return;
    }
    setSupported(true);
    setVoices(listVoices());

    const synth = window.speechSynthesis;
    const onVoicesChanged = () => setVoices(listVoices());
    synth.addEventListener?.("voiceschanged", onVoicesChanged);
    setCanListen(getSpeechRecognition() !== null);
    return () => {
      synth.removeEventListener?.("voiceschanged", onVoicesChanged);
      // Leaving the page with a voice mid-sentence is startling.
      stopSpeaking();
    };
  }, []);

  const preview = (overrides: Partial<VoiceSettings> = {}) => {
    speak(SAMPLE, {
      voiceName: overrides.voiceName ?? voiceName,
      rate: overrides.rate ?? rate,
      pitch: overrides.pitch ?? pitch,
    });
  };

  const save = async () => {
    const next = await onSave({
      voice: { speakReplies, voiceName, rate, pitch, wakeEnabled, wakePhrases, transcribe, speechLang, pauseMs },
    });
    if (next) setSaved(true);
  };

  /**
   * What the browser is asking for, and what will actually be sent.
   *
   * Worth showing rather than hiding behind "Automatic", because the two differ
   * in exactly the case this control exists for: a browser that reports the bare
   * tag `en` is a browser whose speech service will refuse it, and a user who can
   * see "the browser asks for en, dictation uses English (United States)" has the
   * whole explanation of the failure they came here to fix. Read at render rather
   * than stored, since it is a property of the browser and not of the form.
   */
  const automatic = resolveSpeechLanguage("", browserLanguages());
  const effective = speechLang ? languageLabel(speechLang) || speechLang : languageLabel(automatic.tag);

  /**
   * Where transcription happens.
   *
   * The reason this is a setting at all: the browser's speech service is
   * reachable on some networks and blocked on others, and when it is blocked
   * every attempt fails with the error name `network` regardless of the
   * microphone. There is no way to detect that from here — only the user's
   * browser knows — so the choice is offered, with the state of the local
   * service measured rather than described.
   */
  const transcribeSection = (
    <Section
      title="Where speech is transcribed"
      blurb="The browser's own speech service is faster and needs nothing installed, but it is a network round trip: on a network where it is blocked, recognition fails every time no matter how good the microphone is. The local transcriber does the work on this machine instead."
    >
      <SelectField
        label="Transcription"
        value={transcribe}
        onChange={(next) => setTranscribe(next as "browser" | "local")}
        options={[
          { value: "browser", label: "The browser's speech service (default)" },
          { value: "local", label: "This machine, with local Whisper" },
        ]}
        hint="If dictation or her name keeps failing, switch to the local transcriber."
      />

      {/* The language, right under the transport, because the two failures look
          identical from the outside and neither sentence says which one it was:
          "network" is a blocked service and "language-not-supported" is a tag the
          service would not serve. This control is the fix for the second, and it
          used to be nowhere at all — the app simply sent `navigator.language` and
          told the user to go and change it. */}
      <SelectField
        label="Dictation language"
        value={speechLang}
        onChange={setSpeechLang}
        options={[
          { value: "", label: `Automatic — uses ${languageLabel(automatic.tag)}` },
          ...SPEECH_LANGUAGES.map((option) => ({ value: option.tag, label: option.label })),
        ]}
        hint={
          automatic.fromBrowser
            ? `Automatic is in use because this browser asks for "${automatic.fromBrowser}", which a speech service will not accept on its own — dictation sends ${automatic.tag} instead. Set it by hand only if that is the wrong language for you.`
            : `Applies to the browser's speech service only: the local transcriber works the language out from the audio. ${
                effective ? `Dictation will ask for ${effective}.` : ""
              }`
        }
      />

      {/*
        Room to breathe.

        The one number behind every voice path: how long a silence means the
        thought is finished. It is here rather than under Hands-free because it
        applies to the microphone button too, and the person it exists for is
        the one who stops mid-sentence to think — which happens while dictating
        as much as while talking hands-free.

        The slider is in seconds with one decimal, because "4000" is a number
        nobody has an intuition for and "4.0s" is a pause anyone can picture.
      */}
      <Slider
        label="Room to breathe"
        value={pauseMs / 1000}
        min={1.5}
        max={10}
        step={0.5}
        onChange={(next) => setPauseMs(Math.round(next * 1000))}
        format={(value) => `${value.toFixed(1)}s`}
        hint={`How long you can stay quiet before she takes it as finished. Raise it if you think mid-sentence: at ${(pauseMs / 1000).toFixed(1)}s a pause shorter than that keeps the microphone open and nothing is sent early. Press Enter to send at once without waiting.`}
      />

      {transcribe === "local" ? (
        <>
          <Actions>
            <Button
              onClick={() => {
                setProbing(true);
                setStartNote("");
                /**
                 * Start it, then report what it says.
                 *
                 * This used to only look — which meant the answer for a user
                 * whose service was not running was "not running, go and run a
                 * PowerShell script". The app can start it, so the button does,
                 * and `ensureLocalTranscriber` is the same path the microphone
                 * and the wake word take: idempotent, and rate-limited on the
                 * server so pressing this repeatedly cannot spawn a fleet.
                 */
                void ensureLocalTranscriber()
                  .then((ensured) =>
                    transcriberHealth().then((health) => {
                      setLocalState(health);
                      if (ensured.note) setStartNote(ensured.note);
                    }),
                  )
                  .finally(() => setProbing(false));
              }}
              disabled={probing}
            >
              {probing ? "Working…" : "Start or check the local transcriber"}
            </Button>
          </Actions>

          {startNote ? <StatusLine tone="error">{startNote}</StatusLine> : null}

          {localState ? (
            localState.ready ? (
              <StatusLine tone="ok">
                Ready — {localState.backend}, model “{localState.model}”. Nothing leaves this machine.
              </StatusLine>
            ) : (
              <StatusLine tone="error">
                {localState.available
                  ? `Running but not ready. ${localState.reason}`
                  : "Not running. The app starts it when you press the mic — and if it cannot, data/stt.log says why."}
              </StatusLine>
            )
          ) : (
            <StatusLine tone="info">
              {canRecord()
                ? "Started by the app when it is needed. This button starts it now and reports what it says."
                : "This browser cannot record audio, so the local path is unavailable here."}
            </StatusLine>
          )}
        </>
      ) : null}
    </Section>
  );

  /**
   * Hands-free: the section that does NOT depend on speech synthesis.
   *
   * Rendered separately from the speaking half because listening and speaking
   * are different browser capabilities, and a browser that can only do one
   * should still offer the half it can do. Gating this behind the synthesis
   * check was the obvious mistake: it hides a working microphone behind an
   * unrelated missing feature.
   */
  const handsFree = (
    <Section
      title="Hands-free"
      blurb="Leave the microphone open, say her name, and speak your request — no button. She says what she is hearing as she hears it, so you can tell a misheard word from a reply you did not want."
    >
      {canListen ? (
        <>
          <Switch
            label="Listen for her name"
            hint="The microphone stays open while this page is in front of you. Nothing you say is treated as a request until she hears her name. She stops listening while she is speaking, so she never answers herself."
            checked={wakeEnabled}
            onChange={setWakeEnabled}
          />

          {wakeEnabled ? (
            <>
              <TextField
                label="Ways of saying her name"
                value={wakePhrases}
                onChange={setWakePhrases}
                placeholder={DEFAULT_WAKE_PHRASES.join(", ")}
                spellCheck={false}
                hint="Comma-separated. Leave empty for the built-in list. Voice recognition writes names however it hears them, so add the spellings you actually see her mishear."
              />
              <StatusLine tone="info">
                Save, then say her name from across the room. She answers with a reply, so give it a second.
              </StatusLine>
              {/* Labelled as a privacy note rather than left as a bare warning.
                  It was a bare warning, and it read as an error message — the
                  user quoted it back as though something had gone wrong. It is
                  not a failure: it is the one trade this feature makes, and it
                  belongs next to the switch that makes it. The label is the
                  shared `.label`, not a fourth uppercase recipe: 12px at
                  0.02em was the same idea drawn smaller and looser than the
                  one the rest of the interface uses. */}
              <div className="card px-4 py-3">
                <p className="label">Privacy note</p>
                <p className="mt-1.5 text-[12px] leading-relaxed font-normal text-dim">
                  The microphone belongs to the browser, not to Xana. In Edge the
                  audio goes to Microsoft&apos;s speech service and in Chrome to
                  Google&apos;s — never to Xana, and never to DeepSeek. No key is
                  involved, and nothing is stored.
                </p>
                <p className="mt-1.5 text-[12px] leading-relaxed font-normal text-faint">
                  If you would rather no audio left this machine, switch this off
                  and type instead. The browser&apos;s on-device model removes the
                  round trip entirely where it is installed — see the microphone
                  check.
                </p>
              </div>
            </>
          ) : null}
        </>
      ) : (
        <StatusLine tone="info">
          This browser does not expose speech recognition, so she cannot watch for
          her name here. Edge and Chrome can. Typing and the rest of Xana are
          unaffected.
        </StatusLine>
      )}

      {/* The diagnostic, offered from the place a user looks when the
          microphone does not work. It answers the one question this panel
          cannot: whether the machine is hearing them at all. */}
      <p className="text-[12px] leading-relaxed font-normal text-faint">
        Microphone does nothing?{" "}
        <a
          href="/xana/mic"
          className="text-dim underline decoration-hairline underline-offset-2 transition-colors duration-[var(--t-fast)] hover:text-text"
        >
          Run the microphone check
        </a>{" "}
        — it measures the hardware, the permission and the browser separately and
        says which one is failing.
      </p>
    </Section>
  );

  if (!supported) {
    return (
      <div>
        <Section
          title="Spoken replies"
          blurb="Your browser does not expose speech synthesis, so Xana will stay silent here. Everything else works exactly the same — she is a text-first assistant either way."
        >
          <StatusLine tone="info">
            Nothing to configure. Text replies are unaffected.
          </StatusLine>
        </Section>
        {handsFree}
      </div>
    );
  }

  return (
    <div>
      <Section
        title="Spoken replies"
        blurb="Xana can read her replies aloud. The voice comes from your operating system — nothing is downloaded, and nothing is sent anywhere."
      >
        <Switch
          label="Read replies aloud"
          hint="Every reply she writes is also spoken. To stop one mid-sentence without changing this, press the speaker in the header — tapping the orb stops the sentence playing now, but the next reply is still read."
          checked={speakReplies}
          onChange={setSpeakReplies}
        />

        {/*
          The mute, from the other side of the panel.

          `view.voice.muted` is read live rather than copied into state, and
          that is the whole reason it works: the mute is set from the header's
          button, this panel does not re-mount when that happens, and a local
          copy seeded on open would go on showing "not muted" over a muted app.
          The stored value is already in the prop, so the honest control is the
          one that reads it.

          It is here because a user who opens Settings to make her speak, finds
          the switch already on, and presses Save, would otherwise be left
          exactly as silent as before with the panel looking like it had agreed.
          The store clears the mute when the switch MOVES — that is what makes
          pressing Save safe — and this is the case where the switch does not
          move, so the sentence and the way out have to be here.

          Keyed on `muted` alone and not on the switch, which a review put right:
          a mute left set while the preference is off is unreachable through the
          interface but perfectly possible in a hand-edited file, and offering
          the way out of it costs one word where guessing costs the user a
          silent assistant with no explanation anywhere.
        */}
        {view.voice.muted ? (
          <>
            <StatusLine tone="info">
              {speakReplies
                ? "Muted — the sentence in progress was stopped and nothing new is being read. That is the speaker button in the header; this switch is untouched, so unmuting gives you back exactly this setting."
                : "Muted, though replies are not being read aloud anyway — nothing was going to be said either way. Clearing it costs nothing and leaves one less thing to explain later."}
            </StatusLine>
            <Actions>
              <Button
                onClick={() => void onSave({ voice: { muted: false } })}
                disabled={saving}
              >
                Unmute now
              </Button>
            </Actions>
          </>
        ) : null}

        {speakReplies ? (
          <StatusLine tone="info">
            {voices.length > 0
              ? `${voices.length} ${voices.length === 1 ? "voice" : "voices"} available on this machine.`
              : "Looking for voices… some browsers report them a moment after the page loads."}
          </StatusLine>
        ) : null}
      </Section>

      <Section title="The voice" blurb="Changing the voice plays a sample so you can hear it before you commit.">
        <SelectField
          label="Voice"
          value={voiceName}
          onChange={(next) => {
            setVoiceName(next);
            preview({ voiceName: next });
          }}
          options={[
            { value: "", label: "System default" },
            ...voices.map((voice) => ({
              value: voice.name,
              label: `${voice.name} · ${voice.lang}${voice.default ? " · default" : ""}`,
            })),
          ]}
          hint="Voices are provided by your system. Install more in your OS settings to see them here."
        />

        <Slider
          label="Speed"
          value={rate}
          min={0.5}
          max={1.5}
          step={0.05}
          format={(value) => `${value.toFixed(2)}×`}
          hint="Slightly under 1.0 tends to sound calmer. Above 1.2 starts to clip."
          onChange={setRate}
        />

        <Slider
          label="Pitch"
          value={pitch}
          min={0}
          max={2}
          step={0.05}
          format={(value) => value.toFixed(2)}
          hint="Under 1.0 is lower and steadier. Most system voices sound best near 1.0."
          onChange={setPitch}
        />

        <Actions>
          <Button onClick={() => preview()}>Hear it</Button>
          <Button onClick={stopSpeaking}>Stop</Button>
        </Actions>
      </Section>

      {transcribeSection}

      {handsFree}

      <Section title="Save">
        <Actions>
          <Button onClick={() => void save()} disabled={saving} variant="primary">
            {saving ? "Saving…" : "Save voice"}
          </Button>
          {saved ? <StatusLine tone="ok">Saved.</StatusLine> : null}
        </Actions>
      </Section>
    </div>
  );
}