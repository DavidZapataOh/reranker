import { resetAppEnv } from "@reranker/env";
import { EvidenceStorageUnavailableError, SigningUnavailableError } from "@reranker/evidence";
import {
  InvalidInputError,
  ProviderUnavailableError,
  RateLimitedError,
  SpendCapExceededError,
} from "@reranker/jobs";
import { AppError } from "@reranker/schema";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const jobs = vi.hoisted(() => ({ probeSpendPath: vi.fn(), probeNetworkLookup: vi.fn() }));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  probeSpendPath: jobs.probeSpendPath,
  probeNetworkLookup: jobs.probeNetworkLookup,
}));

const evidence = vi.hoisted(() => ({ probeSealCapture: vi.fn(), probeBuildBundle: vi.fn() }));
vi.mock("@reranker/evidence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/evidence")>()),
  probeSealCapture: evidence.probeSealCapture,
  probeBuildBundle: evidence.probeBuildBundle,
}));

const { POST } = await import("./route");

const CRON_SECRET = "cron-secret-with-enough-length";
const BEARER = { authorization: `Bearer ${CRON_SECRET}` };
const stats = { p50: 1.2, p95: 3.4, n: 1000 };
const report = { acquireProviderSlot: stats, reserveSpend: stats, settleSpend: stats };
const networkReport = { classifyNetwork: stats, ranges: 42_000 };
const sealReport = {
  sealCapture: null,
  r2WriteRound: stats,
  database: stats,
  envelope: stats,
  sign: null,
};
const bundleReport = {
  buildBundle: stats,
  transaction: stats,
  database: stats,
  removals: stats,
  envelopeRead: stats,
  proofs: stats,
  sealSummaries: stats,
};

