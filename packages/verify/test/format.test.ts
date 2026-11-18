import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  ARTIFACTS_ORIGIN,
  BUNDLE_MEDIA_TYPE,
  type CaptureStatementV1,
  CaptureStatementV1Schema,
  type EvidenceBundleV1,
  EvidenceBundleV1Schema,
  IN_TOTO_STATEMENT_V1,
  isCaptureId,
  LOG_BASE_URL,
  LOG_ORIGIN,
  PREDICATE,
} from "../src/format/index";

function fixture(name: "statement.capture.json"): CaptureStatementV1;
function fixture(name: "bundle.v1.json"): EvidenceBundleV1;
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

describe("capture ids", () => {
  test.each(["cap_01JBX8Q2M4ZK7P6Y3V9W1T0S5R", "cap_00000000000000000000000000"])(
    "accepts %s",
    (id) => expect(isCaptureId(id)).toBe(true),
  );

  test.each([
    "cap_01JBX8Q2M4ZK7P6Y3V9W1T0S5",
    "CAP_01JBX8Q2M4ZK7P6Y3V9W1T0S5R",
    "cap_01JBX8Q2M4ZK7P6Y3V9W1T0SIL",
    "cap_01jbx8q2m4zk7p6y3v9w1t0s5r",
    "cap_01JBX8Q2M4ZK7P6Y3V9W1T0S5R\n",
    "cap_*",
  ])("rejects %j", (id) => expect(isCaptureId(id)).toBe(false));
});

describe("capture statement", () => {
  const statement = fixture("statement.capture.json");
  const parse = (value: unknown) => CaptureStatementV1Schema.safeParse(value).success;
  const withSubject = (subject: unknown) => ({ ...statement, subject });

  test("the spec example statement parses and unknown predicate fields are rejected", () => {
    expect(parse(statement)).toBe(true);
    expect(parse({ ...statement, predicate: { ...statement.predicate, extra: 1 } })).toBe(false);
  });

  test("the worker is named by an image digest or by the git commit it was built from", () => {
    const withImage = (image_digest: string) => ({
      ...statement,
      predicate: { ...statement.predicate, worker: { id: "vercel:iad1", image_digest } },
    });
    expect(parse(withImage(`git:${"a1".repeat(20)}`))).toBe(true);
    expect(parse(withImage(`git:${"a1".repeat(19)}`))).toBe(false);
    expect(parse(withImage(`git:${"A1".repeat(20)}`))).toBe(false);
    expect(parse(withImage("git:dev"))).toBe(false);
  });

  test("uses the in-toto v1 type and the capture predicate", () => {
    expect(statement._type).toBe(IN_TOTO_STATEMENT_V1);
    expect(parse({ ...statement, _type: "https://in-toto.io/Statement/v0.1" })).toBe(false);
    expect(parse({ ...statement, predicateType: PREDICATE.plan })).toBe(false);
  });

  test("rejects unknown fields in nested objects and at the top level", () => {
    const { predicate } = statement;
    expect(parse({ ...statement, extra: 1 })).toBe(false);
    expect(
      parse({ ...statement, predicate: { ...predicate, engine: { ...predicate.engine, x: 1 } } }),
    ).toBe(false);
    expect(
      parse({
        ...statement,
        predicate: { ...predicate, geo: { ...predicate.geo, egress: { asn: 1 } } },
      }),
    ).toBe(false);
  });

  test("accepts null for every field that is unavailable", () => {
    const { predicate } = statement;
    expect(
      parse({
        ...statement,
        subject: statement.subject.filter((s) => s.name !== "normalized"),
        predicate: {
          ...predicate,
          plan: null,
          prompt: { ...predicate.prompt, persona_id: null },
          engine: {
            ...predicate.engine,
            vendor: null,
            vendor_task_id: null,
            model_reported: null,
            mode: null,
            fan_out_queries: null,
          },
          params: { force_web_search: null, temperature: null },
          geo: {
            declared: { country: "CO", region: null, city: null, vendor_location_code: null },
            egress: null,
          },
        },
      }),
    ).toBe(true);
  });

  test("requires raw and request subjects with unique names and lowercase hex digests", () => {
    const [raw, request, normalized] = statement.subject;
    expect(parse(withSubject([raw, request]))).toBe(true);
    expect(parse(withSubject([raw, normalized]))).toBe(false);
    expect(parse(withSubject([request, normalized]))).toBe(false);
    expect(parse(withSubject([raw, request, raw]))).toBe(false);
    expect(parse(withSubject([raw, request, { ...normalized, name: "screenshot" }]))).toBe(false);
    expect(
      parse(
        withSubject([
          { name: "raw", digest: { sha256: raw?.digest.sha256.toUpperCase() } },
          request,
        ]),
      ),
    ).toBe(false);
    expect(parse(withSubject([{ ...raw, digest: { sha256: "ab" } }, request]))).toBe(false);
  });

  test("rejects a malformed capture id or worker time", () => {
    const { predicate } = statement;
    expect(parse({ ...statement, predicate: { ...predicate, capture_id: "cap_*" } })).toBe(false);
    expect(
      parse({
        ...statement,
        predicate: { ...predicate, time: { ...predicate.time, worker_utc: "yesterday" } },
      }),
    ).toBe(false);
  });
});

