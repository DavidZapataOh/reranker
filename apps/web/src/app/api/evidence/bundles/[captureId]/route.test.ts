import type { EvidenceBundleV1 } from "@reranker/verify/format";
import { beforeEach, expect, test, vi } from "vitest";

const evidence = vi.hoisted(() => ({ buildBundle: vi.fn(), getSealSummaries: vi.fn() }));
vi.mock("@reranker/evidence", () => evidence);
vi.mock("@reranker/telemetry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/telemetry")>()),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  captureServerEvent: vi.fn(),
}));

const { GET } = await import("./route");

const ID = "cap_01JD8X6V7Q0000000000000000";
const DIGEST = "a".repeat(64);

function bundle(ots: EvidenceBundleV1["anchors"]["ots"]): EvidenceBundleV1 {
  return {
    version: 1,
    capture_id: ID as EvidenceBundleV1["capture_id"],
    envelope: {
      payloadType: "application/vnd.in-toto+json",
      payload: "e30=",
      signatures: [{ keyid: "rr-capture-preview-1-ed25519", sig: "c2ln" }],
    },
    artifacts: { raw: { sha256: DIGEST, status: "available" } },
    inclusion: { log: "log.reranker.co/captures/2026", index: 0, tree_size: 1, hashes: [] },
    checkpoint: "log.reranker.co/captures/2026\n1\nroot\n\n— log sig\n",
    latest: {
      checkpoint: "log.reranker.co/captures/2026\n1\nroot\n\n— log sig\n",
      consistency: [],
    },
    anchors: { ots, tsr: [] },
    rekor: null,
    plan: null,
    tlsn: null,
  };
}

const get = (captureId: string) =>
  GET(new Request(`https://reranker.co/api/evidence/bundles/${captureId}`), {
    params: Promise.resolve({ captureId }),
  });

beforeEach(() => {
  evidence.buildBundle.mockReset();
  evidence.getSealSummaries.mockReset();
});

test("serves a logged capture's bundle with a short shared cache", async () => {
  const body = bundle({ status: "pending", proof: "AA==", bitcoin_height: null });
  evidence.buildBundle.mockResolvedValue(body);
  const response = await get(ID);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/vnd.reranker.bundle+json");
  expect(response.headers.get("cache-control")).toBe(
    "public, s-maxage=60, stale-while-revalidate=86400",
  );
  expect(await response.json()).toEqual(body);
  expect(evidence.buildBundle).toHaveBeenCalledExactlyOnceWith(ID);
});

test("caches for an hour once Bitcoin confirms the bundle's checkpoint", async () => {
  evidence.buildBundle.mockResolvedValue(
    bundle({ status: "confirmed", proof: "AA==", bitcoin_height: 900_000 }),
  );
  const response = await get(ID);
  expect(response.headers.get("cache-control")).toBe(
    "public, s-maxage=3600, stale-while-revalidate=86400",
  );
});

test("a malformed id is evidence_not_found without touching the log", async () => {
  for (const id of ["cap_123", "../../etc", "CAP_01JD8X6V7Q0000000000000000"]) {
    const response = await get(encodeURIComponent(id));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(await response.json()).toMatchObject({ code: "evidence_not_found", status: 404 });
  }
  expect(evidence.buildBundle).not.toHaveBeenCalled();
});

test("an unknown capture is evidence_not_found with no retry", async () => {
  evidence.buildBundle.mockResolvedValue(null);
  evidence.getSealSummaries.mockResolvedValue([]);
  const response = await get(ID);
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: "evidence_not_found" });
  expect(response.headers.get("retry-after")).toBeNull();
});

test("a signed capture not yet in a checkpoint asks to retry in a minute", async () => {
  evidence.buildBundle.mockResolvedValue(null);
  evidence.getSealSummaries.mockResolvedValue([{ captureId: ID, status: "signed" }]);
  const response = await get(ID);
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: "evidence_not_found" });
  expect(response.headers.get("retry-after")).toBe("60");
  expect(evidence.getSealSummaries).toHaveBeenCalledExactlyOnceWith([ID]);
});

test("a storage failure is a 500 problem, never a partial bundle", async () => {
  evidence.buildBundle.mockRejectedValue(new Error("R2 GET failed"));
  const response = await get(ID);
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ code: "internal" });
});
