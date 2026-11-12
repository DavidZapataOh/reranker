import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/redact-bypass-secret.ts", import.meta.url));

let root: string;
let reports: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "redact-cli-"));
  reports = join(root, ".lighthouseci");
  await run("mkdir", [reports]);
});
afterEach(async () => {
  await chmod(join(reports, "locked.json"), 0o600).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

const env = (secret: string) => ({ ...process.env, VERCEL_AUTOMATION_BYPASS_SECRET: secret });

it("redacts the secret from the reports", async () => {
  await writeFile(join(reports, "lhr.json"), '{"h":"s3cret"}');
  const { stdout } = await run("node", [cli, reports], { env: env("s3cret") });
  expect(stdout).toContain("Redacted the bypass secret from 1 file(s)");
  expect(await readFile(join(reports, "lhr.json"), "utf8")).toBe('{"h":"[redacted]"}');
});

it("deletes the reports and fails when one cannot be redacted", async () => {
  await writeFile(join(reports, "locked.json"), '{"h":"s3cret"}');
  await chmod(join(reports, "locked.json"), 0o000);
  const failure = await run("node", [cli, reports], { env: env("s3cret") }).catch((e) => e);
  expect(failure.code).toBe(1);
  expect(failure.stdout).toContain(`::error::Could not redact ${reports}, deleted it`);
  await expect(stat(reports)).rejects.toThrow("ENOENT");
});

it("does nothing without a secret, as in local runs", async () => {
  await writeFile(join(reports, "lhr.json"), '{"h":"local"}');
  await run("node", [cli, reports], { env: env("") });
  expect(await readFile(join(reports, "lhr.json"), "utf8")).toBe('{"h":"local"}');
});

it("requires the reports directory", async () => {
  const failure = await run("node", [cli], { env: env("s3cret") }).catch((e) => e);
  expect(failure.code).toBe(1);
  expect(failure.stdout).toContain("::error::Usage: redact-bypass-secret.ts <dir>");
});
