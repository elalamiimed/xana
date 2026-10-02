"use client";

/**
 * The one small button shape in the interface: quiet, verb-first and
 * lowercase (DESIGN.md §7). Shared by the ambient region and any card that
 * offers a one-tap write-back, so the two never drift.
 *
 * Radius is `--r-md` rather than a full pill. A pill is right for a
 * control with real height and for the composer, which is a large target;
 * on an 11px-text button it reads as an over-rounded chip. Badges and
 * switches keep their pill shape, because there the pill *is* the
 * convention rather than a styling choice.
 */

export interface GhostButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export default function GhostButton({
  label,
  onClick,
  disabled = false,
}: GhostButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-[var(--r-md)] border border-hairline px-3 py-1 text-[12px] font-normal tracking-[0.02em] text-dim transition-colors duration-[var(--t-fast)] hover:border-accent/40 hover:text-accent disabled:opacity-40"
    >
      {label}
    </button>
  );
}
