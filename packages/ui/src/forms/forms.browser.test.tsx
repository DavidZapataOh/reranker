import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import { expectNoAxeViolations } from "../../test/axe.ts";
import { tokens } from "../tokens.ts";
import { Checkbox } from "./Checkbox.tsx";
import { SearchField } from "./SearchField.tsx";
import { TextField } from "./TextField.tsx";

afterEach(cleanup);

const pick = (root: HTMLElement, selector: string) => {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`${selector} not rendered`);
  return el;
};
const candidates = (
  <ul aria-label="Resultados">
    {["Uno", "Dos", "Tres", "Cuatro", "Cinco"].map((name) => (
      <li key={name}>{name}</li>
    ))}
  </ul>
);

test("hero SearchField copies the landing's values", async () => {
  const { container } = await render(
    <SearchField
      label="Nombre de tu negocio"
      inputProps={{ name: "business" }}
      submitLabel="Ver mi reporte"
      submitShortLabel="Ver"
    />,
  );
  const box = pick(container, "input").parentElement as HTMLElement;
  const s = getComputedStyle(box);
  expect(s.borderTopLeftRadius).toBe("22px");
  expect(s.backgroundColor).toBe("rgb(255, 255, 255)");
  expect(s.paddingLeft).toBe("20px");
  expect(s.paddingTop).toBe("8px");
  const probe = document.createElement("div");
  probe.style.boxShadow = tokens.shadow.float;
  document.body.append(probe);
  expect(s.boxShadow).toContain(getComputedStyle(probe).boxShadow);
  probe.remove();
  const icon = getComputedStyle(pick(container, "svg"));
  expect([icon.width, icon.height]).toEqual(["22px", "22px"]);
  const button = pick(container, "button");
  expect(getComputedStyle(button).backgroundColor).toBe("rgb(15, 92, 69)");
  expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
  expect(button.getAttribute("type")).toBe("submit");
  expect(getComputedStyle(pick(container, "input")).fontSize).toBe("18px");
});

test("paper SearchField has no shadow and the 18 px radius", async () => {
  const { container } = await render(
    <SearchField
      tone="paper"
      label="Nombre de tu negocio"
      inputProps={{}}
      submitLabel="Ver mi reporte"
    />,
  );
  const s = getComputedStyle(pick(container, "input").parentElement as HTMLElement);
  expect(s.borderTopLeftRadius).toBe("18px");
  expect(s.backgroundColor).toBe("rgb(250, 247, 240)");
  expect(s.boxShadow).not.toContain("rgba(20, 33, 27, 0.05)");
});

test("SearchField short label shows only below sm", async () => {
  await page.viewport(360, 640);
  const { container } = await render(
    <SearchField
      label="Nombre"
      inputProps={{}}
      submitLabel="Ver mi reporte"
      submitShortLabel="Ver"
    />,
  );
  const [long, short] = [...container.querySelectorAll("button span")] as HTMLElement[];
  expect(getComputedStyle(long as HTMLElement).display).toBe("none");
  expect(getComputedStyle(short as HTMLElement).display).not.toBe("none");
  await page.viewport(414, 640);
});

test("Checkbox hit box is at least 48 by 48 and toggles with Space", async () => {
  const { container } = await render(<Checkbox name="terms">Acepto los términos</Checkbox>);
  const rect = pick(container, "label").getBoundingClientRect();
  expect(rect.height).toBeGreaterThanOrEqual(48);
  const input = pick(container, "input") as HTMLInputElement;
  expect(input.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);
  await userEvent.tab();
  expect(document.activeElement).toBe(input);
  await userEvent.keyboard(" ");
  expect(input.checked).toBe(true);
  expect(getComputedStyle(input).backgroundColor).toBe("rgb(15, 92, 69)");
  await userEvent.keyboard(" ");
  expect(input.checked).toBe(false);
});

test("Checkbox label is the 48 px target on both axes", async () => {
  const { container } = await render(<Checkbox name="terms">Acepto</Checkbox>);
  const rect = pick(container, "label").getBoundingClientRect();
  expect(rect.width).toBeGreaterThanOrEqual(48);
});

test("TextField text is at least 16 px at 360 px wide", async () => {
  await page.viewport(360, 640);
  const { container } = await render(<TextField label="Correo" type="email" />);
  const input = pick(container, "input");
  expect(Number.parseFloat(getComputedStyle(input).fontSize)).toBeGreaterThanOrEqual(16);
  expect(input.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
  await page.viewport(414, 640);
});

test("every field has no axe violations in each state", async () => {
  const states = [{}, { error: "Revisa tu correo" }, { disabled: true }];
  for (const state of states) {
    const { container } = await render(
      <div className="p-4">
        <TextField label="Correo" type="email" hint="Sin spam" {...state} />
        <Checkbox name="terms" {...("error" in state ? { error: "Acepta para seguir" } : {})}>
          Acepto los términos
        </Checkbox>
        <SearchField
          label="Nombre de tu negocio"
          inputProps={{ disabled: "disabled" in state }}
          submitLabel="Ver mi reporte"
          submitShortLabel="Ver"
        />
      </div>,
    );
    await expectNoAxeViolations(container);
    await cleanup();
  }
  const { container } = await render(
    <SearchField label="Nombre de tu negocio" inputProps={{}} submitLabel="Ver mi reporte">
      {candidates}
    </SearchField>,
  );
  await expectNoAxeViolations(container);
});
