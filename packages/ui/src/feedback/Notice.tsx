import type { ReactNode } from "react";
import { cx } from "../cx.ts";

// Amber is a ring and a dot, never text: ink carries the words on both tones.
export function Notice({ tone, children }: { tone: "neutral" | "attention"; children: ReactNode }) {
  const attention = tone === "attention";
  return (
    <div
      className={cx(
        "flex items-start gap-3 rounded-xl p-4 text-[16px] leading-relaxed text-ink",
        attention ? "bg-surface ring-2 ring-amber" : "bg-bubble",
      )}
    >
      {attention && (
        <span aria-hidden="true" className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-amber" />
      )}
      <div>{children}</div>
    </div>
  );
}
