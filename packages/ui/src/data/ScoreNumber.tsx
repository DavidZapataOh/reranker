import type { ScoreEstimate } from "@reranker/schema/measurement";
import { copy } from "../copy.ts";
import { assertScore, rangePhrase } from "./scale.ts";

export function ScoreNumber({ score }: { score: ScoreEstimate }) {
  assertScore(score);
  return (
    <p className="flex items-end gap-4">
      <span className="font-display text-[clamp(4.5rem,8vw,6rem)] leading-[0.85] font-black tracking-[-0.03em] text-ink tabular-nums">
        <span className="sr-only">{`${copy.score.score} `}</span>
        {score.value}
      </span>
      <span className="flex flex-col pb-2">
        <span className="font-mono text-[13px] leading-snug text-ink/65">{rangePhrase(score)}</span>
        {score.preliminary && (
          <span className="font-mono text-[13px] leading-snug text-ink/65">
            {copy.score.preliminary}
          </span>
        )}
      </span>
    </p>
  );
}
