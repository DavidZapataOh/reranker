import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { InvalidInputError } from "@reranker/jobs/errors";
import { log } from "@reranker/telemetry";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  artifactUrl,
  deleteArtifact,
  getArtifact,
  getLogObject,
  PRIVATE_ARTIFACT_KINDS,
  putArtifact,
  putLogObject,
} from "../src/artifacts";
import { resetEvidenceEnv } from "../src/env";
import { EvidenceStorageUnavailableError } from "../src/errors";
import { previewEnv } from "./support/evidence-env";

vi.mock("@reranker/telemetry", () => ({ log: { error: vi.fn() } }));

type Recorded = { url: string; method: string; headers: Record<string, string>; body: Uint8Array };
type Reply = number | Response | Error;

/** Stands in for the global fetch aws4fetch calls, replying in order and keeping every request. */
function recordingFetch(...replies: Reply[]) {
  const requests: Recorded[] = [];
  const spy = vi.fn(async (request: Request) => {
    requests.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: new Uint8Array(await request.arrayBuffer()),
    });
    const reply = (replies.length > 1 ? replies.shift() : replies[0]) as Reply;
    if (reply instanceof Error) throw reply;
    return reply instanceof Response ? reply : new Response(null, { status: reply });
  });
  vi.stubGlobal("fetch", spy);
  return {
    requests,
    get lastRequest() {
      return requests.at(-1) as Recorded;
    },
  };
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const R2 = `https://${previewEnv.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

beforeEach(() => {
  for (const [name, value] of Object.entries(previewEnv)) vi.stubEnv(name, value);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(log.error).mockClear();
  resetEvidenceEnv();
});

describe("putArtifact", () => {
  test("sends gzip, immutable cache and If-None-Match, keyed by the uncompressed digest", async () => {
    const fetchSpy = recordingFetch(201);
    const bytes = utf8('{"x":1}');
    const { sha256, created } = await putArtifact("raw", bytes, {
      contentType: "application/json",
    });
    expect(sha256).toBe(sha256Of(bytes));
    expect(created).toBe(true);
    expect(fetchSpy.lastRequest.method).toBe("PUT");
    expect(fetchSpy.lastRequest.url).toBe(`${R2}/rr-evidence-preview/raw/${sha256}`);
    expect(fetchSpy.lastRequest.headers).toMatchObject({
      "content-type": "application/json",
      "content-encoding": "gzip",
      "cache-control": "public, max-age=31536000, immutable",
      "if-none-match": "*",
    });
    expect(fetchSpy.lastRequest.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=fedcba9876543210fedcba9876543210\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=.*if-none-match/,
    );
    expect(fetchSpy.lastRequest.body).toEqual(new Uint8Array(gzipSync(bytes)));
  });

  test("412 means the object already exists and is success", async () => {
    recordingFetch(412);
    const result = await putArtifact("normalized", utf8("{}"), { contentType: "application/json" });
    expect(result).toEqual({ sha256: sha256Of(utf8("{}")), created: false });
  });

  test("extractions go to the private bucket and have no public URL", async () => {
    const fetchSpy = recordingFetch(201);
    await putArtifact("extractions", utf8("{}"), { contentType: "application/json" });
    expect(fetchSpy.lastRequest.url).toMatch(/\/rr-internal-preview\/extractions\/[0-9a-f]{64}$/);
    expect(fetchSpy.lastRequest.headers["cache-control"]).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(PRIVATE_ARTIFACT_KINDS).toEqual(new Set(["extractions"]));
    expect(() => artifactUrl("extractions", "ab".repeat(32))).toThrow(InvalidInputError);
  });

  test("a 5xx after the client's own retries is a retryable storage failure", async () => {
    const fetchSpy = recordingFetch(503);
    await expect(
      putArtifact("raw", utf8("x"), { contentType: "text/plain" }),
    ).rejects.toBeInstanceOf(EvidenceStorageUnavailableError);
    expect(fetchSpy.requests.length).toBeGreaterThan(1);
  });

  test("a 429 that clears on retry succeeds", async () => {
    const fetchSpy = recordingFetch(429, 200);
    await expect(
      putArtifact("plans", utf8("p"), { contentType: "application/json" }),
    ).resolves.toMatchObject({ created: true });
    expect(fetchSpy.requests).toHaveLength(2);
  });

  test("a network failure or timeout is a retryable storage failure", async () => {
    recordingFetch(new TypeError("fetch failed"));
    await expect(
      putArtifact("raw", utf8("x"), { contentType: "text/plain" }),
    ).rejects.toBeInstanceOf(EvidenceStorageUnavailableError);
    recordingFetch(new DOMException("The operation timed out.", "TimeoutError"));
    await expect(
      putArtifact("raw", utf8("x"), { contentType: "text/plain" }),
    ).rejects.toBeInstanceOf(EvidenceStorageUnavailableError);
  });

  test("a rejected request (bad credentials) is not a storage outage", async () => {
    recordingFetch(403);
    const failure = putArtifact("raw", utf8("x"), { contentType: "text/plain" });
    await expect(failure).rejects.toThrow(/R2 PUT rr-evidence-preview\/raw\/[0-9a-f]{64}: 403/);
    await expect(failure).rejects.not.toBeInstanceOf(EvidenceStorageUnavailableError);
  });

  test("fails with the missing variable before any request", async () => {
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "");
    const fetchSpy = recordingFetch(201);
    await expect(putArtifact("raw", utf8("x"), { contentType: "text/plain" })).rejects.toThrow(
      /R2_SECRET_ACCESS_KEY \(missing\)/,
    );
    expect(fetchSpy.requests).toHaveLength(0);
  });
});

describe("getArtifact", () => {
  const bytes = utf8('{"answer":"ok"}');
  const sha256 = sha256Of(bytes);

  test("reads the decoded body through the S3 API and checks its digest", async () => {
    const fetchSpy = recordingFetch(new Response(bytes, { status: 200 }));
    expect(await getArtifact("raw", sha256)).toEqual(bytes);
    expect(fetchSpy.lastRequest.method).toBe("GET");
    expect(fetchSpy.lastRequest.url).toBe(`${R2}/rr-evidence-preview/raw/${sha256}`);
  });

  test("reads private kinds from the internal bucket", async () => {
    const fetchSpy = recordingFetch(new Response(bytes, { status: 200 }));
    await getArtifact("extractions", sha256);
    expect(fetchSpy.lastRequest.url).toBe(`${R2}/rr-internal-preview/extractions/${sha256}`);
  });

  test("returns null for a missing object", async () => {
    recordingFetch(404);
    expect(await getArtifact("raw", sha256)).toBeNull();
  });

  test("getArtifact rejects bytes whose digest does not match the key", async () => {
    recordingFetch(new Response(utf8("tampered"), { status: 200 }));
    expect(await getArtifact("raw", sha256)).toBeNull();
    expect(log.error).toHaveBeenCalledWith("evidence.artifact.digest_mismatch", {
      kind: "raw",
      sha256,
    });
  });

  test("a malformed digest is invalid input and never reaches R2", async () => {
    const fetchSpy = recordingFetch(200);
    await expect(getArtifact("raw", "../raw/x")).rejects.toBeInstanceOf(InvalidInputError);
    await expect(deleteArtifact("raw", "AB".repeat(32))).rejects.toBeInstanceOf(InvalidInputError);
    expect(() => artifactUrl("raw", "ab")).toThrow(InvalidInputError);
    expect(fetchSpy.requests).toHaveLength(0);
  });

  test("a body that breaks off mid-read is a retryable storage failure", async () => {
    const broken = new ReadableStream({
      pull(controller) {
        controller.error(new TypeError("terminated"));
      },
    });
    recordingFetch(new Response(broken, { status: 200 }));
    await expect(getArtifact("raw", sha256)).rejects.toBeInstanceOf(
      EvidenceStorageUnavailableError,
    );
  });
});

describe("artifactUrl and deleteArtifact", () => {
  test("public kinds are served from the artifacts domain", () => {
    const sha256 = "ab".repeat(32);
    expect(artifactUrl("envelopes", sha256)).toBe(
      `https://ev-preview.reranker.co/envelopes/${sha256}`,
    );
  });

  test("deletes the object from its bucket, and an absent one is not an error", async () => {
    const sha256 = "cd".repeat(32);
    const fetchSpy = recordingFetch(204, 404);
    await deleteArtifact("raw", sha256);
    expect(fetchSpy.lastRequest).toMatchObject({
      method: "DELETE",
      url: `${R2}/rr-evidence-preview/raw/${sha256}`,
    });
    await expect(deleteArtifact("extractions", sha256)).resolves.toBeUndefined();
    expect(fetchSpy.lastRequest.url).toBe(`${R2}/rr-internal-preview/extractions/${sha256}`);
  });
});

