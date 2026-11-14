import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "@reranker/schema";
import { expect, test } from "vitest";
import { checkExample, renderExample } from "./example";
import { config, requiredIn, secret } from "./index";

const fragments = [
  z.object({
    ZED_TOKEN: requiredIn(["production"], secret(z.string(), "Token for the zed service")),
    ALPHA_LIMIT: config(z.coerce.number().optional(), "Requests per minute"),
    NO_META: z.string().optional(),
  }),
];

test("renders one commented line per variable, sorted, APP_ENV included, unannotated as Secret", () => {
  const out = renderExample(fragments);
  expect(out).toBe(
    [
      "# Requests per minute (Config)",
      "ALPHA_LIMIT=",
      "",
      "# Runtime environment: development, preview or production (Config)",
      "APP_ENV=",
      "",
      "# (Secret)",
      "NO_META=",
      "",
      "# Token for the zed service (Secret)",
      "ZED_TOKEN=",
      "",
    ].join("\n"),
  );
});

test("a repeated variable across fragments is listed once", () => {
  const dup = z.object({ ALPHA_LIMIT: config(z.string(), "Other") });
  expect(renderExample([...fragments, dup]).match(/^ALPHA_LIMIT=/gm)).toHaveLength(1);
});

test("checkExample compares the file with the render", () => {
  const dir = mkdtempSync(join(tmpdir(), "env-example-"));
  const path = join(dir, ".env.example");
  expect(checkExample(path, fragments)).toBe(false);
  writeFileSync(path, renderExample(fragments));
  expect(checkExample(path, fragments)).toBe(true);
  writeFileSync(path, `${renderExample(fragments)}EXTRA=\n`);
  expect(checkExample(path, fragments)).toBe(false);
});
