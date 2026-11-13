import type { ReactNode } from "react";
import { cx } from "../cx.ts";

export function Section({
  id,
  labelledBy,
  className,
  children,
}: {
  id?: string;
  labelledBy?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={cx("scroll-mt-20", className)}>
      <div className="mx-auto max-w-[1280px] px-5 md:px-10">{children}</div>
    </section>
  );
}
