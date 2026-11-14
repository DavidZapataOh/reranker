import { cx } from "../cx.ts";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx("animate-pulse rounded-xl bg-bubble", className)} />;
}
