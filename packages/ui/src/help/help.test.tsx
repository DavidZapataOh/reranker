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
  expect(h).toContain(", qué significa</span>");
  expect(h).not.toContain(":hover");
});
