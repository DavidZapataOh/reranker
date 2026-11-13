import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { expectNoAxeViolations } from "../../test/axe.ts";
import { Button } from "./Button.tsx";
import { LinkButton } from "./LinkButton.tsx";
import type { ButtonSize, ButtonVariant } from "./variants.ts";

afterEach(cleanup);

const sizes: Array<[ButtonSize, number]> = [
  ["md", 44],
  ["lg", 48],
  ["xl", 56],
];
const pick = (root: HTMLElement, selector: string) => {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`${selector} not rendered`);
  return el;
};
const variants: ButtonVariant[] = ["primary", "secondary", "on-ink"];

test("every size meets its minimum height and lg is a 48 px target", async () => {
  for (const [size, px] of sizes) {
    const { container } = await render(<Button size={size}>Buscar</Button>);
    const rect = pick(container, "button").getBoundingClientRect();
    expect(rect.height).toBeGreaterThanOrEqual(px);
    if (size === "lg") expect(rect.width).toBeGreaterThanOrEqual(48);
    await cleanup();
  }
});

test("keyboard focus draws the 2 px green ring at 3 px", async () => {
  await render(<Button>Buscar</Button>);
  await userEvent.tab();
  const s = getComputedStyle(document.activeElement ?? document.body);
  expect([s.outlineStyle, s.outlineWidth, s.outlineOffset, s.outlineColor]).toEqual([
    "solid",
    "2px",
    "3px",
    "rgb(15, 92, 69)",
  ]);
});

test("primary paints the action green", async () => {
  const { container } = await render(<Button>Buscar</Button>);
  expect(getComputedStyle(pick(container, "button")).backgroundColor).toBe("rgb(15, 92, 69)");
});

test("a link button is as tall as a button of the same size", async () => {
  const { container } = await render(
    <>
      <Button size="xl">Buscar</Button>
      <LinkButton href="/x" size="xl">
        Buscar
      </LinkButton>
    </>,
  );
  const heights = [...container.querySelectorAll("button, a")].map(
    (el) => el.getBoundingClientRect().height,
  );
  expect(heights[1]).toBe(heights[0]);
});

test("has no axe violations for any variant, size and state", async () => {
  for (const variant of variants) {
    for (const [size] of sizes) {
      for (const disabled of [false, true]) {
        const { container } = await render(
          <div className={variant === "on-ink" ? "bg-ink p-4" : "p-4"}>
            <Button variant={variant} size={size} disabled={disabled}>
              Buscar
            </Button>
            <LinkButton href="/x" variant={variant} size={size}>
              Ver
            </LinkButton>
          </div>,
        );
        await expectNoAxeViolations(container);
        await cleanup();
      }
    }
  }
});
