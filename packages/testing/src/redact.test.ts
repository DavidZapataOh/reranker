import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { redactSecret } from "./redact.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "redact-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

it("replaces every occurrence in nested files and reports which files changed", async () => {
  await mkdir(join(dir, "nested"));
  await writeFile(
    join(dir, "lhr.json"),
    '{"extraHeaders":{"x-vercel-protection-bypass":"s3cret"},"again":"s3cret"}',
  );
  await writeFile(join(dir, "nested", "report.html"), "<script>window.__LH='s3cret'</script>");
  await writeFile(join(dir, "clean.json"), '{"ok":true}');

  const changed = await redactSecret(dir, "s3cret");

  expect(changed.sort()).toEqual([join(dir, "lhr.json"), join(dir, "nested", "report.html")]);
  expect(await readFile(join(dir, "lhr.json"), "utf8")).toBe(
    '{"extraHeaders":{"x-vercel-protection-bypass":"[redacted]"},"again":"[redacted]"}',
  );
  expect(await readFile(join(dir, "nested", "report.html"), "utf8")).not.toContain("s3cret");
  expect(await readFile(join(dir, "clean.json"), "utf8")).toBe('{"ok":true}');
});

it("leaves files without the secret untouched", async () => {
  await writeFile(join(dir, "clean.json"), '{"ok":true}');
  const before = (await stat(join(dir, "clean.json"))).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await redactSecret(dir, "s3cret");
  expect((await stat(join(dir, "clean.json"))).mtimeMs).toBe(before);
});

it("refuses an empty secret instead of rewriting every file", async () => {
  await writeFile(join(dir, "a.json"), "{}");
  await expect(redactSecret(dir, "")).rejects.toThrow("Refusing to redact an empty secret");
  expect(await readFile(join(dir, "a.json"), "utf8")).toBe("{}");
});

it("returns nothing when the directory does not exist", async () => {
  expect(await redactSecret(join(dir, "missing"), "s3cret")).toEqual([]);
});
