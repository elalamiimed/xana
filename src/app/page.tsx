"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Header } from "@/components/xana/AdapterDots";
import AmbientCards from "@/components/xana/AmbientCards";
import Composer, { type ComposerHandle } from "@/components/xana/Composer";
import Cave from "@/components/xana/cave/Cave";
import Orb from "@/components/xana/Orb";
import Settings from "@/components/xana/settings/Settings";
import { speakable, speak, stopSpeaking, speechSynthesisAvailable } from "@/components/xana/speech";
import Turn from "@/components/xana/Turn";
import { useShellSettings } from "@/components/xana/useShellSettings";
import { useXana } from "@/components/xana/useXana";

/**
 * The whole interface, composed.
 *
 * Layout: a fixed header, a fixed composer, and a scrolling middle. On an
 * empty session the middle holds the orb and her one line and nothing else
 * — no placeholder cards, no onboarding, no hero. The emptiness is the
 * point; the ambient region only appears once there is something
 * peripheral to say.
 *
 * All conversational state lives in `useXana`, all settings state in
 * `useShellSettings`; this file is wiring, keyboard handling, and the two
 * clocks (the 20s ambient fade and the reply's spoken line).
 */

/** No interaction for this long and the peripheral region recedes. */
const AMBIENT_IDLE_MS = 20_000;

