"use client";

import { useId, type ReactNode } from "react";

/**
 * The form primitives the settings panel is built from.
 *
 * Kept together and kept small, because the alternative — the same
 * `<label>` + `<input>` + hint markup written once per field — is how a
 * settings screen drifts into twelve slightly different field styles. Every
 * control here is labelled, every hint is wired through `aria-describedby`
 * rather than merely sitting near the input, and every state (disabled,
 * invalid, unset) has a defined look.
 */

/* ------------------------------------------------------------------ */
/* Section                                                            */
/* ------------------------------------------------------------------ */

export function Section({
  title,
  blurb,
  children,
  footer,
}: {
  title: string;
  blurb?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="border-b border-hairline px-6 py-6 last:border-b-0">
      <h3 className="text-[15px] font-normal tracking-[0.01em] text-text">
        {title}
      </h3>
      {blurb ? (
        <p className="mt-1 max-w-[52ch] text-[13px] leading-relaxed font-light text-dim">
          {blurb}
        </p>
      ) : null}
      <div className="mt-5 space-y-5">{children}</div>
      {footer ? <div className="mt-5">{footer}</div> : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Field                                                              */
/* ------------------------------------------------------------------ */

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-[13px] font-light text-text">
        {label}
      </label>
      {hint ? (
        <p id={htmlFor ? `${htmlFor}-hint` : undefined} className="mt-1 text-[12px] leading-relaxed font-normal text-faint">
          {hint}
        </p>
      ) : null}
      <div className="mt-2">{children}</div>
      {error ? (
        <p role="alert" className="mt-1.5 text-[12px] font-normal text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  placeholder,
  type = "text",
  autoComplete,
  spellCheck,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  hint?: string;
  placeholder?: string;
  type?: "text" | "password" | "url" | "number";
  autoComplete?: string;
  spellCheck?: boolean;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="field"
      />
    </Field>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  hint,
  rows = 10,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  hint?: string;
  rows?: number;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <textarea
        id={id}
        rows={rows}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="field resize-y font-mono text-[12px] leading-relaxed"
      />
    </Field>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
  hint?: string;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <select
        id={id}
        value={value}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(event.target.value as T)}
        className="field select"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/* ------------------------------------------------------------------ */
/* Switch                                                             */
/* ------------------------------------------------------------------ */

export function Switch({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-[13px] font-light text-text">
          {label}
        </label>
        {hint ? (
          <p className="mt-1 max-w-[46ch] text-[12px] leading-relaxed font-normal text-faint">
            {hint}
          </p>
        ) : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="switch mt-0.5 disabled:opacity-40"
      >
        <span className="switch-knob" />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Slider                                                             */
/* ------------------------------------------------------------------ */

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  /** Renders the current value. Never omit: a bare number is ambiguous. */
  format: (value: number) => string;
  hint?: string;
}) {
  const id = useId();
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <label htmlFor={id} className="text-[13px] font-light text-text">
          {label}
        </label>
        <span className="timestamp tabular-nums">{format(value)}</span>
      </div>
      {hint ? (
        /* The id is what makes `aria-describedby` below resolve. It pointed at
           `${id}-hint` with nothing carrying that id, so every slider in
           Settings described itself to a screen reader as nothing at all. */
        <p id={`${id}-hint`} className="mt-1 text-[12px] leading-relaxed font-normal text-faint">
          {hint}
        </p>
      ) : null}
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(event) => onChange(Number(event.target.value))}
        className="slider mt-3"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Actions and status                                                 */
/* ------------------------------------------------------------------ */

export function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>;
}

export function Button({
  children,
  onClick,
  variant = "ghost",
  disabled,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`btn ${variant === "primary" ? "btn-primary" : "btn-ghost"}`}
    >
      {children}
    </button>
  );
}

/**
 * A one-line status message under a group of controls.
 *
 * `role="status"` for a success and `role="alert"` for a failure: a screen
 * reader should be interrupted for "the key was refused" and merely
 * informed for "saved".
 */
export function StatusLine({
  tone,
  children,
}: {
  tone: "ok" | "error" | "info";
  children: ReactNode;
}) {
  const colour =
    tone === "ok" ? "text-good" : tone === "error" ? "text-danger" : "text-dim";
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`text-[12px] leading-relaxed font-normal ${colour}`}
    >
      {children}
    </p>
  );
}

/**
 * A small state pill, for "set" / "from .env" / "not set".
 *
 * Deliberately not colour-only: the word carries the meaning and the tint
 * only reinforces it.
 */
export function Pill({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "idle";
  children: ReactNode;
}) {
  const ring =
    tone === "ok"
      ? "border-good/30 text-good"
      : tone === "warn"
        ? "border-warn/30 text-warn"
        : "border-hairline text-faint";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-[2px] text-[11px] font-medium tracking-[0.12em] uppercase ${ring}`}
    >
      {children}
    </span>
  );
}

/** A row of small tab buttons, used for the settings sections. */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  ariaLabel,
  orientation = "vertical",
}: {
  tabs: readonly { id: T; label: string; badge?: boolean }[];
  active: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  orientation?: "vertical" | "horizontal";
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation={orientation}
      className={
        orientation === "vertical"
          ? "flex flex-col gap-0.5"
          : "flex gap-1 overflow-x-auto"
      }
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={`panel-${tab.id}`}
            id={`tab-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={`relative shrink-0 rounded-[var(--r-md)] px-3 py-2 text-left text-[13px] font-light whitespace-nowrap transition-colors duration-[var(--t-fast)] ${
              selected
                ? "bg-accent/10 text-text"
                : "text-dim hover:bg-surface-2 hover:text-text"
            }`}
          >
            {tab.label}
            {tab.badge ? (
              <span
                aria-hidden="true"
                className="ml-2 inline-block h-1 w-1 -translate-y-px rounded-full bg-accent align-middle"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
