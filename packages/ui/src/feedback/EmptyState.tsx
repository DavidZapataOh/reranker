import type { ReactNode } from "react";

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-4 rounded-2xl bg-bubble p-6">
      <div className="flex flex-col gap-1.5">
        <p className="text-[20px] leading-snug font-bold text-ink">{title}</p>
        <p className="text-[16px] leading-relaxed text-ink-soft">{body}</p>
      </div>
      {action}
    </div>
  );
}
