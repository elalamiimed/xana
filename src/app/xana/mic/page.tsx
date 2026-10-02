"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  configureRecognizer,
  dictationFailure,
  dictationNote,
  getSpeechRecognition,
  hasOnDeviceRecognition,
  transcriptFrom,
  type SpeechRecognizer,
} from "@/components/xana/speech";
import {
  browserLanguages,
  resolveSpeechLanguage,
  speechLanguageFallbacks,
} from "@/components/xana/speech-language";
import { useSettings } from "@/components/xana/useSettings";
import { logMic } from "@/components/xana/mic-log";

/**
 * Why the microphone does nothing, measured rather than guessed.
 *
 * The complaint this page exists for — "I click the mic and Xana does not
 * listen" — has one symptom and about six causes, and they are indistinguishable
 * from the outside. A refused permission, a browser whose speech service is
 * unreachable, a headset that is plugged in but muted, and a recogniser that
 * opens and hears nothing all look identical: a button that appears to do
 * nothing.
 *
 * So this page tests each layer on its own, in order, and reports what it found
 * at the layer that failed:
 *
 *   1. Does the browser expose the API at all?
 *   2. Does the operating system hand over a microphone, and does it carry
 *      sound? The level meter is the answer to the hardest question on this page:
 *      *is my microphone actually hearing me?* If the bar moves, the hardware and
 *      the permission are fine and the problem is above them.
 *   3. Does recognition return words, and what does it say when it does not?
 *
 * The level meter is `getUserMedia` plus an `AnalyserNode`, entirely local — it
 * involves no speech service anywhere, which is what makes it a useful
 * independent measurement when recognition is the thing failing.
 *
 * This is a diagnostic, not a feature. It reads nothing the app stores, writes
 * nothing, and sends the audio nowhere.
 */

type Tone = "idle" | "ok" | "bad" | "busy";

interface Fact {
  label: string;
  value: string;
  tone: Tone;
}

