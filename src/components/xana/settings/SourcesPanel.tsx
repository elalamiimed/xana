"use client";

import { useState } from "react";

import {
  SOURCE_GROUPS,
  type SourceField,
  type SettingsView,
} from "@/lib/settings/types";

import { Actions, Button, Pill, Section, StatusLine } from "./controls";

/**
 * Sources: the life-data connections.
 *
 * The whole form is generated from `SOURCE_GROUPS`, which is a data
 * structure rather than markup. Adding a new integration to the app is
 * adding one object there — no change to this file. That matters because
 * this is the screen that will grow every time Xana learns to read
 * something new, and a hand-built form would rot within two additions.
 *
 * Each adapter's live state is shown on its own section, so "I typed the
 * URL and nothing happened" is answerable without leaving the panel: the
 * pill says offline, error, or local, in the same vocabulary the header
 * dots use.
 */

export interface SourcesPanelProps {
  view: SettingsView;
  /** Live adapter statuses, keyed by adapter id, from the life state. */
  statuses: Record<string, { state: string; mode: string; detail?: string }>;
  onSave: (patch: {
    sources?: Record<string, string>;
    clearSources?: string[];
  }) => Promise<unknown>;
  saving: boolean;
}

const STATE_TONE: Record<string, "ok" | "warn" | "idle"> = {
  connected: "ok",
  local: "idle",
  offline: "warn",
  error: "warn",
};

export default function SourcesPanel({
  view,
  statuses,
  onSave,
  saving,
}: SourcesPanelProps) {
  // Drafts are keyed by field, and a key is absent until the user touches
  // it — so "unchanged" and "cleared" stay distinguishable.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [cleared, setCleared] = useState<Record<string, true>>({});
  const [saved, setSaved] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, true>>({});

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
    <div>
      <Section
        title="Connections"
        blurb="Everything below is optional and read-only from Xana's side, except notes. Her own engine covers the day without any of it, so there is no pressure to fill this in."
      >
        <StatusLine tone="info">
          Values set here take precedence over your environment file, and
          apply on the next request — no restart.
        </StatusLine>
      </Section>

      {SOURCE_GROUPS.map((group) => {
        const status = statuses[group.id];
        return (
          <Section key={group.id} title={group.label} blurb={group.blurb}>
            {status ? (
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={STATE_TONE[status.state] ?? "idle"}>
                  {status.state}
                </Pill>
                <span className="font-mono text-[11px] text-faint">{status.mode}</span>
                {status.detail ? (
                  <span className="text-[12px] font-normal text-dim">{status.detail}</span>
                ) : null}
              </div>
            ) : null}

            <div className="space-y-4">
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
          </Section>
        );
      })}

      <Section title="Save">
        <Actions>
          <Button onClick={() => void save()} disabled={saving || !dirty} variant="primary">
            {saving ? "Saving…" : "Save connections"}
          </Button>
          <Button onClick={reset} disabled={!dirty}>
            Discard changes
          </Button>
          {saved ? <StatusLine tone="ok">Saved. She will pick these up immediately.</StatusLine> : null}
          {!dirty && !saved ? (
            <StatusLine tone="info">Nothing changed yet.</StatusLine>
          ) : null}
        </Actions>
      </Section>
    </div>
  );
}

function isSecretKey(key: string): boolean {
  for (const group of SOURCE_GROUPS) {
    for (const field of group.fields) {
      if (field.key === key) return field.kind === "secret";
    }
  }
  return false;
}
