import { copy } from "../copy.ts";

// Beyond ten dots the count reads faster as words than as a row to tally.
const MAX_DOTS = 10;
const STEP = 14;
const RADIUS = 5;

export function DotSample({
  filled,
  total,
  label,
}: {
  filled: number;
  total: number;
  label?: string;
}) {
  if (
    !Number.isInteger(filled) ||
    !Number.isInteger(total) ||
    total < 1 ||
    filled < 0 ||
    filled > total
  ) {
    throw new RangeError(`Invalid sample: ${filled} of ${total}`);
  }
  const dots = total <= MAX_DOTS;
  const count = `${filled} ${copy.sample.of} ${total}`;
  const text = [dots ? count : `${copy.sample.in} ${count}`, label].filter(Boolean).join(" ");
  return (
    <span className="inline-flex items-center gap-2">
      {dots && (
        <svg
          aria-hidden="true"
          viewBox={`0 0 ${total * STEP} ${STEP}`}
          width={total * STEP}
          height={STEP}
          className="shrink-0"
        >
          {Array.from({ length: total }, (_, i) => (
            <circle
              // biome-ignore lint/suspicious/noArrayIndexKey: dots are identical and never reorder
              key={i}
              data-filled={i < filled ? "true" : "false"}
              cx={i * STEP + STEP / 2}
              cy={STEP / 2}
              r={RADIUS}
              className={i < filled ? "fill-green" : "fill-none stroke-ink/55"}
              strokeWidth={1.5}
            />
          ))}
        </svg>
      )}
      <span className="font-mono text-[13px] text-ink/65">{text}</span>
    </span>
  );
}
