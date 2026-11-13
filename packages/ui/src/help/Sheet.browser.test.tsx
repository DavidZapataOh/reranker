import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { expectNoAxeViolations } from "../../test/axe.ts";
import { Sheet } from "./Sheet.tsx";
import { Term } from "./Term.tsx";

afterEach(cleanup);

const long = "Una definición muy larga que sigue y sigue. ".repeat(70);

function pick<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`${selector} not rendered`);
  return el;
}

const sheet = (
  <>
    <Sheet trigger={<button type="button">Ayuda</button>} title="¿Qué significa preliminar?">
      <p>{long}</p>
    </Sheet>
    <button type="button">Otro botón</button>
    <a href="#x">Enlace</a>
  </>
);

test("the trigger wires the dialog semantics", async () => {
  await render(sheet);
  const trigger = pick<HTMLButtonElement>("button");
  const dialog = pick<HTMLDialogElement>("dialog");
  expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
  expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
  await userEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await userEvent.keyboard("{Escape}");
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

test("closed, the dialog takes no space", async () => {
  await render(sheet);
  expect(pick("dialog").getBoundingClientRect().height).toBe(0);
});

test("focus stays inside, Escape and outside taps close and return focus", async () => {
  await render(sheet);
  const trigger = pick<HTMLButtonElement>("button");
  const dialog = pick<HTMLDialogElement>("dialog");
  await expectNoAxeViolations(document.body);

  await userEvent.click(trigger);
  expect(dialog.open).toBe(true);
  for (let i = 0; i < 6; i++) {
    await userEvent.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  }
  await expectNoAxeViolations(document.body);
  await userEvent.keyboard("{Escape}");
  expect(dialog.open).toBe(false);
  expect(document.activeElement).toBe(trigger);

  await userEvent.click(trigger);
  await userEvent.click(page.elementLocator(document.body), { position: { x: 5, y: 5 } });
  expect(dialog.open).toBe(false);
  expect(document.activeElement).toBe(trigger);

  await userEvent.click(trigger);
  await userEvent.click(page.getByRole("button", { name: "Cerrar" }));
  expect(dialog.open).toBe(false);
  expect(document.activeElement).toBe(trigger);
});

test("a tap inside the sheet does not close it", async () => {
  await render(sheet);
  await userEvent.click(pick("button"));
  await userEvent.click(page.getByText("Una definición", { exact: false }));
  expect(pick<HTMLDialogElement>("dialog").open).toBe(true);
});

test("Close is 48px, secondary and the sheet is anchored to the bottom on phones", async () => {
  await page.viewport(390, 700);
  await render(sheet);
  await userEvent.click(pick("button"));
  const dialog = pick<HTMLDialogElement>("dialog");
  const close = page.getByRole("button", { name: "Cerrar" }).element();
  expect(close.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
  const box = dialog.getBoundingClientRect();
  expect(box.bottom).toBe(window.innerHeight);
  expect(box.width).toBe(window.innerWidth);
  expect(box.height).toBeLessThanOrEqual(window.innerHeight * 0.85 + 1);
  const probe = document.createElement("div");
  probe.className = "bg-ink/40";
  document.body.append(probe);
  expect(getComputedStyle(dialog, "::backdrop").backgroundColor).toBe(
    getComputedStyle(probe).backgroundColor,
  );
  probe.remove();
});

test("from md the sheet is centered with a max width", async () => {
  await page.viewport(1024, 768);
  await render(sheet);
  await userEvent.click(pick("button"));
  const box = pick<HTMLDialogElement>("dialog").getBoundingClientRect();
  expect(box.width).toBeLessThanOrEqual(448);
  expect(Math.abs(box.left + box.width / 2 - window.innerWidth / 2)).toBeLessThan(1);
  expect(box.bottom).toBeLessThan(window.innerHeight);
});

test("a long definition scrolls inside the sheet and Close stays reachable at 320x568", async () => {
  await page.viewport(320, 568);
  await render(sheet);
  const trigger = pick<HTMLButtonElement>("button");
  await userEvent.click(trigger);
  const scrollable = pick<HTMLElement>("dialog [data-sheet-body]");
  expect(scrollable.scrollHeight).toBeGreaterThan(scrollable.clientHeight);
  const close = page.getByRole("button", { name: "Cerrar" }).element() as HTMLButtonElement;
  close.focus();
  expect(document.activeElement).toBe(close);
  const rect = close.getBoundingClientRect();
  expect(rect.top).toBeGreaterThanOrEqual(0);
  expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  expect(hit && close.contains(hit)).toBe(true);
  await userEvent.click(page.getByRole("button", { name: "Cerrar" }));
  expect(pick<HTMLDialogElement>("dialog").open).toBe(false);
  await expectNoAxeViolations(document.body);
});

test("Term opens the definition with a descriptive name and title", async () => {
  await render(
    <p>
      El informe es{" "}
      <Term term="preliminar" definition={<span>Es preliminar porque aún suma pruebas.</span>}>
        preliminar
      </Term>
      .
    </p>,
  );
  const trigger = page.getByRole("button", { name: "preliminar, qué significa" });
  await userEvent.click(trigger);
  const dialog = page.getByRole("dialog", { name: "¿Qué significa preliminar?" });
  await expect.element(dialog).toBeVisible();
  await expectNoAxeViolations(document.body);
  await userEvent.keyboard("{Escape}");
  expect(document.activeElement).toBe(trigger.element());
});

test("a drag-select that ends on the backdrop keeps the sheet open, a real tap closes it", async () => {
  await render(sheet);
  await userEvent.click(pick("button"));
  const dialog = pick<HTMLDialogElement>("dialog");
  // Browsers report the common ancestor (the dialog) as the click target after a drag across its edge.
  pick("dialog p").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(dialog.open).toBe(true);
  dialog.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  dialog.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(dialog.open).toBe(false);
});

test("Tab wraps from the last focusable to the first and Shift+Tab the other way", async () => {
  await render(sheet);
  await userEvent.click(pick("button"));
  const dialog = pick<HTMLDialogElement>("dialog");
  const body = pick<HTMLElement>("dialog [data-sheet-body]");
  const close = page.getByRole("button", { name: "Cerrar" }).element();
  body.focus();
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(close);
  await userEvent.tab();
  expect(document.activeElement).toBe(body);
  expect(dialog.open).toBe(true);
});

test("wrapping also covers form fields inside the definition", async () => {
  await render(
    <Sheet trigger={<button type="button">Ayuda</button>} title="Título">
      <input aria-label="Campo" />
    </Sheet>,
  );
  await userEvent.click(pick("button"));
  const close = page.getByRole("button", { name: "Cerrar" }).element();
  const input = pick<HTMLInputElement>("dialog input");
  close.focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(pick("dialog [data-sheet-body]"));
  input.focus();
  await userEvent.tab();
  expect(document.activeElement).toBe(close);
});

test("the page cannot scroll behind an open sheet and scrolls again after", async () => {
  await render(sheet);
  expect(getComputedStyle(document.body).overflow).not.toBe("hidden");
  await userEvent.click(pick("button"));
  expect(getComputedStyle(document.body).overflow).toBe("hidden");
  await userEvent.keyboard("{Escape}");
  expect(getComputedStyle(document.body).overflow).not.toBe("hidden");
});
