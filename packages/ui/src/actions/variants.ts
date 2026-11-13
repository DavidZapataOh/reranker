import { cx } from "../cx.ts";

export type ButtonVariant = "primary" | "secondary" | "on-ink";
export type ButtonSize = "md" | "lg" | "xl";

const base =
  "inline-flex items-center justify-center gap-2 font-semibold transition-[background-color,transform,box-shadow] duration-150 ease-out-brand hover:-translate-y-px active:translate-y-0 disabled:pointer-events-none disabled:opacity-60";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-action text-white hover:bg-action-hover",
  secondary: "bg-surface text-ink ring-1 ring-ink/15 hover:ring-ink/30",
  "on-ink": "bg-paper text-ink hover:bg-action-soft",
};

// Minimum heights, not fixed ones, so text at 200% zoom is never clipped.
const sizes: Record<ButtonSize, string> = {
  md: "min-h-11 rounded-xl px-5 text-[15px]",
  lg: "min-h-12 rounded-xl px-6 text-[16px]",
  xl: "min-h-14 rounded-2xl px-8 text-[17px]",
};

export function buttonClass(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "lg",
  className?: string,
): string {
  return cx(base, variants[variant], sizes[size], className);
}
