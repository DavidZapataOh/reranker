export type Span = { start: number; end: number; kind: "self" | "competitor" };

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

// Offsets are UTF-16 indices; a boundary between the halves of a surrogate pair would render two broken glyphs.
function splitsPair(text: string, index: number): boolean {
  return (
    index > 0 &&
    index < text.length &&
    isHighSurrogate(text.charCodeAt(index - 1)) &&
    isLowSurrogate(text.charCodeAt(index))
  );
}

// Ranges come from model extraction and can be reversed, out of bounds, overlapping or fractional.
export function normalizeSpans(text: string, spans: readonly Span[]): Span[] {
  const clamped: Span[] = [];
  for (const { start, end, kind } of spans) {
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    let from = Math.min(Math.max(Math.ceil(start), 0), text.length);
    let to = Math.min(Math.max(Math.floor(end), 0), text.length);
    if (splitsPair(text, from)) from -= 1;
    if (splitsPair(text, to)) to += 1;
    if (to > from) clamped.push({ start: from, end: to, kind });
  }
  clamped.sort((a, b) => a.start - b.start);
  const result: Span[] = [];
  let lastEnd = 0;
  for (const span of clamped) {
    if (span.start < lastEnd) continue;
    result.push(span);
    lastEnd = span.end;
  }
  return result;
}
