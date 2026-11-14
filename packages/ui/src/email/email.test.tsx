import { DEFAULT_LOCALE } from "@reranker/i18n";
import { render, toPlainText } from "react-email";
import { describe, expect, test } from "vitest";
import { tokens } from "../tokens.ts";
import {
  EmailBubble,
  EmailButton,
  EmailCode,
  EmailFooter,
  EmailHeading,
  EmailLayout,
  EmailSeal,
  EmailText,
  emailTailwindConfig,
} from "./index.ts";

const seal = {
  capturedAtLabel: "3 nov 2026, 9:14 a. m.",
  cityLabel: "Medellín",
  verifyUrl: "https://reranker.co/verificar/8F2K",
};

const sample = (bubbleText = "x".repeat(1200)) => (
  <EmailLayout preview="Tu reporte">
    <EmailHeading>Hola</EmailHeading>
    <EmailText>Tu reporte está listo.</EmailText>
    <EmailBubble engineLabel="ChatGPT · Colombia" text={bubbleText} />
    <EmailSeal {...seal} />
    <EmailButton href="https://reranker.co/reporte/abc">Ver reporte</EmailButton>
    <EmailFooter legalName="GLEMO S.A.S." unsubscribeUrl="https://reranker.co/baja/x" />
  </EmailLayout>
);

describe("email base", () => {
  test("renders a light, es-CO document under the size budget", async () => {
    const html = await render(sample());
    const bytes = Buffer.byteLength(html, "utf8");
    expect(bytes, `${bytes} bytes`).toBeLessThan(104_448);
    expect(html).toContain(`lang="${DEFAULT_LOCALE}"`);
    expect(html).toContain('name="color-scheme" content="light"');
    expect(html).toContain('name="supported-color-schemes" content="light"');
    expect(html).not.toMatch(/#[0-9a-f]{8}\b/i);
    // Gmail drops declarations it can't parse, so none of these may reach the HTML.
    expect(html).not.toMatch(/rgba\(|var\(--|oklch\(|calc\(/);
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(tokens.color.green.slice(i, i + 2), 16));
    expect(html.replaceAll(" ", "")).toContain(`background-color:rgb(${r},${g},${b})`);
    expect(html).toContain("Dejar de recibir estos correos");
    expect(html).toContain('href="https://reranker.co/verificar/8F2K"');
  });

  test("has a plain-text version", async () => {
    const text = await render(sample("Hola"), { plainText: true });
    expect(text).toContain("Ver reporte");
    expect(text).toContain("Respuesta guardada");
    expect(text).toContain("https://reranker.co/verificar/8F2K");
    expect(text).toContain("https://reranker.co/reporte/abc");
    expect(text).not.toContain("<");
  });

  test("shows the code in two groups", async () => {
    expect(toPlainText(await render(<EmailCode code="123456" />))).toContain("123 456");
    expect(() => EmailCode({ code: "12345" })).toThrow();
    expect(() => EmailCode({ code: "12345a" })).toThrow();
  });

  test("rejects hostile or non-canonical verify links", () => {
    for (const verifyUrl of [
      "/verificar/8F2K",
      "javascript:alert(1)",
      "https://evil.example/verificar/8F2K",
      "https://reranker.co.evil.example/verificar/x",
      "https://reranker.co/other",
    ]) {
      expect(() => EmailSeal({ ...seal, verifyUrl })).toThrow(TypeError);
    }
  });

  test("escapes answer text", async () => {
    const html = await render(sample("<b>x</b>"));
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });

  test("asks for no human contact", async () => {
    const text = toPlainText(await render(sample("Hola")));
    expect(text).not.toMatch(/llam|reuni|demo|agend|whatsapp/i);
  });

  test("builds opaque brand colors from tokens", () => {
    const { colors } = emailTailwindConfig.theme.extend;
    expect(colors.green).toBe(tokens.color.green);
    expect(colors["ink-soft"]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(colors.line).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
