import type { InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";
import { cx } from "../cx.ts";
import { FieldError } from "./FieldError.tsx";

export function Checkbox({
  name,
  children,
  error,
  className,
  "aria-describedby": callerDescribedBy,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "children"> & {
  name: string;
  children: ReactNode;
  error?: string;
}) {
  const errorId = useId();
  const describedBy = [callerDescribedBy, error ? errorId : null].filter(Boolean).join(" ");
  return (
    <div>
      <label className="flex min-h-12 cursor-pointer items-center gap-3 py-2 text-[16px]">
        <span className="relative inline-grid size-6 shrink-0 place-items-center">
          <input
            {...rest}
            type="checkbox"
            name={name}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy || undefined}
            className={cx(
              "peer size-6 cursor-pointer appearance-none rounded-lg bg-surface ring-1 ring-ink/55 checked:bg-green checked:ring-green",
              className,
            )}
          />
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="pointer-events-none absolute size-4 text-white opacity-0 peer-checked:opacity-100"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </span>
        <span>{children}</span>
      </label>
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}
