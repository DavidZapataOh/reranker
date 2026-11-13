"use client";

import type { ChangeEvent, ClipboardEvent } from "react";
import { useId, useRef, useState } from "react";
import { cx } from "../cx.ts";
import { FieldError } from "./FieldError.tsx";

const LENGTH = 6;

export function sanitizeCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, LENGTH);
}

export function CodeField({
  name,
  label,
  error,
  onComplete,
  disabled,
}: {
  name: string;
  label: string;
  error?: string;
  onComplete?: (code: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const [code, setCode] = useState("");
  const delivered = useRef<string | null>(null);

  function update(input: HTMLInputElement, raw: string) {
    const next = sanitizeCode(raw);
    // The DOM value is written first so a form submitted below already carries the clean code.
    input.value = next;
    setCode(next);
    if (next.length < LENGTH) {
      delivered.current = null;
      return;
    }
    if (delivered.current === next) return;
    delivered.current = next;
    if (onComplete) onComplete(next);
    else input.form?.requestSubmit();
  }

  // maxLength would truncate a pasted sentence before it can be cleaned, so paste is handled here.
  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const input = e.currentTarget;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const pasted = e.clipboardData.getData("text");
    update(input, input.value.slice(0, start) + pasted + input.value.slice(end));
  }

  return (
    <div>
      <label htmlFor={id} className="block text-[15px] font-semibold">
        {label}
      </label>
      <div className={cx("relative mt-2 w-fit", disabled && "opacity-60")}>
        <div aria-hidden="true" className="flex gap-2">
          {Array.from({ length: LENGTH }, (_, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: the cells are positional and never reorder
              key={i}
              className={cx(
                "grid h-14 w-12 place-items-center rounded-xl bg-surface font-mono text-[24px] font-semibold text-ink ring-1 ring-ink/30",
                error && "ring-2 ring-ink",
              )}
            >
              {code[i]}
            </span>
          ))}
        </div>
        <input
          id={id}
          name={name}
          value={code}
          disabled={disabled}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={LENGTH}
          enterKeyHint="go"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            update(e.currentTarget, e.currentTarget.value)
          }
          onPaste={onPaste}
          className="absolute inset-0 size-full bg-transparent text-[16px] text-transparent caret-transparent selection:bg-transparent"
        />
      </div>
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}
