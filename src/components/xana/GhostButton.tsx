"use client";

/**
 * The one small button shape in the interface: quiet, verb-first and
 * lowercase (DESIGN.md §7). Shared by the ambient region and any card that
 * offers a one-tap write-back, so the two never drift.
 *
 * It is `.chip` now, with the accent hover, rather than a fourth recipe for
 * the same control. The rooms had grown their own versions of this button
 * with four different radii and three different paddings; a small control is
 * one control, and the only thing that made this one different is that its
 * action is the point of the card it sits on. That is what `chip-accent`
 * says.
 *
 * No pill. A pill is right for a control with real height and for the
 * composer, which is a large target; on a 12px-text chip it reads as
 * over-rounded. Badges and switches keep their pill shape, because there the
 * pill *is* the convention rather than a styling choice.
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
    <button type="button" onClick={onClick} disabled={disabled} className="chip chip-accent">
      {label}
    </button>
  );
}
