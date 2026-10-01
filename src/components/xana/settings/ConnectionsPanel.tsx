"use client";

import { useCallback, useEffect, useState } from "react";

import {
  CONNECTIONS_BLURB,
  CONNECTIONS_LABEL,
  type ConnectionsResponse,
  type PluginAction,
  type PluginConfigView,
  type PluginState,
  type PluginStatus,
} from "../../../lib/plugins/types";

import {
  describeConnectionsError,
  getConnections,
  postConnectionAction,
  saveConnectionSettings,
} from "../api/connections";

import {
  SOURCE_GROUPS,
  type SettingsView,
  type SourceField,
} from "@/lib/settings/types";

import { Actions, Button, Pill, Section, StatusLine, Switch } from "./controls";

/**
 * Connections: what Xana may reach, and the permission for each reach.
 *
 * THIS IS THE CONSENT SURFACE, AND NOW THE ONLY ONE
 *
 * There used to be two screens: "Plugins" held the API keys and the permission
 * cards, "Connections" held the legacy flat `XANA_*` values. Neither was the
 * place you looked for everything she can reach, and a key could be set on one
 * screen that the other never mentioned. They are one list now. The legacy
 * values survive as a collapsed section at the foot of this file, because a key
 * a user can set but cannot unset is worse than a key with no form at all.
 *
 * The endpoint beside it already decides everything a card shows — whether a
 * connection is ready, which capabilities are missing, whether a setting is
 * present and which layer answered — so this file renders that answer and never
 * forms a second opinion about it. The counts in the header and the grouping of
 * the cards are the server's own, in particular: re-deriving "is this
 * configured" here is exactly how a panel ends up saying Allowed next to a
 * connection that cannot run.
 *
 * Consent is three separate clicks, on purpose:
 *
 *   1. `Allow`         — the capabilities the plugin needs to work at all.
 *   2. `Allow changes` — the write half, granted on its own, so nobody hands
 *                        over the ability to change things while agreeing to
 *                        read them.
 *   3. `Connect`       — the Google sign-in, which hands Xana a token and so
 *                        comes after the other two rather than with them.
 *
 * Configuration is generated from the descriptor instead of being hand-built,
 * and only fields the user actually typed into are ever sent back. That last
 * rule is load-bearing: a value answered by the environment must not be copied
 * into the settings file merely because someone opened this panel to look.
 *
 * `blocked` is not a fault. Nothing has gone wrong when a plugin is blocked;
 * a permission has not been asked for yet. It is drawn as an idle state and
 * the row says what is missing, because a warning treatment for "you have not
 * clicked the button" is how people learn to ignore warnings.
 */

/** The one plugin whose sign-in this panel drives. */
const GOOGLE_PLUGIN_ID = "google-calendar";

/**
 * The tabs that post back after storing a token.
 *
 * Two names, because the sign-in tab was written against the old one and a
 * page already open in a browser can still post either. Listening for both
 * costs one string and removes a class of "I signed in and the card still says
 * not connected" that has no visible cause.
 */
const REFRESH_SOURCES: readonly string[] = ["xana-connections", "xana-plugins"];

/** The health connection whose card carries the phone instructions. */
const HEALTH_PLUGIN_ID = "health";
const HEALTH_TOKEN_KEY = "health.deviceToken";
const HEALTH_INGEST_KEY = "health.ingest";
const HEALTH_TOKEN_HEADER = "X-Device-Token";
/**
 * Where the token is asked for.
 *
 * The app-facing door, and the same handler as `/xana/health/ingest`: the panel
 * lives in the app, so it uses the app's path, while the URL shown to the user
 * for their phone is built from the page's own origin at render time.
 */
const HEALTH_INGEST_PATH = "/api/health/ingest";

/**
 * What the token endpoint answers.
 *
 * `from` names the layer that answered, so the panel can decline to print a
 * value that arrived from the environment rather than from the settings file.
 * `token` is absent in exactly that case, and absent when the endpoint is off.
 */
interface DeviceTokenView {
  enabled: boolean;
  from: "settings" | "env" | "none";
  token?: string;
  message?: string;
}

/**
 * One line, because it is going into a phone's shortcut editor.
 *
 * The keys are the ones `parseHealthFile` already accepts, so the same body
 * works whether it arrives over HTTP or is dropped in the export folder. The
 * date is the day the sample is from, so a real shortcut substitutes its own.
 */
const HEALTH_BODY_EXAMPLE =
  '{"date":"2026-09-30","sleepHours":7.4,"steps":8420,"restingHeartRate":54,"mood":"good"}';

const STATE_TONE: Record<PluginState, "ok" | "warn" | "idle"> = {
  connected: "ok",
  local: "idle",
  offline: "warn",
  error: "warn",
  blocked: "idle",
};

interface PanelMessage {
  tone: "ok" | "error" | "info";
  text: string;
}

const MESSAGE_TONE: Record<PanelMessage["tone"], string> = {
  ok: "text-good",
  error: "text-danger",
  info: "text-dim",
};

