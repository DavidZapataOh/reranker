import { renderToStaticMarkup as html } from "react-dom/server";
import { expect, test } from "vitest";
import { Checkbox } from "./Checkbox.tsx";
import { CodeField, sanitizeCode } from "./CodeField.tsx";
import { FieldError } from "./FieldError.tsx";
import { SearchField } from "./SearchField.tsx";
import { TextField } from "./TextField.tsx";

// React server output keeps camelCase attribute names; HTML treats them case-insensitively.
const lower = (text: string) => text.toLowerCase();
const count = (text: string, part: string) => text.split(part).length - 1;

test("sanitizeCode keeps only the first six digits", () => {
  expect(sanitizeCode("123 456")).toBe("123456");
  expect(sanitizeCode("Tu código es 123-456")).toBe("123456");
  expect(sanitizeCode("1234567")).toBe("123456");
  expect(sanitizeCode("abc")).toBe("");
  expect(sanitizeCode("")).toBe("");
});

test("CodeField is a single one-time-code input", () => {
  const h = lower(html(<CodeField name="code" label="Código" />));
  expect(count(h, "<input")).toBe(1);
  expect(h).toContain('autocomplete="one-time-code"');
  expect(h).toContain('inputmode="numeric"');
  expect(h).toContain('pattern="[0-9]{6}"');
  expect(h).toContain('maxlength="6"');
  expect(h).toContain('aria-hidden="true"');
  expect(count(h, "<span")).toBe(6);
});

test("TextField email gets the email keyboard and autofill hints", () => {
  const t = lower(html(<TextField type="email" label="Correo" error="Revisa tu correo" />));
  expect(t).toContain('inputmode="email"');
  expect(t).toContain('autocomplete="email"');
  expect(t).toContain('autocapitalize="none"');
  expect(t).toContain('aria-invalid="true"');
  expect(t).toContain("revisa tu correo");
});

test("TextField links hint and error to the input", () => {
  const t = html(<TextField label="Nombre" hint="Como en tu letrero" error="Falta el nombre" />);
  const describedBy = /aria-describedby="([^"]+)"/.exec(t)?.[1]?.split(" ") ?? [];
  expect(describedBy).toHaveLength(2);
  for (const id of describedBy) expect(t).toContain(`id="${id}"`);
});

test("SearchField renders its children under the field", () => {
  expect(
    html(
      <SearchField label="Nombre de tu negocio" inputProps={{}} submitLabel="Ver mi reporte">
        <ul id="c" />
      </SearchField>,
    ),
  ).toContain('<ul id="c">');
});

test("Checkbox links its error", () => {
  const h = html(
    <Checkbox name="terms" required error="Acepta para seguir">
      Acepto
    </Checkbox>,
  );
  const id = /aria-describedby="([^"]+)"/.exec(h)?.[1];
  expect(id).toBeTruthy();
  expect(h).toContain(`id="${id}"`);
  expect(h).toContain('aria-invalid="true"');
});

test("FieldError is an assertive alert with the given id", () => {
  const h = html(<FieldError id="e">Algo</FieldError>);
  expect(h).toContain('id="e"');
  expect(h).toContain('role="alert"');
});

test("TextField keeps a caller aria-describedby next to its own ids", () => {
  const t = html(<TextField label="Nombre" error="Falta" aria-describedby="extra" />);
  const ids = /aria-describedby="([^"]+)"/.exec(t)?.[1]?.split(" ") ?? [];
  expect(ids).toHaveLength(2);
  expect(ids).toContain("extra");
});