describe("log objects", () => {
  test("an immutable tile is written once, uncompressed, with a year-long cache", async () => {
    const fetchSpy = recordingFetch(200, 412);
    const tile = new Uint8Array(32).fill(1);
    await putLogObject("tile/0/000", tile, {
      immutable: true,
      contentType: "application/octet-stream",
    });
    expect(fetchSpy.lastRequest.url).toBe(`${R2}/rr-log-preview/tile/0/000`);
    expect(fetchSpy.lastRequest.body).toEqual(tile);
    expect(fetchSpy.lastRequest.headers).toMatchObject({
      "cache-control": "public, max-age=31536000, immutable",
      "if-none-match": "*",
    });
    expect(fetchSpy.lastRequest.headers["content-encoding"]).toBeUndefined();
    await expect(
      putLogObject("tile/0/000", tile, {
        immutable: true,
        contentType: "application/octet-stream",
      }),
    ).resolves.toBeUndefined();
  });

  test("the checkpoint is overwritten and revalidated on every read", async () => {
    const fetchSpy = recordingFetch(200);
    await putLogObject("checkpoint", utf8("note"), {
      immutable: false,
      contentType: "text/plain; charset=utf-8",
    });
    expect(fetchSpy.lastRequest.headers["cache-control"]).toBe("no-cache");
    expect(fetchSpy.lastRequest.headers["if-none-match"]).toBeUndefined();
  });

  test("a mutable object refuses nothing: 412 there is an error", async () => {
    recordingFetch(412);
    await expect(
      putLogObject("checkpoint", utf8("note"), { immutable: false, contentType: "text/plain" }),
    ).rejects.toThrow(/412/);
  });

  test("reads an object back and returns null when it is absent", async () => {
    const fetchSpy = recordingFetch(new Response(utf8("note"), { status: 200 }), 404);
    expect(await getLogObject("checkpoint")).toEqual(utf8("note"));
    expect(fetchSpy.lastRequest.url).toBe(`${R2}/rr-log-preview/checkpoint`);
    expect(await getLogObject("tile/0/001")).toBeNull();
  });

  test("keys stay inside the bucket", async () => {
    const fetchSpy = recordingFetch(200);
    for (const key of ["/checkpoint", "tile/../x", "", "tile//0", "a b"]) {
      await expect(getLogObject(key)).rejects.toBeInstanceOf(InvalidInputError);
    }
    expect(fetchSpy.requests).toHaveLength(0);
  });
});