describe("evidence bundle", () => {
  const bundle = fixture("bundle.v1.json");
  const parse = (value: unknown) => EvidenceBundleV1Schema.safeParse(value).success;

  test("a bundle with an artifact URL field is rejected", () => {
    expect(parse(bundle)).toBe(true);
    expect(
      parse({
        ...bundle,
        artifacts: {
          ...bundle.artifacts,
          raw: { ...bundle.artifacts.raw, url: "https://evil.example" },
        },
      }),
    ).toBe(false);
  });

  test("an error capture without a normalized artifact still makes a valid bundle", () => {
    const { normalized: _, ...rawOnly } = bundle.artifacts;
    expect(parse({ ...bundle, artifacts: rawOnly })).toBe(true);
  });

  test("the raw artifact is mandatory", () => {
    const { raw: _, ...normalizedOnly } = bundle.artifacts;
    expect(parse({ ...bundle, artifacts: normalizedOnly })).toBe(false);
    expect(parse({ ...bundle, artifacts: {} })).toBe(false);
  });

  test("a removed artifact needs its date and reason", () => {
    const raw = bundle.artifacts.raw;
    const removed = {
      sha256: raw.sha256,
      status: "removed",
      removed_at: "2026-12-01T10:15:00Z",
      reason: "legal_order",
    };
    expect(parse({ ...bundle, artifacts: { ...bundle.artifacts, raw: removed } })).toBe(true);
    expect(
      parse({
        ...bundle,
        artifacts: { ...bundle.artifacts, raw: { ...removed, reason: "other" } },
      }),
    ).toBe(false);
    expect(
      parse({
        ...bundle,
        artifacts: { ...bundle.artifacts, raw: { sha256: raw.sha256, status: "removed" } },
      }),
    ).toBe(false);
  });

  test("accepts a bundle that is not anchored yet", () => {
    expect(parse({ ...bundle, anchors: { ots: null, tsr: [] } })).toBe(true);
    expect(
      parse({
        ...bundle,
        anchors: { ots: { status: "pending", proof: "AE9w", bitcoin_height: null }, tsr: [] },
      }),
    ).toBe(true);
  });

  test("rejects other versions, envelope types and anchor providers", () => {
    expect(parse({ ...bundle, version: 2 })).toBe(false);
    expect(
      parse({ ...bundle, envelope: { ...bundle.envelope, payloadType: "application/json" } }),
    ).toBe(false);
    expect(parse({ ...bundle, envelope: { ...bundle.envelope, signatures: [] } })).toBe(false);
    expect(
      parse({
        ...bundle,
        anchors: { ...bundle.anchors, tsr: [{ provider: "freetsa", proof: "MA==" }] },
      }),
    ).toBe(false);
    expect(parse({ ...bundle, rekor: {} })).toBe(false);
  });

  test("rejects non-base64 proof hashes and an index outside the tree", () => {
    const { inclusion } = bundle;
    expect(parse({ ...bundle, inclusion: { ...inclusion, hashes: ["not base64!"] } })).toBe(false);
    expect(parse({ ...bundle, inclusion: { ...inclusion, index: inclusion.tree_size } })).toBe(
      false,
    );
    expect(parse({ ...bundle, inclusion: { ...inclusion, index: -1 } })).toBe(false);
  });

  test("exposes the fixed origins and media type", () => {
    expect(BUNDLE_MEDIA_TYPE).toBe("application/vnd.reranker.bundle+json");
    expect(ARTIFACTS_ORIGIN).toBe("https://ev.reranker.co");
    expect(LOG_ORIGIN).toBe("log.reranker.co/captures/2026");
    expect(LOG_BASE_URL).toBe(`https://${LOG_ORIGIN}`);
    expect(bundle.inclusion.log).toBe(LOG_ORIGIN);
  });
});
