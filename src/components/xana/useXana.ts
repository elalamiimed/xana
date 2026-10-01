"use client";

/**
 * useXana — the whole conversational client.
 *
 * This is the only module in the UI that talks to the network. Everything
 * else renders what the hook hands down.
 *
 *   mount          -> GET /api/context, then the greeting + briefing land
 *   every 5s       -> GET /api/state for ambient presence
 *   send(text)     -> optimistic user turn, presence thinking, POST /api/chat,
 *                     presence speaking + one ripple, refresh if asked
 *   act(intent)    -> presence acting, POST /api/action, outcome as a quiet line
 *
 * Presence merges two sources: the ambient poll (the server's opinion) and a
 * short-lived local override (what the UI is doing right now). The override
 * wins while it lasts so a reply never flickers back to `idle` mid-sentence,
 * and it expires on its own so the orb returns to resting.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  ActionIntent,
  Analysis,
  Card,
  LifeState,
  Message,
  Presence,
} from "@/lib/api/contract";

import {
  asLifeState,
  asMessage,
  asPresence,
  describeError,
  getContext,
  getState,
  postAction,
  postChat,
} from "./api";

/** The ambient poll cadence. Deliberately cheap and deliberately boring. */
const POLL_MS = 5_000;

/** How long a local presence override outlives the interaction that set it. */
const OVERRIDE_TTL_MS = 30_000;

/** One line per presence, in Xana's voice. Never an exclamation. */
const CAPTIONS: Record<Presence, string> = {
  dormant: "Resting.",
  idle: "Listening.",
  thinking: "Thinking.",
  speaking: "Here.",
  acting: "Working.",
};

const CAPTION_FALLBACK = "Waking.";

/**
 * The shape the UI renders: a `Message` plus its pre-formatted metadata line.
 * `engine` is a free string on the wire, so the formatting happens once here
 * rather than in every turn.
 */
export interface RenderedMessage {
  id: string;
  role: Message["role"];
  text: string;
  createdAt: string;
  cards: Card[];
  meta: string | null;
  /** True when `meta` carries a model failure rather than a quiet footnote. */
  modelFailed: boolean;
}

