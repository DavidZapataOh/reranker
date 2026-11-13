import type { ReactNode } from "react";
import { useId } from "react";
import { FieldError } from "./FieldError.tsx";

export function Checkbox({
  name,
  required,
  children,
  error,
}: {
  name: string;
  required?: boolean;
  children: ReactNode;
  error?: string;
}) {
  const errorId = useId();
  return (
    <div>
      <label className="flex min-h-12 cursor-pointer items-center gap-3 py-2 text-[16px]">
        <span className="relative inline-grid size-6 shrink-0 place-items-center">
          <input
            type="checkbox"
            name={name}
            required={required}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="peer size-6 cursor-pointer appearance-none rounded-lg bg-surface ring-1 ring-ink/30 checked:bg-green checked:ring-green"
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
