import type { InputHTMLAttributes } from "react";
import { useId } from "react";
import { cx } from "../cx.ts";
import { FieldError } from "./FieldError.tsx";

export function TextField({
  label,
  hint,
  error,
  id,
  className,
  type,
  "aria-describedby": callerDescribedBy,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string }) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = [callerDescribedBy, hint ? hintId : null, error ? errorId : null]
    .filter(Boolean)
    .join(" ");
  const email =
    type === "email"
      ? { inputMode: "email", autoComplete: "email", autoCapitalize: "none", spellCheck: false }
      : {};
  return (
    <div>
      <label htmlFor={inputId} className="block text-[15px] font-semibold">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="mt-1 text-[15px] text-ink-soft">
          {hint}
        </p>
      ) : null}
      <input
        id={inputId}
        type={type}
        {...(email as InputHTMLAttributes<HTMLInputElement>)}
        {...rest}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={cx(
          "mt-2 min-h-12 w-full rounded-xl bg-surface px-4 text-[16px] text-ink ring-1 ring-ink/55 placeholder:text-ink/45 disabled:opacity-60",
          error && "ring-2 ring-ink",
          className,
        )}
      />
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}