export default function Page() {
  const {
    lifeState,
    ready,
    presence,
    messages,
    engine,
    sending,
    rippleKey,
    greet,
    notice,
    send,
    act,
  } = useXana();

  const shell = useShellSettings(lifeState?.sources ?? []);

  const [ambientIdle, setAmbientIdle] = useState(false);
  const composer = useRef<ComposerHandle | null>(null);
  const scrollArea = useRef<HTMLElement | null>(null);

  const lastMessageId = messages.length
    ? messages[messages.length - 1]?.id
    : null;
  const latestXana = [...messages].reverse().find((m) => m.role === "xana");
  const hasConversation = messages.length > 0;
  const thinking = presence === "thinking" || sending;

  /**
   * The ambient fade clock. `nudge` is what every interaction calls: it
   * restores opacity and restarts the 20s window. The timeout is re-created
   * (not merely cleared) so the timer always measures from the last touch.
   */
  const [tick, setTick] = useState(0);
  const nudge = useCallback(() => {
    setAmbientIdle(false);
    setTick((value) => value + 1);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setAmbientIdle(true), AMBIENT_IDLE_MS);
    return () => clearTimeout(timer);
  }, [tick]);

  /**
   * Speak each new reply, when the user has asked for that.
   *
   * Keyed on the message id rather than the message count so a re-render
   * cannot say the same sentence twice, and guarded on the id changing so
   * a settings write (which re-renders the shell) does not repeat the last
   * reply out loud.
   */
  const spokenRef = useRef<string | null>(null);
  const { speakReplies, voiceName, rate, pitch } = shell.voice;

  useEffect(() => {
    const latest = latestXana;
    if (!latest || !speakReplies || !speechSynthesisAvailable()) return;
    if (spokenRef.current === latest.id) return;
    spokenRef.current = latest.id;

    const line = speakable(latest.text);
    if (line) speak(line, { voiceName, rate, pitch });
  }, [latestXana, speakReplies, voiceName, rate, pitch]);

  // A page unload with a voice mid-sentence is startling. This also covers
  // the case where the tab is backgrounded and the user has forgotten.
  useEffect(() => {
    return () => stopSpeaking();
  }, []);

  /* Cmd/Ctrl+K focuses the composer, Cmd/Ctrl+, opens settings, `/` focuses
     the composer the way it does in every tool that shows a slash keycap, and
     Escape lets the composer go. The settings panel and the cave handle their
     own Escape, so this stays out of their way. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        nudge();
        composer.current?.focus();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        shell.openSettings();
        return;
      }
      // A bare `/` is a focus shortcut only when nothing else is listening and
      // the user is not already typing somewhere. Without the second half it
      // would swallow the character in the cave's quick-add, its filter, and
      // the memory room's search.
      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isTypingTarget(event.target as Element | null) &&
        !shell.open &&
        !shell.caveOpen
      ) {
        event.preventDefault();
        nudge();
        composer.current?.focus();
        return;
      }
      if (event.key === "Escape") {
        composer.current?.blur();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [nudge, shell]);

  /* Keep the newest turn in view. */
  useEffect(() => {
    const area = scrollArea.current;
    if (area) area.scrollTop = area.scrollHeight;
  }, [lastMessageId, thinking]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-void">
      <Header
        lifeState={lifeState}
        presence={presence}
        onOpenSettings={shell.openSettings}
        onOpenCave={shell.openCave}
      />

      <main
        ref={scrollArea}
        onScroll={() => {
          if (ambientIdle) setAmbientIdle(false);
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {/* The orb. On an empty session this is the entire screen.
            The header-height top padding optically centres it in the
            viewport: without the offset the fixed header pushes it low. */}
        <section className="flex flex-col items-center px-6 pt-[var(--header-h)]">
          <Orb
            presence={presence}
            rippleKey={rippleKey}
            motionSpeed={shell.motionSpeed}
            onActivate={() => {
              // Tapping her stops a sentence, or opens settings when she is
              // quiet. Two behaviours on one control, chosen by what the
              // user most likely wants at that moment.
              if (speakReplies && speechSynthesisAvailable()) {
                stopSpeaking();
                return;
              }
              shell.openSettings();
            }}
          />
          <p className="mt-3 max-w-[46ch] text-center text-[15px] leading-relaxed font-light tracking-[0.01em] text-dim">
            {greet}
          </p>
        </section>

        {hasConversation ? (
          <section className="mx-auto mt-12 w-full max-w-[var(--content-max)] space-y-9 px-6 pb-10">
            {messages.map((message) => (
              <Turn
                key={message.id}
                message={message}
                showMeta={message.id === latestXana?.id}
              />
            ))}
            {thinking ? <ThinkingRow /> : null}
          </section>
        ) : null}

        {/* Peripheral: a briefing on a cold start, her cards after that. */}
        {!hasConversation && ready && lifeState ? (
          <section className="mt-12 pb-10">
            <AmbientCards
              state={lifeState}
              onAct={(intent) => {
                nudge();
                void act(intent);
              }}
              presence={presence}
              engine={engine}
              idle={ambientIdle}
              onInteract={nudge}
              onOpenSettings={shell.openSettings}
              modelActive={shell.modelActive}
              modelName={shell.modelName}
            />
          </section>
        ) : null}
      </main>

      <footer className="shrink-0 px-6 pt-4 pb-6">
        {notice ? (
          <p
            key={notice}
            className="toast-in mx-auto mb-2 max-w-[var(--content-max)] text-center text-[13px] font-light text-faint"
          >
            {notice}
          </p>
        ) : null}
        <div
          className="mx-auto w-full max-w-[var(--content-max)]"
          onFocus={nudge}
          onMouseEnter={nudge}
        >
          <Composer
            ref={composer}
            busy={thinking}
            onSubmit={(text, modality) => {
              nudge();
              void send(text, modality);
            }}
          />
        </div>
      </footer>

      <Settings
        open={shell.open}
        onClose={shell.closeSettings}
        controller={shell.controller}
        onAppearancePreview={shell.onAppearancePreview}
        statuses={shell.statuses}
      />

      <Cave open={shell.caveOpen} onClose={shell.closeCave} />
    </div>
  );
}

/**
 * The thinking placeholder.
 *
 * Two drifting bars rather than a spinner: a spinner says "wait", and she
 * is not asking anyone to wait — she is mid-sentence. It also reserves the
 * shape the reply will take, so the transcript does not jump when the text
 * lands.
 */
function ThinkingRow() {
  return (
    <div className="space-y-2" aria-hidden="true">
      <div className="skeleton h-3 w-[62%]" />
      <div className="skeleton h-3 w-[38%]" />
    </div>
  );
}

/**
 * True when the keystroke is already going somewhere the user is writing.
 *
 * A bare `/` is a shortcut and also a character. The guard is what decides
 * which one it is, and it has to cover every field the app can focus — the
 * cave's quick-add, the goal filter, the memory search, the settings inputs —
 * because a shortcut that steals a character is worse than no shortcut.
 */
function isTypingTarget(target: Element | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}
