"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CATEGORY_LABEL,
  type PluginAction,
  type PluginCategory,
  type PluginConfigView,
  type PluginState,
  type PluginStatus,
  type PluginsResponse,
} from "../../../lib/plugins/types";

import {
  describePluginsError,
  getPlugins,
  postPluginAction,
  savePluginSettings,
} from "../api/plugins";

import { Actions, Button, Pill, Section, StatusLine, Switch } from "./controls";

/**
 * Plugins: what Xana may reach, and the permission for each reach.
 *
 * This is the consent surface. The endpoint beside it already decides
 * everything a card shows — whether a plugin is ready, which capabilities are
 * missing, whether a setting is present and which layer answered — so this
 * file renders that answer and never forms a second opinion about it. The two
 * numbers in the header are the server's own, in particular: re-deriving "is
 * this configured" here is exactly how a panel ends up saying Allowed next to
 * a plugin that cannot run.
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

export default function PluginsPanel() {
  const [data, setData] = useState<PluginsResponse | null>(null);
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
      setData(await getPlugins());
      setError(null);
    } catch (err) {
      setError(describePluginsError(err));
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
      if (isRecord(event.data) && event.data.source === "xana-plugins") {
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
        const result = await postPluginAction({ id: plugin.id, action, includeWrite });
        // Opened here, in the continuation of the click that asked for it, so
        // the browser still counts it as user-initiated. `noopener` keeps the
        // new tab from holding a handle on this one.
        if (result.authUrl) window.open(result.authUrl, "_blank", "noopener");
        await refresh();
        say(plugin.id, { tone: result.ok ? "ok" : "error", text: result.message });
      } catch (err) {
        say(plugin.id, { tone: "error", text: describePluginsError(err) });
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
        const result = await savePluginSettings(values);
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
        say(plugin.id, { tone: "error", text: describePluginsError(err) });
      } finally {
        setSavingId(null);
      }
    },
    [drafts, say],
  );

  // Grouped by label, keeping the server's order inside a category and the
  // order the categories first appear in: the panel has no ranking of its own.
  const groups = useMemo(() => {
    const order: PluginCategory[] = [];
    const byCategory = new Map<PluginCategory, PluginStatus[]>();
    for (const plugin of data?.plugins ?? []) {
      const bucket = byCategory.get(plugin.category);
      if (bucket) {
        bucket.push(plugin);
      } else {
        byCategory.set(plugin.category, [plugin]);
        order.push(plugin.category);
      }
    }
    return order.map((category) => ({
      category,
      label: CATEGORY_LABEL[category],
      plugins: byCategory.get(category) ?? [],
    }));
  }, [data]);

  return (
    <div>
      <Section
        title="Plugins"
        blurb="Everything Xana can reach beyond her own engine. She does not call a plugin until every capability it needs has been allowed here, and anything allowed can be withdrawn again."
      >
        {data ? (
          <p className="text-[13px] leading-relaxed font-normal text-text">
            {`${data.awaitingConsent} waiting for permission, ${data.unconfigured} missing a setting`}
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
            No plugins are registered in this build. Everything she knows comes
            from her own engine.
          </StatusLine>
        </Section>
      ) : null}

      {groups.map((group) => (
        <Section key={group.category} title={group.label}>
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
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One plugin                                                         */
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
    <article className="rounded-lg border border-hairline px-4 py-4">
      {/* Name, live state, and where the data actually comes from. The pill
          carries the word, so the colour is never the only signal. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h4 className="text-[14px] font-light text-text">{plugin.name}</h4>
        <Pill tone={STATE_TONE[plugin.state]}>{plugin.state}</Pill>
        <span className="label">source</span>
        <span className="font-mono text-[11px] font-normal text-faint">
          {plugin.provenance}
        </span>
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

      {optional.length > 0 ? (
        <div className="mt-4 border-t border-hairline pt-4">
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

      <div className="mt-4 border-t border-hairline pt-4">
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