export interface ConnectionsPanelProps {
  view: SettingsView;
  /** The parent's save path, shared with the legacy section below. */
  onSave: (patch: {
    sources?: Record<string, string>;
    clearSources?: string[];
  }) => Promise<unknown>;
  saving: boolean;
}

export default function ConnectionsPanel({
  view,
  onSave,
  saving,
}: ConnectionsPanelProps) {
  const [data, setData] = useState<ConnectionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Record<string, PanelMessage | undefined>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  /**
   * Re-read the whole list.
   *
   * Every action ends here rather than trusting the copy the action returned:
   * the list is the server's and so are the two counts in the header, and one
   * extra loopback request buys a single source of truth for both.
   */
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await getConnections());
      setError(null);
    } catch (err) {
      setError(describeConnectionsError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The sign-in tab posts this once a token is stored. It is a convenience:
  // `noopener` on the opened tab can prevent the post from ever arriving,
  // which is why the focus listener below is the guarantee.
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (
        isRecord(event.data) &&
        typeof event.data.source === "string" &&
        REFRESH_SOURCES.includes(event.data.source)
      ) {
        void refresh();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [refresh]);

  // Coming back to this window is the reliable end of an OAuth round trip.
  useEffect(() => {
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const say = useCallback((id: string, message: PanelMessage | undefined) => {
    setMessages((previous) => ({ ...previous, [id]: message }));
  }, []);

  const setDraft = useCallback((key: string, value: string) => {
    setDrafts((previous) => ({ ...previous, [key]: value }));
  }, []);

  const runAction = useCallback(
    async (
      plugin: PluginStatus,
      action: PluginAction["action"],
      includeWrite?: boolean,
    ) => {
      setPending(`${plugin.id}:${action}`);
      say(plugin.id, undefined);
      try {
        const result = await postConnectionAction({ id: plugin.id, action, includeWrite });
        // Opened here, in the continuation of the click that asked for it, so
        // the browser still counts it as user-initiated. `noopener` keeps the
        // new tab from holding a handle on this one.
        if (result.authUrl) window.open(result.authUrl, "_blank", "noopener");
        await refresh();
        say(plugin.id, { tone: result.ok ? "ok" : "error", text: result.message });
      } catch (err) {
        say(plugin.id, { tone: "error", text: describeConnectionsError(err) });
      } finally {
        setPending(null);
      }
    },
    [refresh, say],
  );

  const saveConfig = useCallback(
    async (plugin: PluginStatus) => {
      // Only the keys the user touched. A field answered by the environment
      // therefore cannot be promoted into the file by opening the panel.
      const values: Record<string, string> = {};
      for (const field of plugin.config) {
        const draft = drafts[field.key];
        if (draft !== undefined) values[field.key] = draft;
      }
      if (Object.keys(values).length === 0) return;

      setSavingId(plugin.id);
      say(plugin.id, undefined);
      try {
        const result = await saveConnectionSettings(values);
        setData(result);
        // A refused save keeps the drafts: the user's typing is the only copy
        // of what they meant to store.
        if (result.ok) {
          setDrafts((previous) => {
            const next = { ...previous };
            for (const key of Object.keys(values)) delete next[key];
            return next;
          });
        }
        say(plugin.id, { tone: result.ok ? "ok" : "error", text: result.message });
      } catch (err) {
        say(plugin.id, { tone: "error", text: describeConnectionsError(err) });
      } finally {
        setSavingId(null);
      }
    },
    [drafts, say],
  );

  /**
   * The groups, as the server ordered them.
   *
   * There is no client-side grouping left: the kind, its label, its blurb and
   * its two counts all arrive together, so the heading over a card cannot
   * disagree with the card. A kind the server sent with nothing in it is not
   * rendered — an empty heading promises something that is not there — while
   * the order of the groups that do have members stays exactly as sent.
   */
  const groups = data?.groups ?? [];
  const visibleGroups = groups.filter((group) => group.plugins.length > 0);

  // Totals over every group, including a kind with nothing in it, so the
  // header total is the server's row count and not the rendered card count.
  const readyTotal = groups.reduce((total, group) => total + group.ready, 0);
  const connectionTotal = groups.reduce(
    (total, group) => total + group.plugins.length,
    0,
  );

  return (
    <div>
      <Section title={CONNECTIONS_LABEL} blurb={CONNECTIONS_BLURB}>
        {data ? (
          <p className="text-[13px] leading-relaxed font-normal text-text">
            {`${data.awaitingConsent} waiting for permission, ${data.unconfigured} missing a setting · ${readyTotal} of ${connectionTotal} connected`}
          </p>
        ) : null}

        {error ? <StatusLine tone="error">{error}</StatusLine> : null}

        {loading && !data ? (
          <div className="space-y-3" aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="skeleton h-4"
                style={{ width: `${90 - index * 18}%` }}
              />
            ))}
          </div>
        ) : null}

        <Actions>
          <Button onClick={() => void refresh()} disabled={loading}>
            {error && !data ? "Try again" : "Refresh"}
          </Button>
          {loading && data ? <StatusLine tone="info">Re-reading…</StatusLine> : null}
        </Actions>
      </Section>

      {data && data.plugins.length === 0 ? (
        <Section title="Nothing installed">
          <StatusLine tone="info">
            No connections are registered in this build. Everything she knows
            comes from her own engine.
          </StatusLine>
        </Section>
      ) : null}

      {visibleGroups.map((group) => (
        <Section key={group.kind} title={group.label} blurb={group.blurb}>
          <p className="text-[12px] leading-relaxed font-normal text-faint">
            {`${group.ready} of ${group.plugins.length} connected`}
            {group.pending > 0 ? `, ${group.pending} waiting` : ""}
          </p>

          <div className="space-y-4">
            {group.plugins.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                busy={pending !== null && pending.startsWith(`${plugin.id}:`)}
                saving={savingId === plugin.id}
                drafts={drafts}
                message={messages[plugin.id]}
                onDraft={setDraft}
                onSaveConfig={() => void saveConfig(plugin)}
                onAction={runAction}
              />
            ))}
          </div>
        </Section>
      ))}

      <LegacyEnvSection view={view} onSave={onSave} saving={saving} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One connection                                                     */
