export type Span = { start: number; end: number; kind: "self" | "competitor" };

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Offsets are UTF-16 indices; an edge inside a character (surrogate pair, combining accent, ZWJ emoji, flag)
// would split it across a <mark> and render broken glyphs.
function boundaries(text: string): number[] {
  const edges = Array.from(graphemes.segment(text), ({ index }) => index);
  edges.push(text.length);
  return edges;
}

function firstAtOrAfter(edges: readonly number[], index: number): number {
  let low = 0;
  let high = edges.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((edges[mid] as number) < index) low = mid + 1;
    else high = mid;
  }
  return edges[low] as number;
}

function lastAtOrBefore(edges: readonly number[], index: number): number {
  let low = 0;
  let high = edges.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((edges[mid] as number) > index) high = mid - 1;
    else low = mid;
  }
  return edges[low] as number;
}

// Ranges come from model extraction and can be reversed, out of bounds, overlapping or fractional.
export function normalizeSpans(text: string, spans: readonly Span[]): Span[] {
  if (spans.length === 0) return [];
  const edges = boundaries(text);
  const snapped: Span[] = [];
  for (const { start, end, kind } of spans) {
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const from = firstAtOrAfter(edges, Math.min(Math.max(start, 0), text.length));
    const to = lastAtOrBefore(edges, Math.min(Math.max(end, 0), text.length));
    if (to > from) snapped.push({ start: from, end: to, kind });
  }
  snapped.sort((a, b) => a.start - b.start);
  const result: Span[] = [];
  let lastEnd = 0;
  for (const span of snapped) {
    if (span.start < lastEnd) continue;
    result.push(span);
    lastEnd = span.end;
  }
  return result;
}
