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
      voice: { speakReplies, voiceName, rate, pitch, wakeEnabled, wakePhrases },
    });
    if (next) setSaved(true);
  };

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
              {/* The honest version of how this works. Saying "on-device" here
                  would be a lie in every browser that uses a speech service. */}
              <StatusLine tone="error">
                The browser owns this microphone, and in Edge and Chrome the audio
                goes to the browser&apos;s own speech service — not to Xana, and
                not to your model provider. Use the mic button, or type, if you
                would rather nothing left the machine.
              </StatusLine>
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
          hint="Every reply she writes is also spoken. You can stop her mid-sentence by tapping the orb."
          checked={speakReplies}
          onChange={setSpeakReplies}
        />

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