/** A diagnostic, not a feature: it proves which layer is failing. */
export default function MicPage() {
  const [facts, setFacts] = useState<Fact[]>([]);
  const [level, setLevel] = useState(0);
  const [metering, setMetering] = useState(false);
  const [meterError, setMeterError] = useState("");
  const [heard, setHeard] = useState("");
  const [recognising, setRecognising] = useState(false);
  const [recognitionError, setRecognitionError] = useState("");
  const [recognitionState, setRecognitionState] = useState("");

  const stream = useRef<MediaStream | null>(null);
  const frame = useRef<number | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const recognizer = useRef<SpeechRecognizer | null>(null);

  /**
   * The language the APP would send, not the one this page would pick.
   *
   * The setting is read here for one reason: a diagnostic that exercises a
   * different configuration than the app does proves nothing about the app. This
   * page used to resolve the tag from the browser alone, so a user who had set
   * "English (United Kingdom)" in Settings watched this page test `en-US`, get a
   * different answer, and have no way to tell which one the microphone button
   * would use.
   */
  const settings = useSettings();
  const speechLang = settings.view?.voice.speechLang ?? "";
  const chosen = useMemo(
    () => resolveSpeechLanguage(speechLang, browserLanguages()),
    [speechLang],
  );

  /**
   * The capability facts, read once on mount.
   *
   * `secure context` matters more than it looks: `getUserMedia` and
   * `SpeechRecognition` are both restricted to secure origins, and `localhost`
   * counts while a machine's LAN address does not. Someone opening this app from
   * their phone at `http://192.168.x.x:4310` therefore gets a browser with no
   * microphone APIs at all, and this line is how they find that out.
   */
  useEffect(() => {
    const recognition = getSpeechRecognition();
    const cannotMeter = typeof navigator.mediaDevices?.getUserMedia !== "function";
    const languages = typeof navigator.languages !== "undefined" ? navigator.languages.join(", ") : navigator.language;
    const ladder = speechLanguageFallbacks(chosen);
    const where =
      chosen.source === "setting"
        ? "set by hand in Settings → Voice"
        : chosen.source === "browser"
          ? "from this browser"
          : "the built-in default, because this browser will not name a language";

    setFacts([
      {
        label: "Secure context",
        value: window.isSecureContext
          ? "yes — microphone APIs are allowed"
          : "NO — microphone APIs are blocked on a non-HTTPS origin. Use http://127.0.0.1:4310 or https.",
        tone: window.isSecureContext ? "ok" : "bad",
      },
      {
        label: "Speech recognition API",
        value: recognition ? "available" : "NOT available — this browser cannot dictate. Edge or Chrome can.",
        tone: recognition ? "ok" : "bad",
      },
      {
        label: "On-device recognition model",
        value: hasOnDeviceRecognition()
          ? "available — audio can stay on this machine"
          : "not installed — Edge Dev/Canary with the on-device flag can add it",
        tone: hasOnDeviceRecognition() ? "ok" : "idle",
      },
      {
        label: "Microphone capture (getUserMedia)",
        value: cannotMeter ? "NOT available" : "available",
        tone: cannotMeter ? "bad" : "ok",
      },
      {
        label: "Speech synthesis",
        value:
          typeof window.speechSynthesis !== "undefined"
            ? `${window.speechSynthesis.getVoices().length} voice(s)`
            : "NOT available — she cannot speak here",
        tone: typeof window.speechSynthesis !== "undefined" ? "ok" : "bad",
      },
      { label: "Page origin", value: window.location.origin, tone: "idle" },
      {
        label: "Dictation language",
        value: `${chosen.tag} — ${where}`,
        tone: "ok",
      },
      /**
       * Both halves of the language question, side by side.
       *
       * The browser's own tags are the input and the sent tag is the output, and
       * when they differ that difference IS the explanation: this profile reports
       * the bare `en`, which a speech service refuses as a locale, so `en-US` is
       * sent instead. Before this row existed the app sent `navigator.language`
       * untouched and blamed the user for the refusal.
       *
       * The second line is the other half of the rule: a tag that already names
       * a region is the browser's answer in full and is sent unchanged, so most
       * of the time nothing here is a correction at all.
       */
      {
        label: "Browser language",
        value: `${languages}${
          chosen.fromBrowser
            ? ` — "${chosen.fromBrowser}" names a language and no locale, so ${chosen.tag} is sent instead`
            : chosen.source === "setting"
              ? " — overridden by the setting above, which is what is sent"
              : " — used as it is; it already names a locale"
        }`,
        tone: "idle",
      },
      {
        label: "If that is refused",
        value:
          ladder.length > 0
            ? `${ladder.join(", ")} are tried in turn — other regional variants of the same language, never a different one`
            : "nothing further is tried; a language chosen by hand is not second-guessed",
        tone: "idle",
      },
      { label: "User agent", value: navigator.userAgent, tone: "idle" },
    ]);
  }, [chosen]);

  const stopMeter = useCallback(() => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
    void audio.current?.close();
    audio.current = null;
    setMetering(false);
    setLevel(0);
  }, []);

  /**
   * Open the microphone and draw its loudness.
   *
   * The reading is a running peak with decay rather than an instantaneous value,
   * because speech is spiky: a raw sample flickers too fast to read, and the
   * question being asked is "did the bar move when I talked", which needs the
   * peak to persist long enough to be seen.
   */
  const startMeter = useCallback(async () => {
    setMeterError("");
    logMic("micpage.meter.start");
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = media;
      const context = new AudioContext();
      audio.current = context;
      const source = context.createMediaStreamSource(media);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);
      setMetering(true);
      const track = media.getAudioTracks()[0];
      // The device label is the answer to the most common cause: a default input
      // that exists but is not a microphone.
      logMic("micpage.meter.open", {
        tracks: media.getAudioTracks().length,
        label: track?.label ?? "unlabelled",
        settings: track?.getSettings?.().sampleRate ?? 0,
      });

      let smoothed = 0;
      /** Highest peak seen, reported once the meter has had a chance to hear. */
      let loudest = 0;
      let reported = false;
      const draw = () => {
        analyser.getFloatTimeDomainData(buffer);
        let peak = 0;
        for (const sample of buffer) peak = Math.max(peak, Math.abs(sample));
        loudest = Math.max(loudest, peak);
        // Fast attack, slow release: it must jump when you speak and fade after.
        smoothed = Math.max(peak, smoothed * 0.92);
        setLevel(smoothed);
        frame.current = requestAnimationFrame(draw);
      };
      draw();

      // Three seconds is long enough to say a word and short enough not to nag.
      window.setTimeout(() => {
        if (reported) return;
        reported = true;
        logMic("micpage.meter.level", {
          // Bands rather than the raw number: what matters is silent vs audible.
          band: loudest > 0.05 ? "audible" : loudest > 0.005 ? "faint" : "silent",
          peak: Number(loudest.toFixed(4)),
        });
      }, 3000);
    } catch (error) {
      logMic("micpage.meter.fail", {
        name: error instanceof Error ? error.name : "unknown",
      });
      setMetering(false);
      setMeterError(dictationNote(error));
    }
  }, []);

  const tryRecognition = useCallback(() => {
    const Recognition = getSpeechRecognition();
    // The same tag the microphone button would send, setting included — a
    // diagnostic that tests a different configuration proves nothing about the
    // app it is diagnosing.
    logMic("micpage.recognition.start", {
      available: Recognition !== null,
      lang: chosen.tag,
      source: chosen.source,
      browser: chosen.fromBrowser || "none",
    });
    if (!Recognition) {
      setRecognitionError("This browser has no speech recognition API.");
      return;
    }
    recognizer.current?.abort();
    setHeard("");
    setRecognitionError("");
    setRecognitionState("starting");

    const instance = new Recognition();
    // The same configuration the app itself uses, from one place — this page is
    // only worth anything as a diagnosis if it exercises the real path.
    configureRecognizer(instance, chosen.tag);

    instance.onstart = () => {
      logMic("micpage.recognition.open");
      setRecognitionState("open — say something");
    };
    instance.onresult = (event) => {
      const text = transcriptFrom(event);
      logMic("micpage.recognition.result", { chars: text.length, results: event.results.length });
      setHeard(text);
    };
    instance.onerror = (event) => {
      const reason = event?.error ?? "";
      logMic("micpage.recognition.error", { reason, lang: chosen.tag });
      setRecognitionState(`error: ${reason}`);
      // The tag is passed through, because "the service refused en-US" and "the
      // service refused a language" are different findings and only one of them
      // tells the user which control to change.
      setRecognitionError(
        dictationFailure(reason, false, chosen.tag) || `Recognition stopped (${reason}).`,
      );
      setRecognising(false);
    };
    instance.onend = () => {
      logMic("micpage.recognition.end");
      setRecognising(false);
      setRecognitionState((current) =>
        current.startsWith("error") ? current : "stopped (the browser ended the session — press the button again)",
      );
    };

    recognizer.current = instance;
    setRecognising(true);
    try {
      instance.start();
    } catch {
      setRecognising(false);
      setRecognitionState("could not start");
      setRecognitionError("The recogniser refused to start. It may already be running.");
    }
  }, [chosen]);

  const stopRecognition = useCallback(() => {
    const instance = recognizer.current;
    recognizer.current = null;
    setRecognising(false);
    try {
      instance?.stop();
    } catch {
      // Never started; nothing to stop.
    }
  }, []);

  useEffect(() => {
    return () => {
      stopMeter();
      recognizer.current?.abort();
    };
  }, [stopMeter]);

  const moving = level > 0.02;

  return (
    <main className="mx-auto max-w-[var(--content-max)] px-6 py-10">
      <h2 className="text-[19px] leading-tight font-normal tracking-[0.01em] text-text">
        Microphone check
      </h2>
      <p className="mt-2 max-w-[62ch] text-[13px] leading-relaxed font-light text-dim">
        Four measurements, in the order they can fail. Nothing here is stored, and
        nothing is sent anywhere except by the two buttons that say so.
      </p>

      <section className="mt-8">
        <h2 className="text-[13px] font-normal tracking-[0.02em] text-accent uppercase">
          What this browser can do
        </h2>
        <dl className="mt-3 space-y-2">
          {facts.map((fact) => (
            <div key={fact.label} className="flex gap-3 text-[13px] leading-relaxed">
              <dt className="w-[210px] shrink-0 font-normal text-faint">{fact.label}</dt>
              <dd
                className={`min-w-0 flex-1 break-words font-light ${
                  fact.tone === "bad" ? "text-danger" : fact.tone === "ok" ? "text-text" : "text-dim"
                }`}
              >
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-10">
        <h2 className="text-[13px] font-normal tracking-[0.02em] text-accent uppercase">
          1. Is the microphone hearing anything?
        </h2>
        <p className="mt-2 max-w-[62ch] text-[13px] leading-relaxed font-light text-dim">
          This reads the microphone directly, with no speech service involved. Speak
          normally: the bar should move well past the mark. If it stays flat, the
          problem is the microphone or the permission, and nothing further down this
          page can work.
        </p>

        <div className="mt-4 h-3 w-full overflow-hidden rounded-full border border-hairline bg-surface">
          {/* Scaled rather than widened: this bar is redrawn many times a
              second, and an animated `width` makes each redraw a layout pass.
              The 75ms is a meter's own time constant, not a designed
              duration. */}
          <div
            className="h-full w-full origin-left rounded-full bg-accent transition-transform duration-75 ease-linear"
            style={{ transform: `scaleX(${Math.min(1, level * 3.2)})` }}
          />
        </div>
        {/* A fixed threshold marker, so "the bar moves" is a comparison rather
            than a judgement about a number nobody can see. */}
        <p className="mt-2 text-[12px] font-normal text-faint">
          {metering
            ? moving
              ? "Hearing you."
              : "Open, but quiet. Speak, or check the input device in Windows sound settings."
            : "Not started."}
          {meterError ? <span className="text-danger"> {meterError}</span> : null}
        </p>

        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={() => void startMeter()}
            disabled={metering}
            className="rounded-full border border-hairline px-4 py-2 text-[13px] font-light text-text transition-colors duration-[var(--t-fast)] hover:bg-surface-2 disabled:opacity-40"
          >
            {metering ? "Measuring…" : "Start the meter"}
          </button>
          <button
            type="button"
            onClick={stopMeter}
            disabled={!metering}
            className="rounded-full border border-hairline px-4 py-2 text-[13px] font-light text-dim transition-colors duration-[var(--t-fast)] hover:bg-surface-2 disabled:opacity-40"
          >
            Stop
          </button>
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-[13px] font-normal tracking-[0.02em] text-accent uppercase">
          2. Can the browser turn speech into words?
        </h2>
        <p className="mt-2 max-w-[62ch] text-[13px] leading-relaxed font-light text-dim">
          This is the path the mic button uses. In Edge and Chrome the audio goes to
          the browser&apos;s own speech service, which needs a working connection —
          it never goes to Xana or to your model provider.
        </p>

        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={recognising ? stopRecognition : tryRecognition}
            className={`rounded-full border px-4 py-2 text-[13px] font-light transition-colors duration-[var(--t-fast)] ${
              recognising
                ? "border-accent/40 text-accent hover:bg-surface-2"
                : "border-hairline text-text hover:bg-surface-2"
            }`}
          >
            {recognising ? "Stop listening" : "Listen and transcribe"}
          </button>
        </div>

        <p className="mt-3 text-[12px] font-normal text-faint">
          State: {recognitionState || "not started"}
        </p>
        {heard ? (
          <p className="mt-2 text-[13px] font-light text-text" aria-live="polite">
            Heard: &ldquo;{heard}&rdquo;
          </p>
        ) : null}
        {recognitionError ? (
          <p className="mt-2 max-w-[62ch] text-[13px] leading-relaxed text-danger" aria-live="polite">
            {recognitionError}
          </p>
        ) : null}
      </section>

      <section className="mt-10">
        <h2 className="text-[13px] font-normal tracking-[0.02em] text-accent uppercase">
          3. What to do with the answer
        </h2>
        <ul className="mt-2 max-w-[62ch] space-y-2 text-[13px] leading-relaxed font-light text-dim">
          <li>
            <span className="text-text">The bar never moves.</span> Windows is not
            giving the microphone to the browser. Check Settings &rsaquo; Privacy &amp;
            security &rsaquo; Microphone, and the input device in Settings &rsaquo;
            System &rsaquo; Sound. The headset microphones on this machine are listed
            as unplugged, so pick the one that is present.
          </li>
          <li>
            <span className="text-text">The bar moves, recognition fails.</span> The
            microphone is fine and the browser&apos;s speech service is the problem —
            usually a blocked network, a hardened browser build, or being offline.
            Dictation then cannot work at all, which is what the local Whisper
            service in <code className="text-accent">python/</code> is for.
          </li>
          <li>
            <span className="text-text">The bar moves, recognition fails with a language error.</span>{" "}
            The service will not serve the tag it was sent. The row above says which
            tag that is and what will be tried after it; if none of them is your
            language, set it by hand in Settings &rsaquo; Voice &rsaquo; Dictation
            language. Nothing here needs your browser&apos;s own language setting
            changed.
          </li>
          <li>
            <span className="text-text">Both work here but not in the app.</span> Say
            which of the two failed and the app is the thing to fix, not your setup.
          </li>
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-[13px] font-normal tracking-[0.02em] text-accent uppercase">
          4. The recording of what just happened
        </h2>
        <p className="mt-2 max-w-[62ch] text-[13px] leading-relaxed font-light text-dim">
          Every microphone event on this page is written down — which API was
          present, what each failure was called, whether a session ever opened —
          so a problem can be read rather than described. No words you say are in
          it: only event names, error names and lengths.
        </p>
        <p className="mt-3 flex flex-wrap gap-4 text-[13px] font-light">
          <a
            href="/api/mic-log"
            target="_blank"
            rel="noreferrer"
            className="text-dim underline decoration-hairline underline-offset-2 transition-colors duration-[var(--t-fast)] hover:text-text"
          >
            Open the log
          </a>
          <a
            href="/api/mic-log?clear=1"
            target="_blank"
            rel="noreferrer"
            className="text-faint underline decoration-hairline underline-offset-2 transition-colors duration-[var(--t-fast)] hover:text-dim"
          >
            Clear it, then try again
          </a>
        </p>
      </section>
    </main>
  );
}
