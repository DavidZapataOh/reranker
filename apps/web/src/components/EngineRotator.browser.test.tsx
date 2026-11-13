import { afterEach, expect, test } from "vitest";
import { commands } from "vitest/browser";
import { render } from "vitest-browser-react";
import { EngineRotator } from "./EngineRotator";

const track = (root: HTMLElement) => {
  const el = root.querySelector<HTMLElement>("span[aria-hidden] > span > span");
  if (!el) throw new Error("engine track not rendered");
  return el;
};

// The pointer rests at the viewport origin; keep the rotator away so hover does not pause it.
const Away = () => (
  <div style={{ padding: 120 }}>
    <EngineRotator />
  </div>
);

afterEach(() => commands.emulateReducedMotion("no-preference"));

test("stays on the first engine with prefers-reduced-motion", async () => {
  await commands.emulateReducedMotion("reduce");
  const { container } = await render(<Away />);
  await new Promise((r) => setTimeout(r, 3_000)); // longer than HOLD + ROLL
  expect(track(container).style.transform).toBe("translateY(0em)");
});

test("rolls to the next engine without reduced motion", async () => {
  const { container } = await render(<Away />);
  await expect
    .poll(() => track(container).style.transform, { timeout: 4_000 })
    .toBe("translateY(-1em)");
});

test("re-measures the name when its size changes without a window resize", async () => {
  const { container } = await render(<Away />);
  const slot = container.querySelectorAll<HTMLElement>("span[aria-hidden] > span")[1];
  const name = slot?.firstElementChild?.firstElementChild as HTMLElement | undefined;
  if (!slot || !name) throw new Error("engine name not rendered");
  const before = name.offsetWidth;
  // Stands in for the web font arriving after the first measurement. The component test runs
  // without the stylesheet, so the name is made a box that can be observed.
  name.style.display = "inline-block";
  name.style.letterSpacing = "10px";
  const after = name.offsetWidth;
  expect(after).toBeGreaterThan(before);
  await expect.poll(() => slot.style.width, { timeout: 2_000 }).toBe(`${after}px`);
});
