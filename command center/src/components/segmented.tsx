import type { ReactNode } from "react";

/** One choice in a `Segmented` control. `tone` colours it while checked (default teal). */
export interface SegmentOption<T extends string | number> {
  id: T;
  label: ReactNode;
  tone?: "teal" | "amber" | "alert" | "volt";
  /** Native tooltip; also read as the radio's description. */
  hint?: string;
}

const TONE: Record<NonNullable<SegmentOption<string>["tone"]>, string> = {
  teal: "bg-teal/25 text-teal",
  amber: "bg-amber/25 text-amber-light",
  alert: "bg-alert/25 text-alert",
  volt: "bg-volt/20 text-volt",
};

/**
 * A dependency-free segmented radio control (the TierSelect / NarrationControl markup:
 * `well rounded-full p-0.5`, role=radiogroup with role=radio buttons). No glass or backdrop
 * classes, so it is safe over the System Map's WebGL canvas.
 */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  size = "md",
  disabled = false,
  className = "",
}: {
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (v: T) => void;
  /** The radiogroup's accessible name. */
  label: string;
  size?: "sm" | "md";
  disabled?: boolean;
  className?: string;
}) {
  const h = size === "sm" ? "h-6 px-2 text-[10px]" : "h-7 px-3 text-[11px]";
  return (
    <div role="radiogroup" aria-label={label} aria-disabled={disabled || undefined} className={`well flex w-fit rounded-full p-0.5 ${className}`}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={String(o.id)}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.hint}
            disabled={disabled}
            onClick={() => !on && onChange(o.id)}
            className={`${h} rounded-full font-mono uppercase tracking-wider transition-colors disabled:opacity-50 ${on ? TONE[o.tone ?? "teal"] : "text-ink-3 hover:text-ink"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
