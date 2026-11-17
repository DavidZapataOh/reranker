import { expect, test } from "vitest";
import { safeReturnPath } from "./return-path";

test.each([
  ["/app/mi-negocio-x7k2", "/app/mi-negocio-x7k2"],
  ["/app/a?tab=1", "/app/a?tab=1"],
  ["/app", "/app"],
  ["%2Fapp%2Fx%2Fcuenta", "/app/x/cuenta"],
  ["//evil.com", "/app"],
  ["/\\evil.com", "/app"],
  ["https://evil.com", "/app"],
  ["/app%2F..%2F//evil.com", "/app"],
  ["/app/../ingresar", "/app"],
  ["/apple", "/app"],
  ["/app/x#hash", "/app/x"],
  ["/app/%E0%A4%A", "/app"],
  ["", "/app"],
  [null, "/app"],
  [undefined, "/app"],
  ["javascript:alert(1)", "/app"],
])("safeReturnPath(%j) → %s", (input, out) => {
  expect(safeReturnPath(input)).toBe(out);
});
