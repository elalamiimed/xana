"use client";

import { useId, useMemo, useState } from "react";

import { DEFAULT_PERSONA } from "@/lib/settings/types";
import type { ModelProvider, SettingsPatch, SettingsView } from "@/lib/settings/types";
import {
  PROVIDERS,
  canonicalBaseUrl,
  findProvider,
  inferShape,
  matchProvider,
  shapeFromPath,
} from "@/lib/settings/providers";
import {
  endpointProblem,
  normaliseEndpoint,
  resolveEndpointPath,
} from "@/lib/settings/endpoints";

import {
  Actions,
  Button,
  Field,
  Pill,
  Section,
  SelectField,
  Slider,
  StatusLine,
  Switch,
  TextArea,
  TextField,
} from "./controls";
import type { ProbeResult, SettingsController } from "../useSettings";

/**
 * Models: which one answers, with whose key, in whose voice.
 *
 * The layout follows the order a person thinks in when setting this up:
 * *which provider*, *which model*, *which key*, *does it work*. The "does
 * it work" step is a real request to the real endpoint, made before saving,
 * because the failure modes here —a truncated key, a base URL missing
 * `/v1`, a provider that is simply down —are indistinguishable from each
 * other without trying once.
 *
 * Two details exist purely to remove friction for someone pasting a key in
 * a hurry:
 *
 *  - **The base URL normalises as you leave the field.** Providers
 *    document three different shapes for the same endpoint and only one of
 *    them used to work; the field now accepts all three and rewrites itself
 *    to the canonical one, so the user can see what was understood.
 *  - **The endpoint that will actually be requested is printed.** When a
 *    test fails, the next question is always "where did it send that?", and
 *    the answer should not require reading the source.
 *
 * The persona field is last on purpose. It is the most interesting control
 * and the least necessary, and putting it first would suggest that writing
 * a prompt is part of setup. It is not.
 */

export interface ModelPanelProps {
  view: SettingsView;
  controller: SettingsController;
}

/**
 * The action bar for the model section.
 *
 * Pinned to the bottom of the settings panel whenever this tab is open, and
 * that is the whole point: the section above it is long enough (provider,
 * shape, model, endpoint, key, temperature, test) that the buttons which
 * actually commit the change were easy to scroll past. "The key does not
 * save" is what that looks like from the outside. A save control that is
 * always on screen removes the possibility.
 *
 * The change count is shown because the alternative, a permanently enabled
 * Save button, makes it impossible to tell whether there is anything to
 * save.
 */
function ModelActionBar({
  dirty,
  saving,
  keyTyped,
  onSave,
  onTest,
  probing,
}: {
  dirty: boolean;
  saving: boolean;
  keyTyped: boolean;
  onSave: () => void;
  onTest: () => void;
  probing: boolean;
}) {
  return (
    <div className="sticky bottom-0 z-10 border-t border-hairline bg-surface-2/95 px-4 py-3 backdrop-blur-sm">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onSave} disabled={saving} variant="primary">
          {saving ? "Saving…" : "Save model settings"}
        </Button>
        <Button onClick={onTest} disabled={probing}>
          {probing ? "Asking the provider…" : "Test connection"}
        </Button>
        <span className="text-[12px] font-normal text-dim">
          {keyTyped
            ? "Includes the key you just typed."
            : dirty
              ? "There are unsaved changes."
              : "Everything here is saved."}
        </span>
      </div>
    </div>
  );
}

