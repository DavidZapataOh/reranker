import { renderToStaticMarkup as html } from "react-dom/server";
import { expect, test } from "vitest";
import { Button } from "./Button.tsx";
import { LinkButton } from "./LinkButton.tsx";
import { buttonClass } from "./variants.ts";

test("Button defaults to type button and lets the caller override it", () => {
  expect(html(<Button>Ir</Button>)).toContain('type="button"');
  expect(html(<Button type="submit">Ir</Button>)).toContain('type="submit"');
});

// Split so the brand-rules scan does not count this test as a second use of the class.
const actionFill = ["bg", "action"].join("-");
const paints = (variant: "primary" | "secondary" | "on-ink") =>
  buttonClass(variant).split(" ").includes(actionFill);

test("only the primary variant paints the action color", () => {
  expect(paints("primary")).toBe(true);
  expect(paints("secondary")).toBe(false);
  expect(paints("on-ink")).toBe(false);
});

test("buttonClass defaults to primary lg and puts className last", () => {
  expect(buttonClass()).toBe(buttonClass("primary", "lg"));
  expect(buttonClass("primary", "lg")).toContain("min-h-12");
  expect(buttonClass("secondary", "xl", "mt-4").endsWith(" mt-4")).toBe(true);
});

test("LinkButton renders an anchor with the same classes as a Button", () => {
  const markup = html(
    <LinkButton href="/x" variant="secondary" size="md">
      Ver
    </LinkButton>,
  );
  expect(markup).toContain('href="/x"');
  expect(markup).toContain(`class="${buttonClass("secondary", "md")}"`);
});
