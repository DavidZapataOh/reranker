import { resetAppEnv } from "@reranker/env";
import { EvidenceStorageUnavailableError } from "@reranker/evidence";
import { InvalidInputError } from "@reranker/jobs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const evidence = vi.hoisted(() => ({ removeArtifact: vi.fn() }));
vi.mock("@reranker/evidence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/evidence")>()),
  removeArtifact: evidence.removeArtifact,
}));

const { POST } = await import("./route");

const CRON_SECRET = "cron-secret-with-enough-length";
const BEARER = { authorization: `Bearer ${CRON_SECRET}` };
const SHA256 = "ab".repeat(32);
const removal = { sha256: SHA256, kind: "raw", reason: "personal_data_request" };

function remove(headers: Record<string, string>, body: unknown = removal) {
  return POST(
    new Request("https://reranker.co/api/internal/evidence/remove", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("APP_ENV", "production");
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  resetAppEnv();
  evidence.removeArtifact.mockReset();
  evidence.removeArtifact.mockResolvedValue({ created: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetAppEnv();
});

test("removes the artifact and returns the result", async () => {
  const response = await remove(BEARER);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ ...removal, created: true });
  expect(evidence.removeArtifact).toHaveBeenCalledWith(SHA256, "raw", "personal_data_request");
});

test("a repeated removal answers created false", async () => {
  evidence.removeArtifact.mockResolvedValue({ created: false });
  expect(await (await remove(BEARER)).json()).toMatchObject({ created: false });
});

test("without the cron bearer nothing is removed", async () => {
  expect((await remove({})).status).toBe(401);
  expect((await remove({ authorization: "Bearer wrong" })).status).toBe(401);
  vi.stubEnv("CRON_SECRET", "");
  resetAppEnv();
  expect((await remove({ authorization: "Bearer " })).status).toBe(401);
  expect(evidence.removeArtifact).not.toHaveBeenCalled();
});

test.each([
  ["a malformed digest", { ...removal, sha256: "ABC" }],
  ["a kind that is not removable", { ...removal, kind: "envelopes" }],
  ["an unknown reason", { ...removal, reason: "because" }],
  ["an extra field", { ...removal, force: true }],
  ["a body that is not JSON", "not json"],
])("%s is refused with 400", async (_, body) => {
  expect((await remove(BEARER, body)).status).toBe(400);
  expect(evidence.removeArtifact).not.toHaveBeenCalled();
});

test("storage or purge trouble answers 503 so the dispatch can be rerun", async () => {
  evidence.removeArtifact.mockRejectedValue(new EvidenceStorageUnavailableError("R2 down"));
  expect((await remove(BEARER)).status).toBe(503);
});

test("an input the package rejects answers 400", async () => {
  evidence.removeArtifact.mockRejectedValue(new InvalidInputError("bad"));
  expect((await remove(BEARER)).status).toBe(400);
});
