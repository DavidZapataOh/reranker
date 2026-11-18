import { readdirSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import esCO from "@reranker/i18n/messages/es-CO.json" with { type: "json" };
import { expect, test } from "vitest";
import { CLIENT_NAMESPACES, pick } from "../src/i18n/client-messages";

const BUDGET_BYTES = 6 * 1024;
const src = new URL("../src/", import.meta.url);

test.each(Object.entries(CLIENT_NAMESPACES))("client messages for %s ≤ 6 KB gzip", (_, ns) => {
  expect(gzipSync(JSON.stringify(pick(esCO, ns))).byteLength).toBeLessThanOrEqual(BUDGET_BYTES);
});

test("pick keeps only the requested namespaces", () => {
  expect(pick(esCO, ["common"])).toEqual({ common: esCO.common });
});

// The budget above only holds if no layout hands the provider anything but a declared pick.
test("every NextIntlClientProvider receives a declared pick of the messages", () => {
  const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((file) =>
    file.endsWith(".tsx"),
  );
  for (const file of files) {
    const code = readFileSync(new URL(file, src), "utf8");
    for (const [tag] of code.matchAll(/<NextIntlClientProvider\b[^>]*>/g)) {
      expect(tag, file).toMatch(/messages=\{pick\(\s*\w+,\s*CLIENT_NAMESPACES\.\w+\s*\)\}/);
    }
  }
});
