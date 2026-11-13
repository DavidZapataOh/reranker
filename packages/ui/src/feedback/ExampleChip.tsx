import { copy } from "../copy.ts";
import { cx } from "../cx.ts";

export function ExampleChip({ className }: { className?: string } = {}) {
  return (
    <span
      className={cx(
        "inline-flex min-h-6 items-center rounded-full bg-green-light px-2.5 text-[12px] font-semibold text-green",
        className,
      )}
    >
      {copy.example}
    </span>
  );
}
