"use client";

import type { ReactNode } from "react";
import { copy } from "../copy.ts";
import { Sheet } from "./Sheet.tsx";

export function Term({
  term,
  definition,
  children,
}: {
  term: string;
  definition: ReactNode;
  children: ReactNode;
}) {
  return (
    <Sheet
      title={copy.sheet.termTitle(term)}
      trigger={
        <button
          type="button"
          data-term={term}
          className="underline decoration-dotted decoration-ink/50 underline-offset-4"
        >
          {children}
          <span className="sr-only">{copy.sheet.termHint}</span>
        </button>
      }
    >
      {definition}
    </Sheet>
  );
}
