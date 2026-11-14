import { renderToStaticMarkup as html } from "react-dom/server";
import { expect, test } from "vitest";
import { EvidenceSeal } from "./EvidenceSeal.tsx";
import { assertVerifyUrl } from "./verifyUrl.ts";

const textOf = (markup: string) => markup.replace(/<[^>]+>/g, "").replaceAll("&quot;", '"');

test("only Reranker's own verification links are accepted", () => {
  for (const ok of [
    "/verificar/8F2K",
    "/verificar/8F2K?ref=correo#sello",
    "https://reranker.co/verificar/8F2K",
    "https://reranker.co/verificar/8F2K?ref=correo",
  ]) {
    expect(assertVerifyUrl(ok)).toBe(ok);
  }
});

test("the returned link is the canonical form that was validated", () => {
  expect(assertVerifyUrl("/verificar/a b")).toBe("/verificar/a%20b");
  expect(assertVerifyUrl("/verificar/8F2K/./x")).toBe("/verificar/8F2K/x");
  expect(assertVerifyUrl("https://RERANKER.co/verificar/8F2K")).toBe(
    "https://reranker.co/verificar/8F2K",
  );
});

test("hostile or malformed verification links are rejected", () => {
  for (const bad of [
    "https://reranker.co.evil.com/x",
    "https://reranker.co@evil.com/x",
    "https://reranker.co:8443/v/1",
    "javascript:alert(1)",
    "JavaScript:alert(1)//https://reranker.co/",
    "data:text/html,<script>alert(1)</script>",
    "//evil.com",
    "/\\evil.com",
    "/verificar/../admin",
    "/verificar/x/../../admin",
    "/verificar/%2e%2e/admin",
    "/verificar/%2E%2E/admin",
    "/verificar/.\t./admin",
    "/verificar/..\\admin",
    "/verificar/",
    "/verificar//evil.com",
    "/verificar/?x=1",
    "/verificar",
    "/admin",
    "verificar/8F2K",
    " https://reranker.co/v/1",
    "http://reranker.co/v/1",
    "",
    "/verificar/\t/evil.com",
    "/verificar/x\n/admin",
    "/verificar/x\r",
    "/verificar/x\u0000",
    "/verificar/x\u007f",
    "/verificar/x//y",
    "https://reranker.co/v/8F2K",
    "https://reranker.co/admin",
    "https://reranker.co/verificar/",
    "https://reranker.co/v/../../x",
    "https://reranker.co/verificar/../admin",
    "https://reranker.co/verificar/%2e%2e/admin",
    "https://reranker.co/\\evil.com",
    "https://reranker.co/verificar/x//evil.com",
  ]) {
    expect(() => assertVerifyUrl(bad), bad).toThrow(TypeError);
  }
});

const seal = { capturedAtLabel: "3 nov 2026, 9:14 a. m.", cityLabel: "Medellín" };

test("the inline seal states when and where the answer was kept, in ink", () => {
  const s = html(<EvidenceSeal {...seal} verifyUrl="/verificar/8F2K" />);
  expect(textOf(s)).toContain(
    "Respuesta guardada · 3 nov 2026, 9:14 a. m. · Medellín · sin editar",
  );
  expect(s).toMatch(/^<div[^>]* class="[^"]*font-mono[^"]*text-\[13px\][^"]*text-ink/);
  expect(s).toMatch(/<svg[^>]*aria-hidden="true"/);
  expect(s).toContain('stroke="currentColor"');
  expect(s).not.toMatch(/text-green|fill-green|stroke-green|text-action/);
});

test("the help trigger is a 48 px button named for what it explains", () => {
  const s = html(<EvidenceSeal {...seal} verifyUrl="/verificar/8F2K" />);
  expect(s).toMatch(
    /<button type="button" aria-label="Qué significa respuesta guardada"[^>]*class="[^"]*size-12/,
  );
  expect(s).toContain('aria-haspopup="dialog"');
});

test("a hostile verification link throws instead of rendering the seal", () => {
  for (const verifyUrl of [
    "https://reranker.co.evil.com/x",
    "javascript:alert(1)",
    "//evil.com",
    "/verificar/../admin",
  ]) {
    expect(() => html(<EvidenceSeal {...seal} verifyUrl={verifyUrl} />), verifyUrl).toThrow(
      TypeError,
    );
  }
});
