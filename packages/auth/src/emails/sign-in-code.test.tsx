import { render } from "react-email";
import { describe, expect, test } from "vitest";
import { SignInCodeEmail, signInCodeCopy } from "./sign-in-code";

const otp = "482913";

describe("SignInCodeEmail", () => {
  test("renders the code, Spanish copy and no jargon", async () => {
    const html = await render(<SignInCodeEmail otp={otp} />);
    const text = await render(<SignInCodeEmail otp={otp} />, { plainText: true });
    expect(text).toContain("482 913");
    expect(text).toContain(signInCodeCopy.body);
    expect(text).toMatch(/vence en 10 minutos/i);
    expect(text).not.toMatch(/OTP|soporte|llam|agend|reuni/i);
    expect(html).toContain("GLEMO S.A.S.");
    expect(html).toContain('lang="es-CO"');
  });

  test("subject carries the code", () => {
    expect(signInCodeCopy.subject(otp)).toBe("Tu código para entrar a Reranker: 482913");
  });

  test("stays under the size budget", async () => {
    const html = await render(<SignInCodeEmail otp={otp} />);
    const bytes = Buffer.byteLength(html, "utf8");
    expect(bytes, `${bytes} bytes`).toBeLessThan(104_448);
  });

  test("rejects a code that is not six digits", async () => {
    await expect(render(<SignInCodeEmail otp="12345" />)).rejects.toThrow(TypeError);
  });
});