export interface Xana {
  lifeState: LifeState | null;
  analysis: Analysis | null;
  /** True once /api/context has settled — success or failure. */
  ready: boolean;
  presence: Presence;
  messages: RenderedMessage[];
  engine: "llm" | "local" | null;
  sending: boolean;
  /** Increments once per reply. The orb re-fires its ripple on each change. */
  rippleKey: number;
  greet: string;
  /** One line in Xana's voice about the last failure or write-back. */
  notice: string | null;
  send: (text: string, modality?: "text" | "voice") => Promise<void>;
  act: (intent: ActionIntent) => Promise<void>;
  /**
   * Re-read the life state.
   *
   * Needed by anything that writes outside the chat — My cave edits goals,
   * tasks and memories through its own route, and the briefing here reads all
   * three. Without this the panel keeps showing the state it had when the
   * page loaded: the cave would say one task and the briefing would say three.
   */
  refreshContext: () => Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Fold the /api/chat lifeState onto the last known one.
 *
 * The payload is a snapshot rather than a patch, and an optional section can
 * genuinely be absent from it — a chat reply carries whatever the assembly
 * happened to have. Where absence means "unknown", the deeper previous value
 * is kept rather than blanking a card while it is being read.
 *
 * WHAT IS NOT FOLDED, AND WHY
 *
 * `tasks` used to be in this list, and that single line made deleting a task
 * look broken. `incoming.tasks.focus.length ? incoming.tasks : previous.tasks`
 * cannot tell "you just cleared your list" from "this section did not arrive",
 * so an empty list was read as a missing one and the old tasks were put back.
 * The database said one task; the panel said three.
 *
 * The task list is not optional. `buildLifeState` computes it every time, and
 * an empty list is a fact about the user's day rather than a gap in the data.
 * The moment a section can legitimately be empty, keeping the previous value
 * is no longer defensive — it is a lie that survives refreshes.
 */
export function reduceLifeState(previous: LifeState, incoming: LifeState): LifeState {
  return {
    ...incoming,
    calendar: incoming.calendar.today.length ? incoming.calendar : previous.calendar,
    goals: incoming.goals.length ? incoming.goals : previous.goals,
    habits: incoming.habits.length ? incoming.habits : previous.habits,
    memory: incoming.memory.length ? incoming.memory : previous.memory,
    nudges: incoming.nudges.length ? incoming.nudges : previous.nudges,
    finance: incoming.finance.length ? incoming.finance : previous.finance,
    mail: incoming.mail.length ? incoming.mail : previous.mail,
    patterns: incoming.patterns.length ? incoming.patterns : previous.patterns,
    sources: incoming.sources.length ? incoming.sources : previous.sources,
  };
}

let localIdCounter = 0;

function localId(prefix: string): string {
  localIdCounter += 1;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${localIdCounter}`;
}

/**
 * The metadata footer line: `llm · 840ms`, or a reason the model did not
 * answer. Null when there is nothing to say.
 *
 * The failure case is the important one. A reply that silently says `local`
 * is indistinguishable from a reply when no model was ever configured, and
 * that ambiguity is what makes "my key is being ignored" impossible to
 * diagnose from the chat window.
 */
function metaLine(message: Message): string | null {
  const parts: string[] = [];
  if (typeof message.engine === "string" && message.engine.length > 0) {
    parts.push(message.engine);
  }
  if (typeof message.latencyMs === "number" && Number.isFinite(message.latencyMs)) {
    parts.push(`${Math.round(message.latencyMs)}ms`);
  }
  const base = parts.length > 0 ? parts.join(" · ") : null;
  const failure =
    typeof message.modelError === "string" && message.modelError.trim().length > 0
      ? message.modelError.trim()
      : null;
  if (base && failure) return `${base} · ${failure}`;
  return base ?? failure;
}

function toRendered(message: Message): RenderedMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
    cards: message.cards ?? [],
    meta: metaLine(message),
    modelFailed:
      typeof message.modelError === "string" && message.modelError.trim().length > 0,
  };
}

/* ------------------------------------------------------------------ */
/* The hook                                                            */
/* ------------------------------------------------------------------ */

export function useXana(): Xana {
  const [lifeState, setLifeState] = useState<LifeState | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [ready, setReady] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [engine, setEngine] = useState<"llm" | "local" | null>(null);
  const [sending, setSending] = useState(false);
  const [rippleKey, setRippleKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  /** The server's opinion, refreshed by the poll. */
  const [polled, setPolled] = useState<Presence | null>(null);
  /** What the UI is doing right now, and when that opinion goes stale. */
  const [override, setOverride] = useState<{
    value: Presence;
    expiresAt: number;
  } | null>(null);

  const sessionId = useRef<string>(localId("session"));
  const speakTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Guards against a double submit arriving before React re-renders. */
  const inFlight = useRef(false);

  /* ---------------- mount: full context, once ---------------- */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await getContext();
        if (cancelled) return;
        const next = asLifeState(data.lifeState);
        if (next) setLifeState(next);
        setAnalysis(data.analysis ?? null);
      } catch {
        // No backend yet. The orb still renders; the ambient region stays empty.
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------------- ambient poll: presence only ---------------- */

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const data = await getState();
        if (cancelled) return;
        const next = asPresence(data.presence);
        if (next) setPolled(next);
        if (data.engine === "llm" || data.engine === "local") {
          setEngine(data.engine);
        }
      } catch {
        // A failed poll is not an event. Keep breathing.
      }
    };
    void tick();
    const interval = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  /* ---------------- presence: poll + local override ---------------- */

  /**
   * Three sources, in order of authority:
   *
   *   1. `sending` — a request is open. Thinking is a fact, not an opinion,
   *      so a slow model can never be reported as idle mid-thought.
   *   2. the local override — speaking and acting, which only the client knows.
   *   3. the poll — the server's ambient opinion.
   *
   * Before the first context settles the orb rests at dormant rather than
   * claiming to listen.
   */
  const presence: Presence = sending
    ? "thinking"
    : override
      ? override.value
      : (polled ?? (ready ? "idle" : "dormant"));

  // Drop the override the moment it goes stale. This re-render is what lets
  // the orb fall back to the poll's opinion, so the effect is load-bearing.
  useEffect(() => {
    if (!override) return;
    const remaining = Math.max(0, override.expiresAt - Date.now());
    const timer = setTimeout(() => setOverride(null), remaining);
    return () => clearTimeout(timer);
  }, [override]);

  useEffect(() => {
    return () => {
      if (speakTimer.current) clearTimeout(speakTimer.current);
    };
  }, []);

  const holdPresence = useCallback((value: Presence) => {
    setOverride({ value, expiresAt: Date.now() + OVERRIDE_TTL_MS });
  }, []);

  /* ---------------- context refresh ---------------- */

  const refreshContext = useCallback(async () => {
    try {
      const data = await getContext();
      const next = asLifeState(data.lifeState);
      if (!next) return;
      setAnalysis(data.analysis ?? null);
      setLifeState((previous) =>
        previous ? reduceLifeState(previous, next) : next,
      );
    } catch {
      // Keep the last good snapshot rather than blanking the region.
    }
  }, []);

  /* ---------------- send ---------------- */

  const send = useCallback(
    async (raw: string, modality: "text" | "voice" = "text") => {
      const text = raw.trim();
      if (!text || inFlight.current) return;
      inFlight.current = true;

      const optimistic: Message = {
        id: localId("user"),
        role: "user",
        text,
        createdAt: new Date().toISOString(),
      };
      setMessages((previous) => [...previous, optimistic]);
      setSending(true);
      holdPresence("thinking");

      try {
        const data = await postChat({
          message: text,
          sessionId: sessionId.current,
          modality,
        });
        const reply = asMessage(data.message);
        const incoming = asLifeState(data.lifeState);

        if (reply) setMessages((previous) => [...previous, reply]);
        if (incoming) {
          setLifeState((previous) =>
            previous ? reduceLifeState(previous, incoming) : incoming,
          );
        }

        // She has spoken: ripple once, then settle back to listening.
        setRippleKey((key) => key + 1);
        holdPresence("speaking");
        if (speakTimer.current) clearTimeout(speakTimer.current);
        speakTimer.current = setTimeout(() => setOverride(null), 2_600);

        const refresh = reply?.outcome?.refresh;
        if (refresh && refresh.length > 0) void refreshContext();
      } catch (error) {
        // No alarm, no modal. One quiet line, and the orb stays up.
        setNotice(describeError(error));
        setOverride(null);
      } finally {
        inFlight.current = false;
        setSending(false);
      }
    },
    [holdPresence, refreshContext],
  );

  /* ---------------- act ---------------- */

  const act = useCallback(
    async (intent: ActionIntent) => {
      holdPresence("acting");
      try {
        const outcome = await postAction(intent);
        setNotice(outcome.message);
        if (outcome.refresh && outcome.refresh.length > 0) {
          void refreshContext();
        }
      } catch (error) {
        setNotice(describeError(error));
        setOverride(null);
      }
    },
    [holdPresence, refreshContext],
  );

  /* ---------------- the notice clears itself ---------------- */

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6_000);
    return () => clearTimeout(timer);
  }, [notice]);

  /* ---------------- greeting: her one-line headline ---------------- */

  const greet = useMemo(() => {
    if (!lifeState) return CAPTION_FALLBACK;
    const headline = lifeState.headline?.trim();
    if (headline) return headline;
    return CAPTIONS[presence];
  }, [lifeState, presence]);

  const rendered = useMemo<RenderedMessage[]>(
    () =>
      messages
        .filter((message) => message.role !== "system")
        .map(toRendered),
    [messages],
  );

  return {
    lifeState,
    analysis,
    ready,
    presence,
    messages: rendered,
    engine,
    sending,
    rippleKey,
    greet,
    notice,
    send,
    act,
    refreshContext,
  };
}