export default function ModelPanel({ view, controller }: ModelPanelProps) {
  const { model, voice, identity } = view;

  /** One id for the hand-built Base URL field, so its label and hint resolve. */
  const baseUrlId = useId();

  const [enabled, setEnabled] = useState(model.enabled);
  const [shape, setShape] = useState<ModelProvider>(model.provider);
  const [modelName, setModelName] = useState(model.model);
  const [baseUrl, setBaseUrl] = useState(model.baseUrl);
  const [temperature, setTemperature] = useState(model.temperature);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);

  const [persona, setPersona] = useState(voice.persona);
  const [name, setName] = useState(identity.name);
  const [location, setLocation] = useState(identity.location);

  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  /** Set when the last normalisation actually changed what was typed. */
  const [normalised, setNormalised] = useState(false);

  const keyPresent = model.apiKey.present && !clearKey;

  /** The preset the current form matches, for highlighting a chip. */
  const activePreset = useMemo(
    () => matchProvider(baseUrl, modelName)?.id ?? "",
    [baseUrl, modelName],
  );

  const activeProvider = findProvider(activePreset);

  /**
   * The base URL as it will really be used, and the endpoint that follows
   * from it. Shown to the user, so this is resolved the same way
   * `resolveModel` does rather than approximately.
   */
  const effectiveBase = useMemo(() => {
    const chosen = baseUrl.trim();
    if (!chosen) {
      const preset = findProvider(activePreset) ?? (shape === "anthropic" ? findProvider("anthropic") : findProvider("deepseek"));
      return preset?.baseUrl ?? (shape === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1");
    }
    return canonicalBaseUrl(chosen);
  }, [baseUrl, activePreset, shape]);

  const effectivePath = resolveEndpointPath(effectiveBase, shape);
  const baseProblem = endpointProblem(baseUrl);
  const modelOptions = activeProvider?.models ?? [];

  /** Apply a provider preset to the whole form. */
  const applyProvider = (id: string) => {
    const preset = findProvider(id);
    if (!preset) return;
    setShape(preset.shape);
    setBaseUrl(preset.baseUrl);
    // Keep a model the user chose if the new provider also offers it;
    // otherwise take the provider's default. Switching provider should not
    // silently keep a model id that cannot exist there.
    setModelName((current) =>
      preset.models.some((m) => m.toLowerCase() === current.trim().toLowerCase())
        ? current
        : preset.defaultModel,
    );
    setProbe(null);
    setNormalised(false);
  };

  /**
   * Tidy the base URL when focus leaves it.
   *
   * This is where the three documented shapes collapse into one. It also
   * picks up the provider shape when the user pasted a full endpoint URL
   * ending in `/messages`, because that is Anthropic's shape and requiring
   * them to also find the "Request shape" control would be a trap.
   */
  const commitBaseUrl = () => {
    const raw = baseUrl.trim();
    if (!raw) {
      setNormalised(false);
      return;
    }
    const normal = normaliseEndpoint(raw);
    const tidied = canonicalBaseUrl(raw);

    const impliedShape = shapeFromPath(normal.namedEndpoint) ?? inferShape(tidied);
    if (impliedShape && impliedShape !== shape) setShape(impliedShape);

    if (tidied !== raw) {
      setBaseUrl(tidied);
      setNormalised(true);
    } else {
      setNormalised(false);
    }
  };

  const modelPatch = () => ({
    model: {
      enabled,
      provider: shape,
      model: modelName,
      baseUrl,
      temperature,
      ...(clearKey
        ? { clearApiKey: true }
        : apiKey.trim()
          ? { apiKey: apiKey.trim() }
          : {}),
    },
  });

  const saveModel = async () => {
    const next = await controller.save(modelPatch());
    if (next) {
      setSaved("Model settings saved. She will use it on your next message.");
      setApiKey("");
      setClearKey(false);
      setNormalised(false);
    }
  };

  const runProbe = async () => {
    setProbing(true);
    setProbe(null);
    // Against the *unsaved* form, reusing the stored key when the field was
    // left alone. The point is to validate what is on screen.
    const result = await controller.probe(modelPatch());
    setProbe(result);
    setProbing(false);
  };

  const saveVoice = async () => {
    const next = await controller.save({
      voice: { persona },
      identity: { name, location },
    });
    if (next) setSaved("Voice and identity saved.");
  };

  /**
   * Whether anything on this tab differs from what is stored.
   *
   * Deliberately coarse, and deliberately includes the key: a typed key is
   * the single most important "unsaved change" on this screen, and leaving
   * it out of the calculation is how a Save button ends up looking like it
   * has nothing to do.
   */
  const dirty =
    apiKey.trim().length > 0 ||
    clearKey ||
    enabled !== model.enabled ||
    shape !== model.provider ||
    modelName !== model.model ||
    baseUrl !== model.baseUrl ||
    temperature !== model.temperature;

  return (
    <div>
      {/* ---------------- status ---------------- */}
      <Section
        title="The mind answering"
        blurb="Xana runs her own engine with no key, no account and no network. A model makes her phrasing better; it never decides what she does."
      >
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={view.effective.active ? "ok" : "idle"}>
            {view.effective.active ? "Model active" : "Local mind"}
          </Pill>
          {keyPresent ? (
            <Pill tone="ok">
              {model.apiKey.from === "env" ? "Key from environment" : "Key saved"}
            </Pill>
          ) : (
            <Pill tone="warn">No key</Pill>
          )}
          {view.effective.active ? (
            <span className="font-mono text-[12px] text-faint">
              {view.effective.model}
            </span>
          ) : null}
        </div>

        <Switch
          label="Let a model answer"
          hint={
            enabled
              ? "Replies come from the model below. Intent and every write-back still resolve locally, first."
              : "Off: Xana answers from her own engine. Everything works except free-form conversation."
          }
          checked={enabled}
          onChange={(next) => {
            setEnabled(next);
            setProbe(null);
          }}
        />

        {/* Deliberately not disabled when no key is present. A disabled
            switch with no explanation is the worst version of this control:
            it looks broken. Switching it on and being told exactly what is
            missing is the same number of clicks and answers the question. */}
        {enabled && !keyPresent ? (
          <StatusLine tone="error">
            No key yet, so nothing will answer. Paste one below, or switch
            this off and she will use her own engine.
          </StatusLine>
        ) : null}

        {!enabled ? (
          <StatusLine tone="info">
            She will still brief you, take tasks, run focus blocks and track
            goals. She will not improvise.
          </StatusLine>
        ) : null}
      </Section>

      {/* ---------------- provider ---------------- */}
      <Section
        title="Provider"
        blurb="Anything that speaks the OpenAI chat API works, including a server running on this machine."
      >
        <div className="flex flex-wrap gap-2">
          {PROVIDERS.map((preset) => (
            /* The system's `.chip-round`. This row was a fourth private
               recipe for "small control": its own pill radius, its own
               pressed colours, its own hover, and about 30px tall at 390px
               where a thumb is aiming. `.chip` carries all of it now, so a
               chosen provider looks like a chosen theme and a chosen room. */
            <button
              key={preset.id}
              type="button"
              onClick={() => applyProvider(preset.id)}
              aria-pressed={activePreset === preset.id}
              title={preset.note}
              className="chip chip-round"
            >
              {preset.label}
              {preset.keyless ? (
                <span aria-hidden="true" className="text-[11px] text-faint">
                  local
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {activeProvider ? (
          <StatusLine tone="info">{activeProvider.note}</StatusLine>
        ) : null}

        <SelectField
          label="Request shape"
          value={shape}
          onChange={(next) => {
            setShape(next);
            setProbe(null);
          }}
          options={[
            { value: "openai", label: "OpenAI-compatible (/chat/completions)" },
            { value: "anthropic", label: "Anthropic (/v1/messages)" },
          ]}
          hint="Inferred from the base URL. Every provider except Anthropic uses the first."
        />

        {/* A real model picker when the provider publishes a list, and the
            free-text field below it either way: a fine-tune, an internal
            deployment or a model released this morning all have to work. */}
        {modelOptions.length > 0 ? (
          <SelectField
            label="Model"
            value={modelOptions.some((m) => m === modelName) ? modelName : ""}
            onChange={(next) => {
              if (next) setModelName(next);
              setProbe(null);
            }}
            options={[
              ...(modelOptions.some((m) => m === modelName)
                ? []
                : [{ value: "", label: `${modelName || "this model"} (custom)` }]),
              ...modelOptions.map((m) => ({ value: m, label: m })),
            ]}
            hint="From the provider's published list. Use the field below for anything else."
          />
        ) : null}

        <TextField
          label={modelOptions.length > 0 ? "Or type a model id" : "Model"}
          value={modelName}
          onChange={(next) => {
            setModelName(next);
            setProbe(null);
          }}
          placeholder={activeProvider?.defaultModel ?? "gpt-4o-mini"}
          hint="The exact model id the provider expects."
          spellCheck={false}
        />

        <Field
          label="Base URL"
          /* The id is what ties the label and the hint to the input. This
             field was the one in the panel built by hand rather than through
             `TextField`, and it was paying for that: `Field` only renders the
             hint's `id` when it is given `htmlFor`, so the sentence about the
             three URL shapes reached nobody, and the label was never
             associated with the box. */
          htmlFor={baseUrlId}
          hint={
            normalised
              ? "Tidied to the canonical form. All three shapes a provider documents work here —with or without /v1, and a full endpoint URL pasted by mistake is corrected too."
              : "Where requests go. Leave empty to use the provider's default. All three documented shapes work: with /v1, without it, or a full endpoint URL."
          }
          error={baseProblem}
        >
          <input
            id={baseUrlId}
            type="url"
            value={baseUrl}
            spellCheck={false}
            autoComplete="off"
            placeholder={activeProvider?.baseUrl || "https://api.deepseek.com/v1"}
            aria-describedby={`${baseUrlId}-hint`}
            aria-invalid={baseProblem ? true : undefined}
            /* `.field` is unlayered, so `border-danger/40` as a utility loses
               to its hairline no matter what order the classes are written
               in; the inline declaration is the one way to paint the invalid
               border without a new shared class for a state only this input
               has. Same recipe as `.chip-danger`. */
            style={
              baseProblem
                ? { borderColor: "color-mix(in oklab, var(--danger) 40%, transparent)" }
                : undefined
            }
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setProbe(null);
              setNormalised(false);
            }}
            onBlur={commitBaseUrl}
            className="field font-mono"
          />
        </Field>

        {/* Where the request will actually go. This is the single most
            useful line on the page when a test fails. */}
        <div className="rounded-[var(--r-md)] border border-hairline bg-well px-3 py-2">
          <span className="label">Requests go to</span>
          {/* `wrap-anywhere` because a base URL has no spaces: without it the
              path widens the panel rather than wrapping inside it, and this is
              the line a user reads when a test fails. */}
          <code className="mt-1 block min-w-0 overflow-x-auto font-mono text-[12px] text-dim wrap-anywhere">
            {effectivePath}
          </code>
        </div>
      </Section>

      {/* ---------------- key ---------------- */}
      <Section
        title="API key"
        blurb="Stored on this machine only, in the settings file below, readable only by your user account. It is never sent back to the browser once saved, which is why the field shows dots rather than your key."
      >
        {/*
          The input, its status, and both buttons sit in ONE block on
          purpose. They were previously spread across two sections with the
          temperature slider between them, which made the outcome of a save
          something you had to scroll to find. The single most common report
          about this screen is "the key did not save", and the honest cause
          is that nothing said whether it had.
        */}
        <div className="rounded-[var(--r-lg)] border border-hairline bg-well p-4">
          <label htmlFor="xana-api-key" className="block text-[13px] font-light text-text">
            {keyPresent ? "Replace the stored key" : "Your API key"}
          </label>

          <input
            id="xana-api-key"
            type="password"
            value={apiKey}
            autoComplete="off"
            spellCheck={false}
            disabled={clearKey}
            // Focusing an untouched field clears the mask, so typing or
            // pasting replaces the key rather than appending to dots.
            onFocus={() => {
              if (keyPresent && apiKey === "") setApiKey("");
            }}
            placeholder={
              clearKey
                ? "will be removed when you save"
                : keyPresent
                  ? model.apiKey.masked
                  : activeProvider?.keyless
                    ? "not needed for this provider"
                    : "paste your key here"
            }
            onChange={(event) => {
              setApiKey(event.target.value);
              setProbe(null);
              setSaved(null);
            }}
            className="field mt-2 font-mono"
          />

          {/* Status, in words rather than a colour. The case that matters is
              a stored key with the model switched off: it looks configured
              and answers locally, which is the least diagnosable state this
              screen can be in. */}
          <div className="mt-3 space-y-1.5">
            {keyPresent && !enabled && !clearKey ? (
              <p role="alert" className="text-[12px] leading-relaxed font-normal text-warn">
                A key is stored, but <strong className="font-normal">Let a model answer</strong>{" "}
                is switched off above, so nothing will call out and every reply
                comes from her own engine. Switch it on to use this key.
              </p>
            ) : keyPresent ? (
              <p className="text-[12px] font-normal text-good">
                A key is stored ({model.apiKey.masked}
                {model.apiKey.from === "env" ? ", from the environment" : ""}) and
                the model is on. Replies will use it.
              </p>
            ) : (
              <p className="text-[12px] font-normal text-warn">
                No key stored yet, so nothing will answer. Paste one above, then
                press Save. Nothing is written until you do.
              </p>
            )}
            {apiKey.trim() ? (
              <p className="text-[12px] font-normal text-dim">
                {keyPresent
                  ? "A new key is typed and will replace the stored one when you press Save."
                  : "Ready. Press Save to store it, which also switches the model on, or Test connection to check it first."}
              </p>
            ) : null}
            {clearKey ? (
              <p className="text-[12px] font-normal text-warn">
                The stored key will be deleted when you save, and the model will
                switch off.
              </p>
            ) : null}
          </div>

          {/* The two buttons, together, immediately under the field. */}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              onClick={() => void saveModel()}
              disabled={controller.saving || (!keyPresent && !apiKey.trim())}
              variant="primary"
            >
              {controller.saving ? "Saving…" : "Save key"}
            </Button>
            <Button onClick={() => void runProbe()} disabled={probing}>
              {probing ? "Asking the provider…" : "Test connection"}
            </Button>
            {keyPresent && !clearKey ? (
              <Button
                onClick={() => {
                  setClearKey(true);
                  setApiKey("");
                  setEnabled(false);
                  setProbe(null);
                }}
              >
                Remove key
              </Button>
            ) : null}
            {clearKey ? <Button onClick={() => setClearKey(false)}>Undo</Button> : null}
          </div>

          {/* Whatever the last probe said, kept in place next to the button
              that caused it rather than only at the foot of the section. */}
          {probe ? (
            <p
              role={probe.ok ? "status" : "alert"}
              className={`mt-3 text-[12px] leading-relaxed font-normal ${
                probe.ok ? "text-good" : "text-danger"
              }`}
            >
              {probe.ok
                ? `The provider answered in ${probe.latencyMs ?? "?"}ms. Press Save to keep this key.`
                : probe.message}
            </p>
          ) : null}
        </div>

        <Slider
          label="Temperature"
          value={temperature}
          min={0}
          max={2}
          step={0.05}
          format={(value) => value.toFixed(2)}
          hint="Lower is more literal and consistent. Higher is more conversational. 0.7 is a good default."
          onChange={setTemperature}
        />
      </Section>

      {/* ---------------- the test ---------------- */}
      <Section
        title="Check it works"
        blurb="Sends one tiny request with the values above, before saving them. Nothing is stored until you save. This is the same request the buttons in the key section run."
      >
        {probe ? (
          <StatusLine tone={probe.ok ? "ok" : "error"}>
            {probe.ok
              ? `${probe.model ?? modelName} answered. ${probe.message}`
              : probe.message}
          </StatusLine>
        ) : (
          <StatusLine tone="info">
            {`Will ask ${modelName || "the model"} at ${effectivePath}.`}
          </StatusLine>
        )}

        {controller.error ? (
          <StatusLine tone="error">{controller.error}</StatusLine>
        ) : null}
        {saved ? <StatusLine tone="ok">{saved}</StatusLine> : null}
      </Section>

      {/* ---------------- persona ---------------- */}
      <Section
        title="Her voice"
        blurb="The instructions she answers with. The default is the personality she was designed around; change it if you want her warmer, terser, or more formal."
      >
        <TextArea
          label="Persona"
          value={persona}
          onChange={setPersona}
          rows={14}
          placeholder="Leave this empty to use the built-in persona. Type here to write your own."
          hint="Only used when a model answers. The built-in persona is the one she was designed around."
        />
        <Actions>
          <Button onClick={() => setPersona(DEFAULT_PERSONA)}>
            Copy the default in, to edit it
          </Button>
          <Button onClick={() => setPersona("")} disabled={!persona}>
            Reset to built-in
          </Button>
        </Actions>

        <div className="grid grid-cols-1 gap-4 border-t border-hairline pt-5 sm:grid-cols-2">
          <TextField
            label="What she calls you"
            value={name}
            onChange={setName}
            placeholder="your name"
            hint="Used in conversation and in the page title."
            spellCheck={false}
          />
          <TextField
            label="Where you are"
            value={location}
            onChange={setLocation}
            placeholder="city"
            hint="Given to her as context. Coordinates go in Connections, then Weather."
            spellCheck={false}
          />
        </div>

        <Actions>
          <Button onClick={() => void saveVoice()} disabled={controller.saving} variant="primary">
            {controller.saving ? "Saving…" : "Save voice and identity"}
          </Button>
        </Actions>
      </Section>

      <ModelActionBar
        dirty={dirty}
        saving={controller.saving}
        keyTyped={apiKey.trim().length > 0}
        probing={probing}
        onSave={() => void saveModel()}
        onTest={() => void runProbe()}
      />
    </div>
  );
}
