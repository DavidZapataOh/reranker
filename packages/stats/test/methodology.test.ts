import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import canonicalize from "canonicalize";
import { describe, expect, test } from "vitest";
import { MethodologySchema, methodology, seedFor } from "../src/methodology";

async function readMethodologyFile(): Promise<Record<string, unknown>> {
  const url = new URL("../methodology/2026.11.2.json", import.meta.url);
  return JSON.parse(await readFile(url, "utf8"));
}

describe("methodology", () => {
  test("values are the published ones", () => {
    expect(methodology).toMatchObject({
      version: "2026.11.2",
      confidenceLevel: 0.95,
      levelCuts: [10, 40, 70],
      positionDiscount: 0.9,
      mcDraws: 4000,
      tie: { ahead: 0.8, behind: 0.2 },
      sufficiency: { sufficient: 8, orientative: 15 },
      engineMinValid: 20,
      plannedPerEngine: 40,
      rho: { prior: 0.26, floor: 0.1 },
      fullIntervalTopN: 10,
      competitorsShown: 5,
      wilsonDivergencePts: 3,
      weights: { engines: "equal", intents: "demandWeight", languages: "searchShare" },
      secondaryLanguage: { sampleFloor: 0.5 },
      citations: { topDomains: 10 },
    });
  });

  test("hash is sha256 of the JCS form of the file", async () => {
    const json = await readMethodologyFile();
    const expected = createHash("sha256")
      .update(canonicalize(json) ?? "")
      .digest("hex");
    expect(methodology.hash).toBe(expected);
    expect(methodology.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the file validates against the methodology schema", async () => {
    const json = await readMethodologyFile();
    expect(MethodologySchema.safeParse(json).success).toBe(true);
  });

  test("the schema rejects unknown keys and changed values", async () => {
    const json = await readMethodologyFile();
    expect(MethodologySchema.safeParse({ ...json, extra: 1 }).success).toBe(false);
    expect(MethodologySchema.safeParse({ ...json, mcDraws: 1000 }).success).toBe(false);
    expect(
      MethodologySchema.safeParse({ ...json, tie: { ahead: 0.8, behind: 0.2, margin: 0 } }).success,
    ).toBe(false);
  });

  test("is frozen", () => {
    expect(Object.isFrozen(methodology)).toBe(true);
  });
});

describe("seedFor", () => {
  test("is order and boundary sensitive", () => {
    expect(seedFor("r1", "h", "place:a")).not.toBe(seedFor("r1h", "", "place:a"));
    expect(seedFor("a", "b")).not.toBe(seedFor("b", "a"));
    expect(seedFor("r1", "h", "place:a")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is the sha256 of the parts joined by U+0000", () => {
    const expected = createHash("sha256").update("r1\u0000h\u0000place:a").digest("hex");
    expect(seedFor("r1", "h", "place:a")).toBe(expected);
  });

  test("is deterministic", () => {
    expect(seedFor("r1", methodology.hash, "place:a")).toBe(
      seedFor("r1", methodology.hash, "place:a"),
    );
  });
});
