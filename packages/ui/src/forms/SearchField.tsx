import type { InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";
import { buttonClass } from "../actions/variants.ts";
import { cx } from "../cx.ts";

const tones = {
  hero: "rounded-field bg-surface p-2 pl-5 shadow-float ring-1 ring-border focus-within:ring-2 focus-within:ring-green/40",
  paper:
    "rounded-[18px] bg-paper p-2 pl-4 ring-1 ring-border focus-within:ring-2 focus-within:ring-green/40",
} as const;

export function SearchField({
  label,
  inputProps,
  submitLabel,
  submitShortLabel,
  tone = "hero",
  children,
}: {
  label: string;
  inputProps: InputHTMLAttributes<HTMLInputElement>;
  submitLabel: string;
  submitShortLabel?: string;
  tone?: "hero" | "paper";
  children?: ReactNode;
}) {
  const generated = useId();
  const id = inputProps.id ?? generated;
  return (
    <div>
      <div className={cx("flex items-center gap-2", tones[tone])}>
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-[22px] w-[22px] shrink-0 text-ink/70"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.6-3.6" />
        </svg>
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
        <input
          enterKeyHint="go"
          placeholder={label}
          {...inputProps}
          id={id}
          className={cx(
            "min-w-0 flex-1 bg-transparent py-2 text-[18px] text-ink outline-none placeholder:text-ink/45 md:text-[19px]",
            inputProps.className,
          )}
        />
        <button
          type="submit"
          className={buttonClass("primary", "xl", "shrink-0 rounded-[13px] px-4 md:px-6")}
        >
          {submitShortLabel ? (
            <>
              <span className="hidden sm:inline">{submitLabel}</span>
              <span className="sm:hidden">{submitShortLabel}</span>
            </>
          ) : (
            submitLabel
          )}
        </button>
      </div>
      {children}
    </div>
  );
}
