import type { EngineId } from "@reranker/i18n";
import type { CSSProperties, ReactNode } from "react";
import { copy } from "../copy.ts";
import { cx } from "../cx.ts";
import { EngineMark } from "./EngineMark.tsx";
import { Highlight } from "./Highlight.tsx";
import { normalizeSpans, type Span } from "./spans.ts";

function segments(text: string, highlights: readonly Span[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const { start, end, kind } of normalizeSpans(text, highlights)) {
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(
      <Highlight key={start} kind={kind}>
        {text.slice(start, end)}
      </Highlight>,
    );
    cursor = end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

// The expand toggle is a native checkbox so a server-rendered answer stays free of client JS.
export function Bubble({
  role,
  engine,
  text,
  highlights = [],
  collapsedLines,
}: {
  role: "question" | "answer";
  engine?: EngineId;
  text: string;
  highlights?: readonly Span[];
  collapsedLines?: number;
}) {
  const clamped =
    collapsedLines !== undefined && Number.isInteger(collapsedLines) && collapsedLines > 0;
  return (
    <div
      className={cx(
        "group/bubble px-4 py-3 text-[16px] leading-relaxed text-ink [overflow-wrap:anywhere]",
        role === "question"
          ? "ml-auto w-fit max-w-[85%] bg-bubble rounded-2xl rounded-tr-md"
          : "bg-surface ring-1 ring-border rounded-2xl rounded-tl-md",
      )}
    >
      {role === "answer" && engine && (
        <div className="mb-2">
          <EngineMark engine={engine} />
        </div>
      )}
      <p
        className={
          clamped ? "line-clamp-(--lines) group-has-checked/bubble:line-clamp-none" : undefined
        }
        style={clamped ? ({ "--lines": collapsedLines } as CSSProperties) : undefined}
      >
        {segments(text, highlights)}
      </p>
      {clamped && (
        <label className="inline-flex min-h-12 cursor-pointer items-center rounded-lg text-[15px] font-semibold text-action has-focus-visible:outline-2 has-focus-visible:outline-offset-3 has-focus-visible:outline-green">
          <input type="checkbox" className="peer sr-only" />
          <span className="peer-checked:hidden">{copy.bubble.expand}</span>
          <span className="hidden peer-checked:inline">{copy.bubble.collapse}</span>
        </label>
      )}
    </div>
  );
}
