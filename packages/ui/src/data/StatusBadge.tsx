import type { EngineStatus } from "@reranker/schema/measurement";
import type { ReactNode } from "react";
import { cx } from "../cx.ts";

// The shape repeats the word so color is never the only signal.
const shapes: Record<EngineStatus, ReactNode> = {
  regular: (
    <circle cx="8" cy="8" r="6.5" className="fill-current stroke-current" strokeWidth="1.5" />
  ),
  on_the_list: (
    <>
      <circle cx="8" cy="8" r="6.5" className="fill-none stroke-current" strokeWidth="1.5" />
      <path d="M8 1.5A6.5 6.5 0 1 1 1.5 8H8Z" className="fill-current" />
    </>
  ),
  // The amber half is an HTML highlighter under this outline: amber is never an SVG fill.
  sometimes: (
    <>
      <circle cx="8" cy="8" r="6.5" className="fill-none stroke-ink" strokeWidth="1.5" />
      <path d="M8 1.5V14.5" className="stroke-ink" strokeWidth="1.5" />
    </>
  ),
  invisible: (
    <circle cx="8" cy="8" r="6.5" className="fill-none stroke-current" strokeWidth="1.5" />
  ),
  few_data: (
    <circle
      cx="8"
      cy="8"
      r="6.5"
      className="fill-none stroke-current"
      strokeWidth="1.5"
      strokeDasharray="2.5 2"
    />
  ),
};

const colors: Record<EngineStatus, string> = {
  regular: "text-green",
  on_the_list: "text-green",
  sometimes: "text-ink",
  invisible: "text-ink/65",
  few_data: "text-ink/65",
};

export function StatusBadge({
  status,
  words,
}: {
  status: EngineStatus;
  words: Record<EngineStatus, string>;
}) {
  const word = words[status];
  if (!word?.trim()) throw new Error(`StatusBadge needs a word for "${status}"`);
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 text-[14px] leading-tight font-semibold",
        colors[status],
      )}
    >
      <span className="relative inline-flex shrink-0">
        {status === "sometimes" && (
          <span
            className="absolute top-[1.5px] left-1/2 h-[13px] w-[6.5px] rounded-r-full bg-amber"
            aria-hidden="true"
          />
        )}
        <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" className="relative">
          {shapes[status]}
        </svg>
      </span>
      {word}
    </span>
  );
}
