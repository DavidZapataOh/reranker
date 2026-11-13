import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { expectNoAxeViolations } from "../../test/axe.ts";
import { EvidenceSeal } from "../evidence/EvidenceSeal.tsx";
import { Bubble } from "./Bubble.tsx";

afterEach(cleanup);

const longName = "TallerDeMotosYRepuestosOriginalesHermanosRestrepoDelValleDeAburraSedeCentro20266";
const answer = `Para tu moto te recomiendo ${longName}, aunque Taller Sur también tiene buenas reseñas. `;

const conversation = (
  <div className="flex flex-col gap-3">
    <Bubble role="question" text="¿Dónde arreglo mi moto en Medellín?" />
    <Bubble
      role="answer"
      engine="chatgpt"
      text={answer}
      highlights={[
        { start: 27, end: 27 + longName.length, kind: "self" },
        { start: 27 + longName.length + 9, end: 27 + longName.length + 19, kind: "competitor" },
      ]}
    />
    <Bubble role="answer" engine="gemini" text={answer.repeat(6)} collapsedLines={3} />
    <EvidenceSeal
      capturedAtLabel="3 nov 2026, 9:14 a. m."
      cityLabel="Medellín"
      verifyUrl="/verificar/8F2K"
    />
  </div>
);

test("an 80-character name inside a highlight never widens a 320 px page", async () => {
  expect(longName).toHaveLength(80);
  await page.viewport(320, 640);
  await render(conversation);
  const self = document.querySelector("mark.marker");
  expect(self?.textContent).toBe(longName);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
});

test("a clamped answer expands with its label, and the whole conversation passes axe", async () => {
  await page.viewport(390, 800);
  const { container } = await render(conversation);
  const clamped = container.querySelectorAll("p")[2] as HTMLParagraphElement;
  const collapsedHeight = clamped.getBoundingClientRect().height;
  expect(clamped.scrollHeight).toBeGreaterThan(clamped.clientHeight);
  await expectNoAxeViolations(document.body);

  const toggle = page.getByRole("checkbox", { name: "Ver respuesta completa" });
  await expect.element(toggle).toBeInTheDocument();
  const label = container.querySelector("label") as HTMLLabelElement;
  expect(label.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
  await userEvent.click(page.elementLocator(label));
  await expect.element(page.getByRole("checkbox", { name: "Ver menos" })).toBeChecked();
  expect(clamped.getBoundingClientRect().height).toBeGreaterThan(collapsedHeight);
  expect(clamped.scrollHeight).toBeLessThanOrEqual(clamped.clientHeight);
  await expectNoAxeViolations(document.body);
});

test("keyboard focus on the hidden checkbox draws the green ring on its label", async () => {
  await render(<Bubble role="answer" engine="chatgpt" text={answer} collapsedLines={2} />);
  await userEvent.tab();
  const label = document.querySelector("label") as HTMLLabelElement;
  const s = getComputedStyle(label);
  expect([s.outlineStyle, s.outlineWidth, s.outlineOffset, s.outlineColor]).toEqual([
    "solid",
    "2px",
    "3px",
    "rgb(15, 92, 69)",
  ]);
});

test("the seal is ink, its help is a 48 px target and opens the check link", async () => {
  await page.viewport(320, 640);
  await render(conversation);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
  const help = page.getByRole("button", { name: "Qué significa respuesta guardada" });
  const box = help.element().getBoundingClientRect();
  expect(box.width).toBeGreaterThanOrEqual(48);
  expect(box.height).toBeGreaterThanOrEqual(48);
  const mark = document.querySelector("[data-seal] svg") as SVGElement;
  expect(getComputedStyle(mark).color).toBe("rgb(20, 33, 27)");

  await userEvent.click(help);
  const dialog = page.getByRole("dialog", { name: "¿Qué significa?" });
  await expect.element(dialog).toBeVisible();
  expect(dialog.element().textContent).toContain("tal como la dio la IA");
  const check = page.getByRole("link", { name: "Comprobar esta respuesta" });
  await expect.element(check).toHaveAttribute("href", "/verificar/8F2K");
  await expectNoAxeViolations(document.body);
});
