import * as z from "zod/mini";
import type { CaptureId } from "./ids";
import { captureIdSchema, sha256Hex } from "./schema";

export const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";

export const PREDICATE = {
  capture: "https://reranker.co/attestations/ai-answer-capture/v1",
  normalization: "https://reranker.co/attestations/ai-answer-normalization/v1",
  plan: "https://reranker.co/attestations/measurement-plan/v1",
  keyAnnouncement: "https://reranker.co/attestations/key-announcement/v1",
} as const;

/** `digest.sha256` is lowercase hex. */
export interface ResourceDescriptor {
  name: string;
  digest: { sha256: string };
}

export interface InTotoStatement<T extends string, P> {
  _type: typeof IN_TOTO_STATEMENT_V1;
  subject: ResourceDescriptor[];
  predicateType: T;
  predicate: P;
}

/** Fields V0 cannot fill yet are `null`, so later sources do not need a v2 predicate. */
export interface CapturePredicateV1 {
  capture_id: CaptureId;
  plan: { digest: { sha256: string }; slot: number; attempt: number } | null;
  prompt: {
    set_version: string;
    set_root: string;
    intent_id: string;
    paraphrase_id: string;
    persona_id: string | null;
    lang: string;
    text: string;
  };
  engine: {
    name: string;
    surface: string;
    channel: string;
    vendor: string | null;
    vendor_task_id: string | null;
    endpoint: string;
    model_reported: string | null;
    mode: string | null;
    tool_version: string | null;
    fan_out_queries: string[] | null;
  };
  params: { force_web_search: boolean | null; temperature: number | null };
  geo: {
    declared: {
      country: string;
      region: string | null;
      city: string | null;
      vendor_location_code: number | null;
    };
    egress: null;
  };
  session: { state: string; fresh: boolean };
  time: { worker_utc: string; roughtime: null; not_before: null };
  provider_signature: null;
  tlsn: null;
  c2pa: null;
  worker: { id: string; image_digest: string };
}

export type CaptureStatementV1 = InTotoStatement<typeof PREDICATE.capture, CapturePredicateV1>;

const CAPTURE_SUBJECTS = ["raw", "request", "normalized"] as const;

const text = z.string().check(z.minLength(1));
const count = z.int().check(z.nonnegative());

const captureSubject = z
  .array(
    z.strictObject({
      name: z.enum(CAPTURE_SUBJECTS),
      digest: z.strictObject({ sha256: sha256Hex }),
    }),
  )
  .check(
    z.refine((subject) => {
      const names = subject.map((s) => s.name);
      return (
        new Set(names).size === names.length && names.includes("raw") && names.includes("request")
      );
    }, "subject needs unique names, including raw and request"),
  );

const capturePredicate = z.strictObject({
  capture_id: captureIdSchema,
  plan: z.nullable(
    z.strictObject({ digest: z.strictObject({ sha256: sha256Hex }), slot: count, attempt: count }),
  ),
  prompt: z.strictObject({
    set_version: text,
    set_root: sha256Hex,
    intent_id: text,
    paraphrase_id: text,
    persona_id: z.nullable(text),
    lang: text,
    text,
  }),
  engine: z.strictObject({
    name: text,
    surface: text,
    channel: text,
    vendor: z.nullable(text),
    vendor_task_id: z.nullable(text),
    endpoint: text,
    model_reported: z.nullable(text),
    mode: z.nullable(text),
    tool_version: z.nullable(text),
    fan_out_queries: z.nullable(z.array(z.string())),
  }),
  params: z.strictObject({
    force_web_search: z.nullable(z.boolean()),
    temperature: z.nullable(z.number()),
  }),
  geo: z.strictObject({
    declared: z.strictObject({
      country: z.string().check(z.regex(/^[A-Z]{2}$/)),
      region: z.nullable(text),
      city: z.nullable(text),
      vendor_location_code: z.nullable(z.int()),
    }),
    egress: z.null(),
  }),
  session: z.strictObject({ state: text, fresh: z.boolean() }),
  time: z.strictObject({ worker_utc: z.iso.datetime(), roughtime: z.null(), not_before: z.null() }),
  provider_signature: z.null(),
  tlsn: z.null(),
  c2pa: z.null(),
  worker: z.strictObject({
    id: text,
    // A container image digest, or the git commit a serverless deployment was built from.
    image_digest: z.string().check(z.regex(/^(sha256:[0-9a-f]{64}|git:[0-9a-f]{40})$/)),
  }),
});

export const CaptureStatementV1Schema: z.ZodMiniType<CaptureStatementV1> = z.strictObject({
  _type: z.literal(IN_TOTO_STATEMENT_V1),
  subject: captureSubject,
  predicateType: z.literal(PREDICATE.capture),
  predicate: capturePredicate,
});
