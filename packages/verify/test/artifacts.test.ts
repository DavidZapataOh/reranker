import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { expect, test, vi } from "vitest";
import { fetchArtifact, MAX_ARTIFACT_BYTES } from "../src/artifacts";

const bytes = new TextEncoder().encode('{"answer_text":"Hola"}');
const digest = bytesToHex(sha256(bytes));
const serving = (response: Response) => vi.fn(async () => response) as unknown as typeof fetch;

test("fetches from the digest's URL under the fixed origin and checks the bytes", async () => {
  const fetch = serving(new Response(bytes));
  expect(await fetchArtifact("normalized", digest, { fetch })).toEqual({
    check: { status: "pass" },
    bytes,
  });
  expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(`https://ev.reranker.co/normalized/${digest}`);
});

test("a digest that is not lowercase hex is never requested", async () => {
  const fetch = serving(new Response(bytes));
  expect(await fetchArtifact("raw", "../raw", { fetch })).toEqual({
    check: { status: "fail", detail: "invalid_digest" },
  });
  expect(fetch).not.toHaveBeenCalled();
});

test.each([
  [404, "not_found"],
  [503, "http_503"],
])("an answer %i leaves the artifact unchecked", async (status, detail) => {
  const fetch = serving(new Response("error", { status }));
  expect(await fetchArtifact("raw", digest, { fetch })).toEqual({
    check: { status: "unavailable", detail },
  });
});

test("a declared length over 2 MB fails before the body is read", async () => {
  const response = new Response(bytes, {
    headers: { "content-length": String(MAX_ARTIFACT_BYTES + 1) },
  });
  expect(await fetchArtifact("raw", digest, { fetch: serving(response) })).toEqual({
    check: { status: "fail", detail: "too_large" },
  });
});

test("an empty answer fails the digest", async () => {
  const fetch = serving(new Response(null));
  expect(await fetchArtifact("raw", digest, { fetch })).toEqual({
    check: { status: "fail", detail: "digest_mismatch" },
  });
});