function probe(headers: Record<string, string> = {}, body?: string) {
  return POST(
    new Request("https://preview.example/api/internal/jobs-latency", {
      method: "POST",
      headers,
      ...(body === undefined ? {} : { body }),
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
  vi.stubEnv("APP_ENV", "preview");
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  resetAppEnv();
  jobs.probeSpendPath.mockReset();
  jobs.probeSpendPath.mockResolvedValue(report);
  jobs.probeNetworkLookup.mockReset();
  jobs.probeNetworkLookup.mockResolvedValue(networkReport);
  evidence.probeSealCapture.mockReset();
  evidence.probeSealCapture.mockResolvedValue(sealReport);
  evidence.probeBuildBundle.mockReset();
  evidence.probeBuildBundle.mockResolvedValue(bundleReport);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetAppEnv();
});

test("answers the percentiles of each primitive, and nothing else", async () => {
  const response = await probe(BEARER, JSON.stringify({ n: 1000 }));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(report);
  expect(jobs.probeSpendPath).toHaveBeenCalledWith(1000, {});
});

test("passes the hold through and probes 1,000 calls when the body says nothing", async () => {
  await probe(BEARER, JSON.stringify({ n: 1, holdMs: 250 }));
  expect(jobs.probeSpendPath).toHaveBeenLastCalledWith(1, { holdMs: 250 });
  await probe(BEARER);
  expect(jobs.probeSpendPath).toHaveBeenLastCalledWith(1000, {});
});

test.each(["production", "development"])("does not exist in %s, bearer or not", async (env) => {
  vi.stubEnv("APP_ENV", env);
  resetAppEnv();
  expect((await probe(BEARER)).status).toBe(404);
  expect((await probe()).status).toBe(404);
  expect(jobs.probeSpendPath).not.toHaveBeenCalled();
});

test.each([
  ["no bearer", {}],
  ["a wrong bearer", { authorization: "Bearer nope" }],
])("rejects %s before touching the database", async (_, headers) => {
  expect((await probe(headers)).status).toBe(401);
  expect(jobs.probeSpendPath).not.toHaveBeenCalled();
});

test.each([
  ["a body that is not JSON", "{n:"],
  ["a body that is not an object", "[1]"],
])("refuses %s", async (_, body) => {
  expect((await probe(BEARER, body)).status).toBe(400);
  expect(jobs.probeSpendPath).not.toHaveBeenCalled();
});

test("refuses what the probe refuses", async () => {
  jobs.probeSpendPath.mockRejectedValue(new InvalidInputError("A probe makes 1 to 1000 calls"));
  expect((await probe(BEARER, JSON.stringify({ n: 5000 }))).status).toBe(400);
});

test.each([
  ["a full slot pool", new RateLimitedError(1200), 429, "2"],
  [
    "a full spend cap",
    new SpendCapExceededError("purpose:contract-test", new Date("2026-11-18T05:00:00Z")),
    429,
    "61200",
  ],
  ["an open breaker", new ProviderUnavailableError("dataforseo", 30_000), 503, "30"],
  [
    "a database that is out of connections",
    new AppError("service_unavailable", { retryAfterSeconds: 2 }),
    503,
    "2",
  ],
])("answers %s with its status and when to retry", async (_, error, status, retryAfter) => {
  jobs.probeSpendPath.mockRejectedValue(error);
  const response = await probe(BEARER);
  expect(response.status).toBe(status);
  expect(response.headers.get("retry-after")).toBe(retryAfter);
});

test("anything a step would not retry on a schedule is still a server error", async () => {
  jobs.probeSpendPath.mockRejectedValue(new AppError("internal"));
  await expect(probe(BEARER)).rejects.toMatchObject({ code: "internal" });
});

test("times the network lookup when asked, and nothing of the spend path", async () => {
  const response = await probe(BEARER, JSON.stringify({ probe: "network", n: 1000 }));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(networkReport);
  expect(jobs.probeNetworkLookup).toHaveBeenCalledWith(1000);
  expect(jobs.probeSpendPath).not.toHaveBeenCalled();
});

test("probes the spend path when the probe is named", async () => {
  await probe(BEARER, JSON.stringify({ probe: "spend", n: 3 }));
  expect(jobs.probeSpendPath).toHaveBeenCalledWith(3, {});
});

test.each([
  ["an unknown probe", { probe: "disk" }],
  ["a hold on the network probe", { probe: "network", holdMs: 100 }],
])("refuses %s", async (_, body) => {
  expect((await probe(BEARER, JSON.stringify(body))).status).toBe(400);
  expect(jobs.probeSpendPath).not.toHaveBeenCalled();
  expect(jobs.probeNetworkLookup).not.toHaveBeenCalled();
});

test("times capture sealing when asked, a hundred seals unless the body says otherwise", async () => {
  const response = await probe(BEARER, JSON.stringify({ probe: "seal" }));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(sealReport);
  expect(evidence.probeSealCapture).toHaveBeenLastCalledWith(100);
  await probe(BEARER, JSON.stringify({ probe: "seal", n: 5 }));
  expect(evidence.probeSealCapture).toHaveBeenLastCalledWith(5);
  expect(jobs.probeSpendPath).not.toHaveBeenCalled();
});

test("times verification bundles when asked, a hundred unless the body says otherwise", async () => {
  const response = await probe(BEARER, JSON.stringify({ probe: "bundle" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(bundleReport);
  expect(evidence.probeBuildBundle).toHaveBeenLastCalledWith(100);
  await probe(BEARER, JSON.stringify({ probe: "bundle", n: 5 }));
  expect(evidence.probeBuildBundle).toHaveBeenLastCalledWith(5);
  expect(evidence.probeSealCapture).not.toHaveBeenCalled();
});

test("refuses a hold on the bundle probe and answers an R2 failure with a 503", async () => {
  expect((await probe(BEARER, JSON.stringify({ probe: "bundle", holdMs: 100 }))).status).toBe(400);
  expect(evidence.probeBuildBundle).not.toHaveBeenCalled();
  evidence.probeBuildBundle.mockRejectedValue(new EvidenceStorageUnavailableError("R2 GET: 503"));
  expect((await probe(BEARER, JSON.stringify({ probe: "bundle" }))).status).toBe(503);
});

test("refuses a hold on the seal probe", async () => {
  expect((await probe(BEARER, JSON.stringify({ probe: "seal", holdMs: 100 }))).status).toBe(400);
  expect(evidence.probeSealCapture).not.toHaveBeenCalled();
});

test.each([
  ["R2 failing", new EvidenceStorageUnavailableError("R2 PUT raw/x: 503")],
  ["KMS failing", new SigningUnavailableError("KMS is unreachable")],
])("answers %s with a 503", async (_, error) => {
  evidence.probeSealCapture.mockRejectedValue(error);
  expect((await probe(BEARER, JSON.stringify({ probe: "seal" }))).status).toBe(503);
});
