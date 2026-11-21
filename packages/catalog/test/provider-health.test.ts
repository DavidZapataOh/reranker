import { describe, expect, test, vi } from "vitest";
import { buildCategory } from "../scripts/build-seed";
import { ProviderDownError, ProviderHealth } from "../scripts/provider-health";
import { reviewCategory } from "../scripts/review-native";
import { seedCategories } from "../src/categories";
import type { Candidate } from "../src/generate/guards";
import type { ReviewRequest } from "../src/generate/providers";
import { categoryPool } from "./fixtures/seed-pool";

const fail = (reason: string) => ({ ok: false as const, reason });

describe("provider health", () => {
  test("a provider whose first calls all fail is down, with its last error", () => {
    const health = new ProviderHealth();
    for (let i = 0; i < 3; i++) health.record("gemini", fail("ProviderRejected: quota_exceeded"));
    expect(() => health.record("gemini", fail("ProviderRejected: quota_exceeded"))).toThrow(
      new ProviderDownError("gemini", "ProviderRejected: quota_exceeded", "4 calls, none usable"),
    );
  });

  test("one answer at the start keeps it up; too many failures in the window bring it down", () => {
    const health = new ProviderHealth();
    health.record("openai", { ok: true });
    for (let i = 0; i < 10; i++) health.record("openai", fail("timeout"));
    for (let i = 0; i < 9; i++) health.record("openai", { ok: true });
    expect(() => health.record("openai", fail("timeout"))).toThrow(
      /11 of the last 20 calls failed/,
    );
  });

  test("occasional failures never stop a run", () => {
    const health = new ProviderHealth();
    for (let i = 0; i < 100; i++) health.record("gemini", i % 4 === 0 ? fail("x") : { ok: true });
  });
});

describe("seed runs fail closed", () => {
  const spend = { purpose: "benchmark" as const, refType: "test", refId: "t" };
  const dental = seedCategories().find((c) => c.key === "dental_clinic");
  if (!dental) throw new Error("no dental category");

  test("a build stops when one provider writes nothing, so no pool lacks it", async () => {
    let n = 0;
    const deps = {
      generate: vi.fn(async (provider: "openai" | "gemini") => {
        if (provider === "gemini") throw new Error("ProviderRejected: credit_balance_exhausted");
        const paraphrases: Candidate[] = Array.from({ length: 25 }, (_, i) => ({
          text: `¿Qué clínica odontológica ${n++}-${i} me recomiendas en {lugar}?`,
          format: "keyword",
          generator: "openai",
        }));
        return { paraphrases, personas: [] };
      }),
      embed: vi.fn(async (texts: string[]) =>
        texts.map((_, i) =>
          Float32Array.from({ length: 8 }, (__, d) => (d === 0 ? 1 : i === d ? 0.5 : 0)),
        ),
      ),
      judge: vi.fn(async (_: unknown, candidates: Candidate[]) => candidates.map(() => true)),
      health: new ProviderHealth(),
    };
    await expect(
      buildCategory(dental, { language: "es", registerProfile: "co" }, spend, deps as never),
    ).rejects.toThrow(/gemini is not answering.*credit_balance_exhausted/);
  });

  test("a review stops when one reviewer fails every call", async () => {
    const review = vi.fn(async (provider: "openai" | "gemini", req: ReviewRequest) => {
      if (provider === "gemini") throw new Error("BilledFailure: MAX_TOKENS");
      return req.items.map(() => ({ keep: true, reasons: [] }));
    });
    const failures = { openai: {}, gemini: {} };
    await expect(
      reviewCategory(
        { language: "fr", registerProfile: "neutral" },
        categoryPool("hotel", "fr", "neutral"),
        spend,
        review,
        failures,
        new ProviderHealth(),
      ),
    ).rejects.toThrow(ProviderDownError);
  });
});
