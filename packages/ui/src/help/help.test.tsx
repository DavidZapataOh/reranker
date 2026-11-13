import { renderToStaticMarkup as html } from "react-dom/server";
import { expect, test } from "vitest";
import { Term } from "./Term.tsx";

test("Term renders a button with the term and a screen-reader suffix, never hover-only", () => {
  const h = html(
    <Term term="preliminar" definition="Es preliminar porque…">
      preliminar
    </Term>,
  );
  expect(h).toMatch(/<button[^>]*data-term="preliminar"/);
  expect(h).toContain('type="button"');
  expect(h).toContain('aria-label="preliminar, qué significa"');
  expect(h).not.toContain("sr-only");
  expect(h).not.toContain(":hover");
});

test("a non-string child needs an explicit label", () => {
  const h = html(
    <Term term="preliminar" label="preliminar" definition="d">
      <em>preliminar</em>
    </Term>,
  );
  expect(h).toContain('aria-label="preliminar, qué significa"');
  html(
    // @ts-expect-error a non-string child has no text to build the name from
    <Term term="preliminar" definition="d">
      <em>preliminar</em>
    </Term>,
  );
});