/* ------------------------------------------------------------------ */

interface PluginCardProps {
  plugin: PluginStatus;
  busy: boolean;
  saving: boolean;
  drafts: Record<string, string>;
  message: PanelMessage | undefined;
  onDraft: (key: string, value: string) => void;
  onSaveConfig: () => void;
  /** `includeWrite` is only ever set by the separate changes toggle. */
  onAction: (
    plugin: PluginStatus,
    action: PluginAction["action"],
    includeWrite?: boolean,
  ) => void;
}

function PluginCard({
  plugin,
  busy,
  saving,
  drafts,
  message,
  onDraft,
  onSaveConfig,
  onAction,
}: PluginCardProps) {
  // The optional half is what the changes toggle covers. `grant` writes `true`
  // for every optional capability at once, and nothing writes a single
  // `false`, so the toggle's off state has to go through `revoke` — which
  // withdraws the plugin's permissions as a set. The hint says so rather than
  // implying the read half survives on its own.
  const optional = plugin.capabilities.filter((capability) => capability.optional);
  const writeCapability = optional.find(
    (capability) => capability.kind === "remote.write",
  );
  const guardsRemote = plugin.writesBack && writeCapability !== undefined;
  const writeGranted =
    optional.length > 0 && optional.every((capability) => capability.granted);
  const writeReasons = optional.map((capability) => capability.reason).join(" ");

  const anyGranted = plugin.capabilities.some((capability) => capability.granted);
  const unsaved = plugin.config.filter((field) => drafts[field.key] !== undefined);
  const locked = busy || saving;

  return (
    /* `.card`, not a bare hairline box.
     *
     * DESIGN.md §3 defines a card as a surface, a fill sheen, a hairline and
     * `--shadow-1`, and every other card in the app is that. This one was a
     * 1px outline with no fill, which is the "ghost card" the design review
     * names: on a near-black page a border alone reads as a wireframe, and a
     * consent card that looks unfinished is a consent card people skim past.
     * The radius comes with the class, so the theme's shape scale decides it
     * rather than a `rounded-lg` picked here. */
    <article className="card px-4 py-4">
      {/* Name and live state. The pill carries the word, so the colour is
          never the only signal.

          A `live`/`local`/`synthetic` caption used to sit here too, in mono.
          It restated what the group heading already says in the reader's
          language — "Services", "Devices" — in machine vocabulary, and it was
          the one caption on the card that cost attention without answering a
          question. The state pill still separates `local` from `error`, which
          is the distinction a reader actually acts on. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h5 className="text-[14px] font-light text-text">{plugin.name}</h5>
        <Pill tone={STATE_TONE[plugin.state]}>{plugin.state}</Pill>
      </div>

      {plugin.detail ? (
        <p className="mt-2 text-[12px] leading-relaxed font-normal text-dim">
          {plugin.detail}
        </p>
      ) : null}

      <p className="mt-3 text-[13px] leading-relaxed font-light text-dim">
        {plugin.tagline}
      </p>

      <div className="mt-4">
        <p className="label">What leaves this machine</p>
        <p className="mt-1 text-[13px] leading-relaxed font-normal text-text">
          {plugin.dataNote}
        </p>
      </div>

      <div className="mt-4">
        <p className="label">What you get</p>
        <p className="mt-1 text-[13px] leading-relaxed font-light text-dim">
          {plugin.provides}
        </p>
      </div>

      {/* The server sends these danger-first, so they are rendered in the
          order they arrive: the last reason read is the one that changes
          something in someone's account. */}
      {plugin.capabilities.length > 0 ? (
        <div className="mt-4">
          <p className="label">What she may do</p>
          <ul className="mt-2 space-y-3">
            {plugin.capabilities.map((capability) => (
              <li key={capability.kind} className="border-l border-hairline pl-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[13px] font-light text-text">
                    {capability.label}
                  </span>
                  <Pill tone={capability.granted ? "ok" : "idle"}>
                    {capability.granted ? "allowed" : "not allowed"}
                  </Pill>
                  <span className="text-[11px] font-normal text-faint">
                    {capability.optional ? "optional" : "required"}
                  </span>
                </div>
                <p className="mt-1 text-[12px] leading-relaxed font-normal text-dim">
                  {capability.reason}
                </p>
                {capability.hosts && capability.hosts.length > 0 ? (
                  <p className="mt-1 text-[12px] leading-relaxed font-normal text-faint">
                    Reaches{" "}
                    <span className="font-mono text-[11px] font-normal">
                      {capability.hosts.join(", ")}
                    </span>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {plugin.config.length > 0 ? (
        <div className="mt-4">
          <p className="label">Settings</p>
          <div className="mt-2 space-y-4">
            {plugin.config.map((field) => (
              <ConfigField
                key={field.key}
                pluginId={plugin.id}
                field={field}
                draft={drafts[field.key]}
                onDraft={onDraft}
              />
            ))}
          </div>
        </div>
      ) : null}

      {/* The device half of a source. It sits after the fields because the
          instructions refer to the token field directly above them. */}
      {hasHealthBridge(plugin) ? <HealthBridge plugin={plugin} /> : null}

      {optional.length > 0 ? (
        <div className="mt-3.5 border-t border-hairline pt-3.5">
          <Switch
            label="Allow changes"
            hint={
              writeGranted
                ? "Allowed. Turning this off withdraws this plugin's permissions, reading included."
                : guardsRemote
                  ? `${writeReasons} Nothing here changes anything in your account until you press it.`
                  : `${writeReasons} Off until you press it.`
            }
            checked={writeGranted}
            disabled={locked}
            onChange={(next) =>
              onAction(plugin, next ? "grant" : "revoke", next ? true : undefined)
            }
          />
        </div>
      ) : null}

      <div className="mt-3.5 border-t border-hairline pt-3.5">
        <Actions>
          {plugin.missing.length > 0 ? (
            <Button
              variant="primary"
              disabled={locked}
              onClick={() => onAction(plugin, "grant")}
            >
              Allow
            </Button>
          ) : null}

          {anyGranted ? (
            <Button disabled={locked} onClick={() => onAction(plugin, "revoke")}>
              Withdraw
            </Button>
          ) : null}

          {/* Present only where there is a sign-in to run. Both are offered
              because "connected" is not something this view can promise: a
              plugin whose last read failed is still connected underneath. */}
          {plugin.id === GOOGLE_PLUGIN_ID ? (
            <>
              <Button disabled={locked} onClick={() => onAction(plugin, "connect")}>
                Connect
              </Button>
              <Button disabled={locked} onClick={() => onAction(plugin, "disconnect")}>
                Disconnect
              </Button>
            </>
          ) : null}

          {unsaved.length > 0 ? (
            <Button variant="primary" disabled={locked} onClick={onSaveConfig}>
              {saving ? "Saving…" : "Save settings"}
            </Button>
          ) : null}
        </Actions>
      </div>

      {/* One live region per card, so the sentence that answers a click lands
          beside the buttons that caused it rather than at the top of a
          scrolled panel. It is always in the DOM, which is what makes the
          change announce reliably. */}
      <div aria-live="polite" aria-atomic="true" className="mt-3">
        {locked ? (
          <p className="text-[12px] leading-relaxed font-normal text-dim">
            {saving ? "Saving…" : "Working…"}
          </p>
        ) : message ? (
          <p
            className={`text-[12px] leading-relaxed font-normal ${MESSAGE_TONE[message.tone]}`}
          >
            {message.text}
          </p>
        ) : null}
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* One setting                                                        */
/* ------------------------------------------------------------------ */

function ConfigField({
  pluginId,
  field,
  draft,
  onDraft,
}: {
  pluginId: string;
  field: PluginConfigView;
  draft: string | undefined;
  onDraft: (key: string, value: string) => void;
}) {
  // Deterministic rather than `useId`: the key is already unique across every
  // plugin, and a stable id survives a re-render without churning the label.
  const id = `plugin-${pluginId}-${field.key.replace(/[^a-z0-9]+/gi, "-")}`;
  const hintId = `${id}-hint`;
  const secret = field.kind === "secret";
  const untouched = draft === undefined;

  // A secret's value never travels toward the browser, so an untouched secret
  // is an empty field by construction — and an empty field is never sent.
  const value = untouched ? (secret ? "" : (field.value ?? "")) : draft;
  const placeholder =
    secret && field.present && untouched
      ? "••••••••  (unchanged)"
      : (field.example ?? "");

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[13px] font-light text-text">
          {field.label}
        </label>
        <span className="flex flex-wrap items-center gap-2">
          {field.required && !field.present ? (
            <Pill tone="warn">required</Pill>
          ) : null}
          {field.present ? (
            <Pill tone="ok">
              {field.from === "env" ? "from environment" : "saved"}
            </Pill>
          ) : null}
        </span>
      </div>

      <p id={hintId} className="mt-1 text-[12px] leading-relaxed font-normal text-faint">
        {field.hint}
      </p>

      <input
        id={id}
        type={secret ? "password" : inputType(field.kind)}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-describedby={hintId}
        onChange={(event) => onDraft(field.key, event.target.value)}
        className="field mt-2 font-mono"
      />

      {field.where ? (
        <p className="mt-1 text-[12px] leading-relaxed font-normal text-faint">
          {isHttpUrl(field.where) ? (
            <a
              href={field.where}
              target="_blank"
              rel="noreferrer noopener"
              className="text-dim underline underline-offset-2"
            >
              {field.where}
            </a>
          ) : (
            field.where
          )}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The phone half of a device connection                              */
/* ------------------------------------------------------------------ */

/**
 * Whether this card carries the phone bridge.
 *
 * Two conditions, and both are load-bearing. The id says this is the health
 * connection; the fields say the build actually has a device half. Keying on
 * the id alone would keep printing a URL and a header for an endpoint that may
 * not exist in this build, and the first thing the user would do with that is
 * paste it into their phone and watch nothing arrive.
 */
function hasHealthBridge(plugin: PluginStatus): boolean {
  if (plugin.id !== HEALTH_PLUGIN_ID) return false;
  return plugin.config.some(
    (field) => field.key === HEALTH_TOKEN_KEY || field.key === HEALTH_INGEST_KEY,
  );
}

/**
 * How to get a phone's health data to her.
 *
 * A source that reads a folder needs the user to already have a folder. A
 * phone that posts to her needs three things and no folder at all, and this
 * section is those three things written out: where to post, what to put in the
 * header, and what the body looks like. It is deliberately not a warning
 * treatment — nothing here is broken or missing, it is an offer.
 *
 * The URL is derived from the page the user is looking at rather than from a
 * setting, so there is no address to keep in sync. That also means it is the
 * loopback address on the machine itself, which a phone cannot reach; the
 * paragraph under the steps says so, because "I pasted it and nothing
 * happened" is the predictable end of not saying it.
 */
function HealthBridge({ plugin }: { plugin: PluginStatus }) {
  const [origin, setOrigin] = useState("");
  const [minted, setMinted] = useState<DeviceTokenView | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  // Reading `window.location` during render would make the first client render
  // differ from the server's HTML, so it lands in an effect, after hydration.
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  /**
   * Whether the endpoint is open, as the server last told us.
   *
   * `present` is true when a value exists *anywhere* — the settings file or the
   * environment — and `value` only arrives for a value the settings file
   * answered. So this is the panel's reading of the same fact `/api/connections`
   * reports, not a second opinion: it decides whether asking for a token is
   * meaningful, and the server decides whether one is minted.
   */
  const acceptField = plugin.config.find((field) => field.key === HEALTH_INGEST_KEY);
  const expectingToken = Boolean(acceptField?.present && acceptField.value?.trim());

  /**
   * Ask for the token.
   *
   * A separate call, and only when the endpoint is on, because the mint is a
   * write: `GET /api/connections` must stay a read, and a secret has no business
   * in a list response the rest of the app treats as safe. Asking is also how
   * the panel earns the sentence it prints — "Xana generates one for you" is a
   * claim about what the server will do, and this is the call that makes it true
   * rather than a promise.
   *
   * The answer is used as-is: an environment token comes back with `from: "env"`
   * and no value, and the panel says so instead of inventing one.
   */
  const askForToken = useCallback(async () => {
    setAsking(true);
    try {
      const response = await fetch(`${HEALTH_INGEST_PATH}`, { cache: "no-store" });
      if (!response.ok) {
        setTokenError(`The token endpoint answered ${response.status}.`);
        return;
      }
      const payload: unknown = await response.json();
      if (!isRecord(payload) || payload.ok !== true) {
        setTokenError("The token endpoint did not answer with a token.");
        return;
      }
      setMinted({
        enabled: payload.enabled === true,
        from: payload.from === "env" ? "env" : payload.from === "settings" ? "settings" : "none",
        token: typeof payload.token === "string" && payload.token.length > 0 ? payload.token : undefined,
        message: typeof payload.message === "string" ? payload.message : undefined,
      });
      setTokenError(null);
    } catch {
      setTokenError("The token endpoint is not answering.");
    } finally {
      setAsking(false);
    }
  }, []);

  useEffect(() => {
    if (!expectingToken) return;
    void askForToken();
  }, [expectingToken, askForToken]);

  const ingestUrl = `${origin}/api/health/ingest`;

  const tokenField = plugin.config.find((field) => field.key === HEALTH_TOKEN_KEY);
  // A secret's value never travels to the browser, and the list endpoint only
  // echoes a non-secret value the settings file itself answered, so `value` is
  // present only when the server chose to send it.
  const listedToken =
    tokenField && tokenField.kind !== "secret" && tokenField.value?.trim()
      ? tokenField.value.trim()
      : undefined;
  /**
   * What the user is shown, in order of authority.
   *
   * The minted value wins because it is the newest thing the server said: a
   * token generated a moment ago is not in the list response the panel rendered
   * from. The listed value is next, and it is what a plain `GET` can honestly
   * offer. Nothing here reads a secret back out — `kind: "secret"` never reaches
   * this branch.
   */
  const shownToken = minted?.token ?? listedToken;
  const tokenFromEnv = minted ? minted.from === "env" : Boolean(tokenField?.present && !listedToken);

  return (
    <div className="mt-4 border-t border-hairline pt-4">
      <p className="label">From your phone</p>
      <p className="mt-2 text-[13px] leading-relaxed font-light text-dim">
        Apple Health and Google Fit have no key to paste, so a phone posts a
        day&rsquo;s sample to her directly. That needs no folder and no
        account.
      </p>

      <div className="mt-3">
        <p className="text-[12px] font-normal text-faint">Post to</p>
        {/* `min-w-0` and `wrap-anywhere` are both load-bearing. A block inside
            a padded container defaults to `min-width: auto`, so a long address
            widens the panel instead of wrapping inside it; and a URL has no
            spaces, so only `overflow-wrap: anywhere` gives the browser a place
            to break. The scroll container stays as the second line of defence
            for a value with no break opportunity at all. */}
        <code className="mt-1 block min-w-0 overflow-x-auto rounded-[var(--r-md)] border border-hairline bg-black/30 px-3 py-2 font-mono text-[12px] text-dim wrap-anywhere">
          {/* A link, but never in this tab: the route answers POST, so a click
              here is a method-not-allowed page. Opening it beside the panel
              makes the address inspectable without navigating the app away,
              which is the whole reason it is a link rather than plain text. */}
          <a
            href={ingestUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2"
          >
            {ingestUrl}
          </a>
        </code>
      </div>

      <div className="mt-3">
        <p className="text-[12px] font-normal text-faint">Header</p>
        <code className="mt-1 inline-block rounded-[var(--r-sm)] border border-hairline px-2 py-1 font-mono text-[12px] text-dim">
          {HEALTH_TOKEN_HEADER}
        </code>
      </div>

      <div className="mt-3">
        <p className="text-[12px] font-normal text-faint">Body</p>
        {/* `min-w-0` and `wrap-anywhere` are both load-bearing. A block inside
            a padded container defaults to `min-width: auto`, so a long address
            widens the panel instead of wrapping inside it; and a URL has no
            spaces, so only `overflow-wrap: anywhere` gives the browser a place
            to break. The scroll container stays as the second line of defence
            for a value with no break opportunity at all. */}
        <code className="mt-1 block min-w-0 overflow-x-auto rounded-[var(--r-md)] border border-hairline bg-black/30 px-3 py-2 font-mono text-[12px] text-dim wrap-anywhere">
          {HEALTH_BODY_EXAMPLE}
        </code>
      </div>

      {shownToken ? (
        <div className="mt-3">
          <p className="text-[12px] font-normal text-faint">
            {`${tokenField?.label ?? "Token"}, as sent in that header`}
          </p>
          {/* Read-only and without a copy button: this is a value the user
              carries to another device by hand, and a one-tap copy of a token
              that this panel cannot clear from a clipboard is the wrong
              affordance. Selecting the text still works for anyone who wants
              it on this machine. */}
          <code className="mt-1 block min-w-0 overflow-x-auto rounded-[var(--r-md)] border border-hairline px-3 py-2 font-mono text-[12px] text-dim select-text wrap-anywhere">
            {shownToken}
          </code>
          {minted?.message ? (
            <p className="mt-1.5 text-[12px] leading-relaxed font-normal text-faint">
              {minted.message}
            </p>
          ) : null}
        </div>
      ) : tokenFromEnv ? (
        <p className="mt-3 text-[12px] leading-relaxed font-normal text-dim">
          A token is set in your environment. An environment value is never
          echoed into this page, so it is not shown here — the header needs
          that value, from wherever you exported it.
        </p>
      ) : expectingToken ? (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[12px] leading-relaxed font-normal text-dim">
              {asking
                ? "Generating a token…"
                : "No token yet. Xana can generate one, or you can type your own in the field above."}
            </p>
            <Button onClick={() => void askForToken()} disabled={asking}>
              {asking ? "Working…" : "Generate a token"}
            </Button>
          </div>
          {tokenError ? <StatusLine tone="error">{tokenError}</StatusLine> : null}
        </div>
      ) : (
        <p className="mt-3 text-[12px] leading-relaxed font-normal text-dim">
          {/* The order of these two sentences is the fix for a real bug: this
              used to promise a token would be generated while nothing minted
              one, because the endpoint is closed until the field above says
              otherwise. */}
          {`Put "on" in the ${acceptField?.label ?? "accept posts"} field above and save. Xana generates the token when it does, and shows it here.`}
        </p>
      )}

      {/* The switch that opens the endpoint at all. It is named from the
          descriptor rather than re-read here: "is ingest on" is the server's
          answer to give, and a client-side second opinion about it is exactly
          what this panel refuses to form anywhere else. */}
      <p className="mt-3 text-[12px] leading-relaxed font-normal text-dim">
        {`The ${acceptField?.label ?? "accept posts"} field above also has to be on: while it is off, the endpoint refuses every post.`}
      </p>

      <ol className="mt-3 list-decimal space-y-2 pl-4 text-[12px] leading-relaxed font-normal text-dim">
        <li>
          <span className="text-text">iPhone.</span> In Shortcuts, add Get
          Health Sample, then Get Contents of URL. Set the method to POST, the
          request body to JSON, paste the body above, and add a header named{" "}
          <span className="font-mono text-[11px]">{HEALTH_TOKEN_HEADER}</span>{" "}
          with the token.
        </li>
        <li>
          <span className="text-text">Android.</span> Health Sync or Health
          Connect can write an export folder, and Tasker&rsquo;s HTTP Request
          action can post this same URL, header and body.
        </li>
        <li>
          <span className="text-text">No phone at all.</span> Point the export
          folder above at a folder on this machine and she reads the files
          directly.
        </li>
      </ol>

      {/* One honest sentence about the network, before someone spends an
          evening debugging a shortcut that was never the problem. */}
      <p className="mt-3 text-[12px] leading-relaxed font-normal text-dim">
        Xana has to be reachable on your network for a phone to post to her.
        Start her with{" "}
        <code className="font-mono text-[11px]">HOSTNAME=0.0.0.0 npm run dev</code>{" "}
        to listen beyond this machine, and use this machine&rsquo;s address on
        your network rather than the one above. The same switch exposes this
        interface to the local network, so turn it on for a network you trust.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The older flat environment values                                  */
/* ------------------------------------------------------------------ */

interface LegacyEnvSectionProps {
  view: SettingsView;
  onSave: ConnectionsPanelProps["onSave"];
  saving: boolean;
}

/**
 * Older XANA_* environment values, folded into the connections screen.
 *
 * The whole form is generated from `SOURCE_GROUPS`, which is a data structure
 * rather than markup: adding an entry there adds a field here. Nothing new
 * should be added to it — new configuration is a connection's own `config`,
 * and lives in the cards above — but every one of these keys still resolves
 * from the environment, and a key a user can set but cannot unset is worse
 * than a key with no form at all.
 *
 * Collapsed by default, and that is the whole point of the shape: this is the
 * less likely half of the screen, and it should cost one line of attention
 * until someone actually has an old value to clear. Everything inside —
 * clear, undo, discard, and the rule that an untouched secret is never sent
 * back — behaves exactly as it did when this was its own screen.
 */
function LegacyEnvSection({ view, onSave, saving }: LegacyEnvSectionProps) {
  // Drafts are keyed by field, and a key is absent until the user touches
  // it — so "unchanged" and "cleared" stay distinguishable.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<Record<string, true>>({});
  const [saved, setSaved] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, true>>({});
  // Only the chevron reads this. The element owns its own open state, so a
  // keyboard toggle and a pointer click both report through the same event.
  const [open, setOpen] = useState(false);

  const valueFor = (field: SourceField): string => {
    if (field.kind === "secret") return drafts[field.key] ?? "";
    return drafts[field.key] ?? view.sourceValues[field.key] ?? "";
  };

  const setValue = (field: SourceField, value: string) => {
    setDrafts((previous) => ({ ...previous, [field.key]: value }));
    setCleared((previous) => {
      if (!previous[field.key]) return previous;
      const next = { ...previous };
      delete next[field.key];
      return next;
    });
    setSaved(false);
  };

  const dirty = Object.keys(drafts).length > 0 || Object.keys(cleared).length > 0;

  const save = async () => {
    const sources: Record<string, string> = {};
    for (const [key, value] of Object.entries(drafts)) {
      // Secrets: an untouched field stays untouched. Non-secrets send their
      // value, including an empty string, which clears the entry.
      if (value.trim() || !isSecretKey(key)) sources[key] = value;
    }
    const next = await onSave({
      sources,
      clearSources: Object.keys(cleared),
    });
    if (next) {
      setDrafts({});
      setCleared({});
      setSaved(true);
    }
  };

  const reset = () => {
    setDrafts({});
    setCleared({});
    setSaved(false);
  };

  return (
    <details
      className="border-b border-hairline px-6 py-6 last:border-b-0"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-start justify-between gap-4 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block text-[15px] font-normal tracking-[0.01em] text-text">
            Older XANA_* environment values
          </span>
          <span className="mt-1 block max-w-[52ch] text-[13px] leading-relaxed font-light text-dim">
            {`The flat XANA_* names from before connections had their own fields — ${SOURCE_GROUPS.length} groups of them. Every one still resolves, so this is where an older value is set or cleared.`}
          </span>
        </span>
        {/* Rotated with an inline transform rather than a variant class: the
            duration is the motion token, so reduced motion collapses it with
            everything else. */}
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
          className="mt-1.5 shrink-0 text-faint"
          style={{
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform var(--t-fast) var(--ease)",
          }}
        >
          <path
            d="M2 4.5l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>

      <div className="mt-5">
        <StatusLine tone="info">
          Values set here take precedence over your environment file, and
          apply on the next request — no restart.
        </StatusLine>

        {SOURCE_GROUPS.map((group) => (
          <div key={group.id} className="mt-5 border-t border-hairline pt-5">
            {/* One level below the card titles: these are sub-groups inside the
                single disclosure that holds the older environment names. */}
            <h5 className="text-[14px] font-normal text-text">{group.label}</h5>
            <p className="mt-1 max-w-[52ch] text-[13px] leading-relaxed font-light text-dim">
              {group.blurb}
            </p>

            <div className="mt-4 space-y-4">
              {group.fields.map((field) => {
                const secret = field.kind === "secret";
                const secretView = view.sourceSecrets[field.key];
                const isCleared = Boolean(cleared[field.key]);

                return (
                  <div key={field.key}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <label
                        htmlFor={`src-${field.key}`}
                        className="text-[13px] font-light text-text"
                      >
                        {field.label}
                      </label>
                      {secret && secretView?.present && !isCleared ? (
                        <Pill tone="ok">
                          {secretView.from === "env" ? "from environment" : "saved"}
                        </Pill>
                      ) : null}
                    </div>
                    <p className="mt-1 text-[12px] leading-relaxed font-normal text-faint">
                      {field.hint}
                    </p>

                    <div className="mt-2 flex gap-2">
                      {/* A stored secret the user has not asked to replace
                          shows its mask, read-only. Typing into it would
                          overwrite a working key by accident, and the mask
                          is not the key — round-tripping it would store the
                          bullet characters. */}
                      {secret && secretView?.present && !isCleared && !revealed[field.key] ? (
                        <input
                          id={`src-${field.key}`}
                          type="password"
                          readOnly
                          value={secretView?.masked ?? ""}
                          className="field font-mono text-[12px] text-dim"
                          aria-label={`${field.label}, already set`}
                        />
                      ) : (
                        <input
                          id={`src-${field.key}`}
                          type={secret ? "password" : "text"}
                          value={valueFor(field)}
                          spellCheck={false}
                          autoComplete="off"
                          placeholder={
                            secret && secretView?.present
                              ? "••••••••  (unchanged)"
                              : (field.example ?? "")
                          }
                          onChange={(event) => setValue(field, event.target.value)}
                          className="field font-mono text-[12px]"
                        />
                      )}

                      {secret && secretView?.present && !isCleared ? (
                        <Button
                          onClick={() =>
                            setRevealed((previous) => ({
                              ...previous,
                              [field.key]: true,
                            }))
                          }
                        >
                          Replace
                        </Button>
                      ) : null}

                      {isCleared ? (
                        <Button onClick={() => setValue(field, "")}>Undo</Button>
                      ) : (
                        <Button
                          onClick={() => {
                            setCleared((previous) => ({
                              ...previous,
                              [field.key]: true,
                            }));
                            setDrafts((previous) => {
                              const next = { ...previous };
                              delete next[field.key];
                              return next;
                            });
                          }}
                          disabled={
                            !view.sourceValues[field.key] &&
                            !drafts[field.key] &&
                            !secretView?.present
                          }
                        >
                          Clear
                        </Button>
                      )}
                    </div>

                    {isCleared ? (
                      <p className="mt-1.5 text-[12px] font-normal text-warn">
                        Will be removed when you save.
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <div className="mt-6 border-t border-hairline pt-5">
          <Actions>
            {/* "these values", not "connections": the cards above save
                themselves, and this button covers only the block it sits in. */}
            <Button onClick={() => void save()} disabled={saving || !dirty} variant="primary">
              {saving ? "Saving…" : "Save these values"}
            </Button>
            <Button onClick={reset} disabled={!dirty}>
              Discard changes
            </Button>
            {saved ? (
              <StatusLine tone="ok">Saved. She will pick these up immediately.</StatusLine>
            ) : null}
            {!dirty && !saved ? (
              <StatusLine tone="info">Nothing changed yet.</StatusLine>
            ) : null}
          </Actions>
        </div>
      </div>
    </details>
  );
}

/** The HTML input type for a config kind. A path is text; there is no path. */
function inputType(kind: PluginConfigView["kind"]): "text" | "url" | "number" {
  if (kind === "url") return "url";
  if (kind === "number") return "number";
  return "text";
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("https://") || value.startsWith("http://");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSecretKey(key: string): boolean {
  for (const group of SOURCE_GROUPS) {
    for (const field of group.fields) {
      if (field.key === key) return field.kind === "secret";
    }
  }
  return false;
}
