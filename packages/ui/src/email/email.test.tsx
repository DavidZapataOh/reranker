import { DEFAULT_LOCALE } from "@reranker/i18n";
import { render, toPlainText } from "react-email";
import { describe, expect, test } from "vitest";
import { darkColor, tokens } from "../tokens.ts";
import {
  BRAND_MARK_URL,
  EmailBrandMark,
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

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const seal = {
  capturedAtLabel: "3 nov 2026, 9:14 a. m.",
  cityLabel: "Medellín",
  verifyUrl: "https://reranker.co/verificar/8F2K",
};

const sample = (bubbleText = "x".repeat(1200)) => (
  <EmailLayout
    preview="Tu reporte"
    footer={<EmailFooter legal="GLEMO S.A.S." unsubscribeUrl="https://reranker.co/baja/x" />}
  >
    <EmailHeading>Hola</EmailHeading>
    <EmailText>Tu reporte está listo.</EmailText>
    <EmailBubble engineLabel="ChatGPT · Colombia" text={bubbleText} />
    <EmailSeal {...seal} />
    <EmailButton href="https://reranker.co/reporte/abc">Ver reporte</EmailButton>
  </EmailLayout>
);

describe("email base", () => {
  test("renders a light and dark, es-CO document under the size budget", async () => {
    const html = await render(sample());
    const bytes = Buffer.byteLength(html, "utf8");
    expect(bytes, `${bytes} bytes`).toBeLessThan(104_448);
    expect(html).toContain(`lang="${DEFAULT_LOCALE}"`);
    expect(html).toContain('name="color-scheme" content="light dark"');
    expect(html).toContain('name="supported-color-schemes" content="light dark"');
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

  test("shows the code as one unbroken word in a table cell", async () => {
    const html = await render(<EmailCode code="123456" />);
    expect(html).toMatch(/<td[^>]*>123456<\/td>/);
    expect(html).not.toMatch(/123\s+456/);
    expect(toPlainText(html)).toContain("123456");
    const style = html.match(/<td[^>]*style="([^"]*)"[^>]*>123456/)?.[1] ?? "";
    expect(style).toContain("letter-spacing:8px");
    expect(style).toContain("padding-left:8px");
    expect(style).toContain("font-size:36px");
    expect(style).toContain("font-weight:700");
    expect(style).toContain("font-variant-numeric:tabular-nums");
    expect(style).toContain("user-select:all");
    expect(style).toContain("Plus Jakarta Sans");
    expect(style).not.toContain("monospace");
    expect(html).toContain("background-color");
    expect(() => EmailCode({ code: "12345" })).toThrow();
    expect(() => EmailCode({ code: "12345a" })).toThrow();
  });

  test("keeps the code readable on both of its backgrounds", () => {
    expect(contrast(tokens.color.ink, tokens.color.greenLight)).toBeGreaterThanOrEqual(7);
    expect(contrast(darkColor.codeText, darkColor.codeBackground)).toBeGreaterThanOrEqual(7);
    expect(contrast(darkColor.text, darkColor.surface)).toBeGreaterThanOrEqual(7);
    expect(contrast(darkColor.textSoft, darkColor.surface)).toBeGreaterThanOrEqual(4.5);
  });

  test("ships the dark rules in a style element and marks lang from the locale", async () => {
    const html = await render(
      <EmailLayout preview="x">
        <EmailCode code="123456" />
      </EmailLayout>,
    );
    const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    expect(html).toContain('lang="es-CO"');
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(`background-color: ${darkColor.surface} !important`);
    expect(css).toContain(".rr-body > table > tbody > tr > td");
    expect(css).toContain("[data-ogsc]");
    expect(css).toContain(".rr-pad { padding: 24px !important; }");
    expect(css).toContain("@media (max-width: 600px)");
    expect(html).toContain("<html");
    for (const cls of ["rr-body", "rr-card", "rr-code"]) {
      expect(html, cls).toMatch(new RegExp(`class="[^"]*\\b${cls}\\b`));
    }
  });

  test("renders the brand mark as an absolute https image", async () => {
    const html = await render(<EmailBrandMark />);
    expect(BRAND_MARK_URL).toBe("https://reranker.co/email/reranker-symbol-96.png");
    expect(html).toContain(`src="${BRAND_MARK_URL}"`);
    expect(html).toContain('alt="Reranker"');
    expect(html).toContain('width="40"');
    expect(html).toContain('height="40"');
  });

  test("puts the footer outside the card and lists its links", async () => {
    const html = await render(
      <EmailLayout
        preview="x"
        footer={
          <EmailFooter
            legal="Marca"
            links={[{ label: "Términos", href: "https://reranker.co/terminos" }]}
          />
        }
      >
        <EmailText>Dentro</EmailText>
      </EmailLayout>,
    );
    expect(html.indexOf("Dentro")).toBeLessThan(html.indexOf("Marca"));
    expect(html).toContain('href="https://reranker.co/terminos"');
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
