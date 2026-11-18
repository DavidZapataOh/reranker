import { createHash } from "node:crypto";
import { z } from "@reranker/schema";
import canonicalize from "canonicalize";
import file from "../methodology/2026.11.0.json" with { type: "json" };

export interface Methodology {
  version: "2026.11.0";
  confidenceLevel: 0.95;
  levelCuts: readonly [10, 40, 70];
  positionDiscount: 0.9;
  mcDraws: 4000;
  tie: { ahead: 0.8; behind: 0.2 };
  sufficiency: { sufficient: 8; orientative: 15 };
  engineMinValid: 20;
  plannedPerEngine: 40;
  rho: { prior: 0.26; floor: 0.1 };
  fullIntervalTopN: 10;
  competitorsShown: 5;
  wilsonDivergencePts: 3;
  weights: { engines: "equal"; intents: "demandWeight" };
}

// Literal values: a published methodology never changes in place; a change is a new version file.
export const MethodologySchema: z.ZodType<Methodology> = z.strictObject({
  version: z.literal("2026.11.0"),
  confidenceLevel: z.literal(0.95),
  levelCuts: z.tuple([z.literal(10), z.literal(40), z.literal(70)]).readonly(),
  positionDiscount: z.literal(0.9),
  mcDraws: z.literal(4000),
  tie: z.strictObject({ ahead: z.literal(0.8), behind: z.literal(0.2) }),
  sufficiency: z.strictObject({ sufficient: z.literal(8), orientative: z.literal(15) }),
  engineMinValid: z.literal(20),
  plannedPerEngine: z.literal(40),
  rho: z.strictObject({ prior: z.literal(0.26), floor: z.literal(0.1) }),
  fullIntervalTopN: z.literal(10),
  competitorsShown: z.literal(5),
  wilsonDivergencePts: z.literal(3),
  weights: z.strictObject({ engines: z.literal("equal"), intents: z.literal("demandWeight") }),
});

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// Hashed from the file as published (RFC 8785), so the hash identifies the document, not our parse.
const hash = sha256Hex(canonicalize(file) as string);

export const methodology: Readonly<Methodology & { hash: string }> = deepFreeze({
  ...MethodologySchema.parse(file),
  hash,
});

// U+0000 cannot appear in ids or hashes, so distinct part lists never collide on concatenation.
export function seedFor(...parts: string[]): string {
  return sha256Hex(parts.join("\u0000"));
}
