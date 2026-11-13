"use client";

import type { ReactNode } from "react";
import { copy } from "../copy.ts";
import { Sheet } from "./Sheet.tsx";

// The accessible name is built explicitly because a visually hidden suffix is read inconsistently across screen readers.
export function Term({
  term,
  definition,
  children,
  label,
}: {
  term: string;
  definition: ReactNode;
} & ({ children: string; label?: string } | { children: ReactNode; label: string })) {
  const text = label ?? (children as string);
  return (
    <Sheet
      title={copy.sheet.termTitle(term)}
      trigger={
        <button
          type="button"
          data-term={term}
          aria-label={`${text}, ${copy.sheet.termHint}`}
          className="underline decoration-dotted decoration-ink/50 underline-offset-4"
        >
          {children}
        </button>
      }
    >
      {definition}
    </Sheet>
  );
}
