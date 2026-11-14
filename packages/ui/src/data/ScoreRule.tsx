import type { LevelKey, ScoreEstimate } from "@reranker/schema/measurement";
import { cx } from "../cx.ts";
import { activeLevels, LEVEL_BANDS, levelCaption, rangeGeometry, scoreSentence } from "./scale.ts";

// On a phone the four names only fit spread in order; from sm up each one sits under its band,
// the first two meeting at the 40 cut because the 0–10 band is too narrow to hold a name.
const namePosition: Record<LevelKey, string> = {
  invisible: "sm:left-0",
  sometimes: "sm:right-[calc(60%+6px)]",
  on_the_list: "sm:left-[calc(40%+6px)]",
  regular: "sm:right-0",
};

export function ScoreRule({
  score,
  levelLabels,
}: {
  score: ScoreEstimate;
  levelLabels: Record<LevelKey, string>;
}) {
  const sentence = scoreSentence(score, levelLabels);
  const active = new Set(activeLevels(score.levelDisplay));
  const range = rangeGeometry(score.lower, score.upper);
  return (
    <figure aria-label={sentence} className="w-full">
      <svg
        viewBox="0 0 100 24"
        preserveAspectRatio="none"
        aria-hidden="true"
        className="block h-6 w-full overflow-visible"
      >
        {LEVEL_BANDS.map(({ level, x, width }) => (
          <rect
            key={level}
            data-level={level}
            data-active={active.has(level) ? "true" : undefined}
            x={x}
            y={9}
            width={width}
            height={6}
            className={cx("stroke-surface", active.has(level) ? "fill-green-light" : "fill-ink/10")}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <rect
          data-part="range"
          x={range.x}
          y={3}
          width={range.width}
          height={18}
          className="fill-green/20 stroke-green"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div
        className="mt-2 flex flex-wrap justify-between gap-x-3 sm:relative sm:block sm:h-5"
        aria-hidden="true"
      >
        {LEVEL_BANDS.map(({ level }) => (
          <span
            key={level}
            data-level-name={level}
            className={cx(
              "text-[13px] whitespace-nowrap sm:absolute sm:top-0",
              namePosition[level],
              active.has(level) ? "font-semibold text-ink" : "text-ink/65",
            )}
          >
            {levelLabels[level]}
          </span>
        ))}
      </div>
      <figcaption className="mt-3 text-[15px] font-semibold text-ink">
        {levelCaption(score.levelDisplay, levelLabels)}
      </figcaption>
    </figure>
  );
}
