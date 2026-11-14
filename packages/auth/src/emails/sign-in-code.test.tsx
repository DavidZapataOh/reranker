import { DEFAULT_LOCALE, LOCALES } from "@reranker/i18n";
import { render } from "react-email";
import { describe, expect, test } from "vitest";
import { SIGN_IN_CODE_TTL_SECONDS } from "../sign-in-code";
import { SignInCodeEmail, signInCodeCopy } from "./sign-in-code";
import { pendingLocaleCopy } from "./sign-in-code-copy";

const otp = "482913";
const email = (props: Partial<Parameters<typeof SignInCodeEmail>[0]> = {}) => (
  <SignInCodeEmail otp={otp} locale={DEFAULT_LOCALE} {...props} />
);
const copy = signInCodeCopy[DEFAULT_LOCALE];

describe("SignInCodeEmail", () => {
  test("renders the code as one word, the copy and no jargon", async () => {
    const html = await render(email());
    const text = await render(email(), { plainText: true });
    expect(text).toContain(otp);
    expect(text).not.toMatch(/482\s+913/);
    expect(html).toMatch(/>482913<\/td>/);
    expect(html).not.toMatch(/482\s+913/);
    expect(text).toContain(
      "Escríbelo en la página de Reranker que dejaste abierta. Vence en 10 minutos.",
    );
    expect(text).toContain(
      "No le compartas este código a nadie. Reranker nunca te lo va a pedir por WhatsApp, llamada ni correo.",
    );
    expect(text).toContain(
      "Si no fuiste tú, ignora este correo. Sin el código nadie puede entrar.",
    );
    expect(text).not.toMatch(/OTP|soporte|llam(a|e)\b|agend|reuni|demo/i);
    expect(html).toContain('lang="es-CO"');
  });

  test("subject starts with the code and the preheader adds something new", async () => {
    expect(copy.subject(otp)).toBe("482913 es tu código para entrar a Reranker");
    expect(copy.preheader(10)).toBe("Vence en 10 minutos. No se lo compartas a nadie.");
    const html = await render(email());
    expect(html).toContain(copy.preheader(SIGN_IN_CODE_TTL_SECONDS / 60));
    expect(html).not.toContain(
      `display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0" data-skip-in-text="true">${copy.subject(otp)}`,
    );
  });

  test("derives the minutes from the expiry constant", async () => {
    expect(SIGN_IN_CODE_TTL_SECONDS).toBe(600);
    const text = await render(email(), { plainText: true });
    expect(text).toContain(`Vence en ${SIGN_IN_CODE_TTL_SECONDS / 60} minutos`);
  });

  test("shows the brand mark with an absolute https URL and alt text", async () => {
    const html = await render(email());
    expect(html).toMatch(/<img[^>]*src="https:\/\/reranker\.co\/email\/reranker-symbol-96\.png"/);
    expect(html).toMatch(/<img[^>]*alt="Reranker"/);
  });

  test("footer names the legal entity, NIT, city and both links", async () => {
    const html = await render(email());
    const text = await render(email(), { plainText: true });
    const legal = "Reranker es una marca de GLEMO S.A.S. · NIT 902.091.972-5 · Medellín, Colombia";
    expect(html).toContain(legal);
    expect(text).toContain(legal);
    for (const url of ["https://reranker.co/terminos", "https://reranker.co/politica-de-datos"]) {
      expect(html).toContain(`href="${url}"`);
      expect(text).toContain(url);
    }
  });

  test("shows where the request came from only when both parts are known", async () => {
    const withPlace = await render(email({ requestedFrom: { city: "Cali", country: "Colombia" } }));
    expect(withPlace).toContain("Se pidió desde Cali, Colombia.");
    for (const requestedFrom of [
      undefined,
      { city: "", country: "Colombia" },
      { city: "Cali", country: "" },
    ]) {
      const html = await render(email({ requestedFrom }));
      expect(html).not.toContain("Se pidió desde");
    }
  });

  test("escapes the place it is given", async () => {
    const html = await render(email({ requestedFrom: { city: "<b>x</b>", country: "A&B" } }));
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });

  test("stays under the size budget", async () => {
    const html = await render(email({ requestedFrom: { city: "Medellín", country: "Colombia" } }));
    const bytes = Buffer.byteLength(html, "utf8");
    expect(bytes, `${bytes} bytes`).toBeLessThan(104_448);
  });

  test("rejects a code that is not six digits", async () => {
    await expect(render(email({ otp: "12345" }))).rejects.toThrow(TypeError);
  });

  test("has a dark scheme and a copy for every active locale", async () => {
    const html = await render(email());
    expect(html).toContain("prefers-color-scheme: dark");
    for (const locale of LOCALES) expect(signInCodeCopy[locale].heading).toBeTruthy();
  });

  test("keeps the English copy ready but unselectable until it is an active locale", () => {
    expect(LOCALES as readonly string[]).not.toContain("en");
    expect(pendingLocaleCopy.en.subject(otp)).toBe("482913 is your Reranker sign-in code");
    expect(pendingLocaleCopy.en.preheader(10)).toBe(
      "It expires in 10 minutes. Don't share it with anyone.",
    );
    expect(Object.keys(pendingLocaleCopy.en).sort()).toEqual(Object.keys(copy).sort());
  });
});
