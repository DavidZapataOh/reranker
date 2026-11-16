import { resetAppEnv } from "@reranker/env";
import { afterEach, expect, test, vi } from "vitest";
import { opsGuard } from "./ops-guard";

const CRON_SECRET = "cron-secret-with-enough-length";

function setAppEnv(value: string) {
  vi.stubEnv("APP_ENV", value);
  resetAppEnv();
}

function req(headers: Record<string, string>) {
  return new Request("https://reranker.co/api/ops/fault", { headers });
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetAppEnv();
});

test("production requires the cron bearer", () => {
  setAppEnv("production");
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  expect(opsGuard(req({}))?.status).toBe(404);
  expect(opsGuard(req({ authorization: `Bearer ${CRON_SECRET}` }))).toBeNull();
});

test("production rejects a wrong or partial bearer", () => {
  setAppEnv("production");
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  expect(opsGuard(req({ authorization: "Bearer nope" }))?.status).toBe(404);
  expect(opsGuard(req({ authorization: CRON_SECRET }))?.status).toBe(404);
  expect(opsGuard(req({ authorization: `Bearer ${CRON_SECRET}x` }))?.status).toBe(404);
});

test("production fails closed while the cron secret is unset", () => {
  setAppEnv("production");
  vi.stubEnv("CRON_SECRET", "");
  expect(opsGuard(req({}))?.status).toBe(404);
  expect(opsGuard(req({ authorization: "Bearer " }))?.status).toBe(404);
  expect(opsGuard(req({ authorization: "Bearer undefined" }))?.status).toBe(404);
});

test("preview is open behind deployment protection", () => {
  setAppEnv("preview");
  expect(opsGuard(req({}))).toBeNull();
});

test("development is open", () => {
  setAppEnv("development");
  expect(opsGuard(req({}))).toBeNull();
});
