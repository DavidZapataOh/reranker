import fc from "fast-check";
import { renderToStaticMarkup as html } from "react-dom/server";
import { expect, test } from "vitest";
import { Bubble } from "./Bubble.tsx";
import { EngineMark } from "./EngineMark.tsx";
import { Highlight } from "./Highlight.tsx";
import { normalizeSpans, type Span } from "./spans.ts";

const textOf = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&");

const answerOf = (markup: string) => {
  const m = markup.match(/<p[^>]*>([\s\S]*?)<\/p>/);
  if (m?.[1] === undefined) throw new Error("answer text not rendered");
  return textOf(m[1]);
};

test("spans are clamped, emptied ones dropped, sorted, and the first of an overlap wins", () => {
  expect(
    normalizeSpans("abcdef", [
      { start: 4, end: 9, kind: "self" },
      { start: 1, end: 3, kind: "competitor" },
      { start: 2, end: 5, kind: "self" },
      { start: 3, end: 3, kind: "self" },
    ]),
  ).toEqual([
    { start: 1, end: 3, kind: "competitor" },
    { start: 4, end: 6, kind: "self" },
  ]);
});

test("reversed, negative and non-integer ranges never produce a highlight", () => {
  expect(
    normalizeSpans("abcdef", [
      { start: 5, end: 2, kind: "self" },
      { start: -4, end: -1, kind: "self" },
      { start: Number.NaN, end: 3, kind: "self" },
      { start: 7, end: 9, kind: "self" },
      { start: 0, end: Number.POSITIVE_INFINITY, kind: "competitor" },
    ]),
  ).toEqual([{ start: 0, end: 6, kind: "competitor" }]);
});

test("a range never splits an emoji in half", () => {
  // "👍" is two UTF-16 code units at 2..4.
  expect(normalizeSpans("ok👍 sí", [{ start: 3, end: 5, kind: "self" }])).toEqual([
    { start: 2, end: 5, kind: "self" },
  ]);
});

const spanArb = fc.record({
  start: fc.oneof(fc.integer({ min: -20, max: 80 }), fc.double()),
  end: fc.oneof(fc.integer({ min: -20, max: 80 }), fc.double()),
  kind: fc.constantFrom<Span["kind"]>("self", "competitor"),
});

test("any extraction output normalizes to ordered, disjoint, non-empty ranges inside the text", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 60, unit: "binary" }),
      fc.array(spanArb, { maxLength: 12 }),
      (text, spans) => {
        const out = normalizeSpans(text, spans);
        let previousEnd = 0;
        for (const s of out) {
          expect(Number.isInteger(s.start) && Number.isInteger(s.end)).toBe(true);
          expect(s.start).toBeGreaterThanOrEqual(previousEnd);
          expect(s.end).toBeGreaterThan(s.start);
          expect(s.end).toBeLessThanOrEqual(text.length);
          previousEnd = s.end;
        }
      },
    ),
  );
});

test("any extraction output keeps the whole answer text, in order", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 60, unit: "grapheme" }),
      fc.array(spanArb, { maxLength: 12 }),
      (text, spans) => {
        const markup = html(
          <Bubble role="answer" engine="gemini" text={text} highlights={spans} />,
        );
        expect(answerOf(markup)).toBe(text);
      },
    ),
  );
});

test("the answer is rendered as text, never as HTML, and the business is highlighted", () => {
  const text = "<img src=x onerror=alert(1)> Motor Valle";
  const b = html(
    <Bubble
      role="answer"
      engine="chatgpt"
      text={text}
      highlights={[{ start: 29, end: 40, kind: "self" }]}
    />,
  );
  expect(b).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(b).not.toContain("<img src=x");
  expect(b).toMatch(/<mark[^>]*marker[^>]*>Motor Valle<\/mark>/);
  expect(textOf(b)).toContain(text);
  expect(b).toContain("ChatGPT");
});

test("malformed highlights still show the full answer and only the valid ranges", () => {
  const text = "Recomiendo Motor Valle y Taller Sur en Medellín.";
  const b = html(
    <Bubble
      role="answer"
      engine="perplexity"
      text={text}
      highlights={[
        { start: 25, end: 35, kind: "competitor" },
        { start: 11, end: 22, kind: "self" },
        { start: 15, end: 30, kind: "competitor" },
        { start: 40, end: 400, kind: "self" },
        { start: 8, end: 8, kind: "self" },
        { start: 30, end: 20, kind: "self" },
      ]}
    />,
  );
  expect(answerOf(b)).toBe(text);
  expect([...b.matchAll(/<mark[^>]*>([^<]*)<\/mark>/g)].map((m) => m[1])).toEqual([
    "Motor Valle",
    "Taller Sur",
    "edellín.",
  ]);
});

test("Highlight marks the business with the amber marker and competitors in bold only", () => {
  expect(html(<Highlight kind="self">Motor Valle</Highlight>)).toBe(
    '<mark class="marker font-semibold text-ink">Motor Valle</mark>',
  );
  expect(html(<Highlight kind="competitor">Taller Sur</Highlight>)).toBe(
    '<mark class="bg-transparent font-semibold text-ink">Taller Sur</mark>',
  );
});

test("EngineMark shows the engine icon decoratively next to its visible name", () => {
  const google = html(<EngineMark engine="google-ai-overview" />);
  expect(google).toContain('src="/engines/google.svg"');
  expect(google).toContain('alt=""');
  expect(google).toContain('width="16"');
  expect(textOf(google)).toBe("Google (respuestas de IA)");
  expect(html(<EngineMark engine="chatgpt" size={20} />)).toMatch(
    /src="\/engines\/openai.svg"[^>]*width="20"[^>]*height="20"/,
  );
  expect(html(<EngineMark engine="gemini" />)).toContain("/engines/gemini.svg");
  expect(html(<EngineMark engine="perplexity" />)).toContain("/engines/perplexity.svg");
});

test("the question sits on the right in the grey bubble, the answer on white with the engine", () => {
  const q = html(<Bubble role="question" text="¿Dónde arreglo el carro?" />);
  expect(q).toMatch(/class="[^"]*ml-auto[^"]*bg-bubble[^"]*rounded-2xl[^"]*rounded-tr-md/);
  expect(q).not.toContain("<img");
  const a = html(<Bubble role="answer" engine="chatgpt" text="Respuesta" />);
  expect(a).toMatch(/class="[^"]*bg-surface[^"]*ring-1[^"]*ring-border[^"]*rounded-tl-md/);
  expect(a).toContain("[overflow-wrap:anywhere]");
  expect(a.indexOf("/engines/openai.svg")).toBeLessThan(a.indexOf("Respuesta</p>"));
});

test("a collapsed answer clamps its lines and expands with a native checkbox, without JS", () => {
  const a = html(<Bubble role="answer" engine="chatgpt" text="Larga" collapsedLines={4} />);
  expect(a).toContain("--lines:4");
  expect(a).toMatch(/<p[^>]*line-clamp-\(--lines\)[^>]*group-has-checked\/bubble:line-clamp-none/);
  expect(a).toMatch(/<label[^>]*><input type="checkbox" class="peer sr-only"\/>/);
  expect(textOf(a)).toContain("Ver respuesta completa");
  expect(html(<Bubble role="answer" engine="chatgpt" text="Corta" />)).not.toContain("checkbox");
  for (const collapsedLines of [0, -2, 2.5, Number.NaN]) {
    const open = html(
      <Bubble role="answer" engine="chatgpt" text="Corta" collapsedLines={collapsedLines} />,
    );
    expect(open).not.toContain("line-clamp");
    expect(open).not.toContain("checkbox");
  }
});
