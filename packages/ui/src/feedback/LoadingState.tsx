import type { ReactNode } from "react";

// Only the title is announced; the skeleton children are aria-hidden, so a re-render never repeats speech.
export function LoadingState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-4">
      <p className="text-[16px] font-semibold text-ink-soft">{title}</p>
      {children}
    </div>
  );
}
