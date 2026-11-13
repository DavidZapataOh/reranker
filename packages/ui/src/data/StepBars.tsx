import { cx } from "../cx.ts";
import { tokens } from "../tokens.ts";

export function StepBars({
  current,
  labels,
}: {
  current: 0 | 1 | 2 | 3;
  labels: readonly [string, string, string, string];
}) {
  return (
    // The stepped bars echo the logo's stepped r; the score itself is announced as text.
    <div className="mt-8 grid grid-cols-4 items-end gap-2" aria-hidden="true">
      {labels.map((label, i) => (
        <div key={label} className="flex flex-col gap-2">
          <span
            className="relative block rounded-lg transition-[background-color] duration-[250ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]"
            style={{
              height: 18 + i * 16,
              backgroundColor: i <= current ? tokens.color.green : tokens.color.greenLight,
              transitionDelay: `${(i - 1) * 150}ms`,
            }}
          >
            {i === current && (
              <span className="absolute -top-2 left-1/2 h-4 w-4 -translate-x-1/2 rounded-full bg-amber ring-4 ring-white" />
            )}
          </span>
          <span
            className={cx("text-[13px]", i === current ? "font-semibold text-ink" : "text-ink/65")}
          >
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}
