"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

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
        /* No `font-mono`. Mono is for code, data and measurement (craft-floor,
           and the persona is the one field here that is prose); it was set on
           this shared textarea, so the app's only multi-line prose input was
           dressed as a terminal. `text-[12px]` was here too and never applied:
           `.field` is unlayered and sets 16px, which beats any utility. */
        className="field resize-y leading-relaxed"
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
          /* Wired to the button the same way `Field` and `Slider` wire theirs.
             The sentence beside a switch is not decoration here: it is where
             "she stops listening while she is speaking" and "turning this off
             withdraws the read permission too" live, and a screen reader was
             reading the switch with none of it. */
          <p id={`${id}-hint`} className="mt-1 max-w-[46ch] text-[12px] leading-relaxed font-normal text-faint">
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
        aria-describedby={hint ? `${id}-hint` : undefined}
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
 *
 * `data-mark` because the tint is the point here. It is 11px at 500 like
 * `.label`, but `.label` is an unlayered class and would repaint every pill
 * `--text-faint`, taking `text-good` and `text-warn` with it. The gate names
 * the toned status pill as the case `data-mark` exists for, so this declares
 * the difference rather than looking like an oversight. It shares the
 * `className` line on purpose: rule 11 reads one line at a time, so an
 * attribute on the line above would not count and the pill would go back to
 * reading as a violation.
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
      className={`inline-flex items-center rounded-full border px-2 py-[2px] text-[11px] font-medium tracking-[0.12em] uppercase ${ring}`} data-mark="toned status pill"
    >
      {children}
    </span>
  );
}

/**
 * A row of small tab buttons, shared by the settings sections and My cave's
 * room strip.
 *
 * ONE IMPLEMENTATION, ON `.chip`
 *
 * The two callers had the same control drawn twice, and both drew it as a
 * bare text button with its own hover, its own radius and, below the tablet
 * breakpoint, no floor at all. It is `.chip` now: the hairline box, the
 * hover, the 44px phone floor and the selected state all come from the one
 * small control, and `.chip[aria-selected="true"]` is the only thing that
 * draws "this is the open one", so a chosen room and a chosen section cannot
 * drift apart. `orientation` is not a style prop, it is the keyboard
 * contract: a vertical list answers Up and Down, a horizontal strip answers
 * Left and Right.
 */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  ariaLabel,
  orientation = "vertical",
  panelId,
}: {
  tabs: readonly { id: T; label: string; badge?: boolean }[];
  active: T;
  onChange: (id: T) => void;
  ariaLabel: string;
  orientation?: "vertical" | "horizontal";
  /**
   * The element these tabs control, when there is one.
   *
   * `aria-controls` has to name it, and the tabs cannot know its id: the panel
   * is the caller's. The cave has no such element (its rooms are the whole
   * body), so it passes nothing rather than pointing at an id that does not
   * exist.
   */
  panelId?: string;
}) {
  /**
   * A unique prefix for this list's tab ids.
   *
   * Both this component and the panel it drives are rendered *twice* in
   * Settings, once for the desktop rail and once for the phone strip, and only
   * one of them is visible. With fixed ids the document held `tab-appearance`
   * twice, and anything pointing at it resolved to whichever came first, which
   * on a phone is the hidden rail. `useId()` makes each instance's ids its
   * own, which is the whole fix and needs nothing from the callers.
   */
  const instance = useId();
  /** One ref per tab, so an arrow key can move focus with the selection. */
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const vertical = orientation === "vertical";

  /**
   * Arrow keys, Home and End.
   *
   * `tabIndex` is roving, which is the tab pattern and is only honest if the
   * arrows move between the tabs. They were missing, so the four sections
   * that were not already open could not be reached without a pointer.
   * Selection follows focus because selecting a section is the whole action
   * of pressing one; there is no second step to defer it to.
   */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const forward = vertical ? "ArrowDown" : "ArrowRight";
    const back = vertical ? "ArrowUp" : "ArrowLeft";
    const index = tabs.findIndex((tab) => tab.id === active);
    let next: number;
    if (event.key === forward) next = index + 1 >= tabs.length ? 0 : index + 1;
    else if (event.key === back) next = index <= 0 ? tabs.length - 1 : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;

    const target = tabs[next];
    if (!target) return;
    event.preventDefault();
    onChange(target.id);
    buttons.current.get(target.id)?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation={orientation}
      onKeyDown={onKeyDown}
      className={vertical ? "flex flex-col gap-1" : "flex gap-1 overflow-x-auto"}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              if (node) buttons.current.set(tab.id, node);
              else buttons.current.delete(tab.id);
            }}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={panelId}
            id={`tab-${instance}-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            /* The rail reads as a list of rows, so its labels start at the
               left edge whatever width the nav has; the strip is a row of
               content-sized chips whose labels are centred by `.chip`. */
            className={`chip ${vertical ? "w-full" : "shrink-0"}`}
          >
            <span
              className={
                vertical ? "min-w-0 flex-1 truncate text-left" : "whitespace-nowrap"
              }
            >
              {tab.label}
            </span>
            {tab.badge ? (
              <span
                aria-hidden="true"
                className="inline-block h-1 w-1 shrink-0 rounded-full bg-accent"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
