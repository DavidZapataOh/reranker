import type { ReactNode } from "react";
import { cx } from "../cx.ts";

export function Lede({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p
      className={cx(
        "mt-4 max-w-[56ch] text-[clamp(1.05rem,1.2vw,1.15rem)] leading-relaxed text-ink/75",
        className,
      )}
    >
      {children}
    </p>
  );
}
