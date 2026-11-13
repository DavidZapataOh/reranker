import type { ReactNode } from "react";
import { cx } from "../cx.ts";

export function Headline({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <h2
      id={id}
      className={cx(
        "font-display text-[clamp(2rem,3.4vw,3.05rem)] leading-[1.08] font-black tracking-[-0.02em] text-balance text-ink",
        className,
      )}
    >
      {children}
    </h2>
  );
}
