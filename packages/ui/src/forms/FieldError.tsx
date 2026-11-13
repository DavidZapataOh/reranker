import type { ReactNode } from "react";
import { Icon } from "../icons.tsx";

// The palette has no red, so the error is carried by an icon and ink text, never by color alone.
export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p
      id={id}
      role="alert"
      className="mt-2 flex items-start gap-2 text-[15px] font-semibold text-ink"
    >
      <Icon
        d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 8v5M12 16h.01"
        className="mt-0.5 h-5 w-5 shrink-0"
      />
      <span>{children}</span>
    </p>
  );
}
