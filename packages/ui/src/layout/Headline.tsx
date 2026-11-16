import type { ReactNode } from "react";
import { cx } from "../cx.ts";

export function Headline({
  as: Tag = "h2",
  id,
  className,
  children,
}: {
  as?: "h1" | "h2";
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tag
      id={id}
      className={cx(
        "font-display text-[clamp(2rem,3.4vw,3.05rem)] leading-[1.08] font-black tracking-[-0.02em] text-balance text-ink",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
