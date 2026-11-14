import type { ReactNode } from "react";
import { Icon } from "../icons.tsx";

// The alert wraps only the message so the action is not re-read; the palette has no red, so an icon carries the state.
export function ErrorState({
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
      <div role="alert" className="flex items-start gap-3">
        <Icon
          d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 8v5M12 16h.01"
          className="mt-0.5 h-6 w-6 shrink-0 text-ink"
        />
        <div className="flex flex-col gap-1.5">
          <p className="text-[20px] leading-snug font-bold text-ink">{title}</p>
          <p className="text-[16px] leading-relaxed text-ink-soft">{body}</p>
        </div>
      </div>
      {action}
    </div>
  );
}
