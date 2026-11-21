import { createHash, randomInt } from "node:crypto";
import type { CanarySet, CanaryVariant } from "@reranker/catalog";
import { withSystem } from "@reranker/db";
import { measurementPlans } from "@reranker/db/schema";
import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { planCanary } from "../src/control/plan";
import { loadPlan } from "../src/measurement";
import { CONTROL_PROFILE } from "../src/openai/profile";
import { artifactJson, INTENT_SET, installCaptureHarness } from "./support/capture-harness";

vi.mock("../../evidence/src/signer", () => ({ loadSigner: vi.fn() }));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  enqueue: vi.fn(async () => ({ jobId: "evidence.integrate:test", created: true })),
}));

// The canary questions come from the frozen seed; this double has their shape: 25 local
// questions asked in Bogotá and in Medellín.
const GEOS = ["co-c1003659", "co-c1003654"] as const;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const canary: CanarySet = {
  id: "canary@3",
  version: "2026.11.0",
  intentSetId: INTENT_SET,
  geos: GEOS,
  variants: GEOS.flatMap((geoKey) =>
    Array.from({ length: 25 }, (_, i): CanaryVariant => {
      const prompt = `¿Qué clínica odontológica número ${i} me recomiendas en ${geoKey}?`;
      return {
        variantId: `pv_${sha(`${geoKey}:${i}`).slice(0, 16)}`,
        intentId: `dental_clinic.intent-${i}` as CanaryVariant["intentId"],
        paraphraseId: `dental_clinic.intent-${i}.p00`,
        personaId: null,
        format: "open_question",
        isCanonical: true,
        prompt,
        promptSha256: sha(prompt),
        geoKey,
        scope: "local",
      };
    }),
  ),
};
vi.mock("@reranker/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/catalog")>()),
  canarySet: () => canary,
}));

installCaptureHarness();

// A date of its own per test, so reruns against the same branch never find an earlier plan.
const freshDate = () => `${2100 + randomInt(800)}-0${1 + randomInt(9)}-1${randomInt(10)}`;

test("the canary plan has 3,050 slots split by lane", async () => {
  const p = await planCanary(freshDate());
  expect(p.lanes).toEqual({ api: 500, brightdata: 1000, dataforseo: 1550 });
  expect((await loadPlan(p.measurementId)).slots).toHaveLength(3050);
});

test("planning the same date twice, or three times at once, returns the same measurement", async () => {
  const date = freshDate();
  const first = await planCanary(date);
  const again = await Promise.all([planCanary(date), planCanary(date), planCanary(date)]);
  expect(again.map((p) => p.measurementId)).toEqual(Array(3).fill(first.measurementId));
  const rows = await withSystem("capture.test", (tx) =>
    tx.select().from(measurementPlans).where(eq(measurementPlans.refId, date)),
  );
  expect(rows).toHaveLength(1);
});

test("every prompt runs 10 times per engine and channel and the audit lane once", async () => {
  const { slots } = await loadPlan((await planCanary(freshDate())).measurementId);
  const counts = new Map<string, number>();
  for (const s of slots) {
    const key = `${s.engine}|${s.provider}|${s.variantId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const expected = new Map([
    ["chatgpt|openai", 10],
    ["chatgpt|brightdata", 10],
    ["perplexity|brightdata", 10],
    ["gemini|dataforseo", 10],
    ["google-ai-overview|dataforseo", 10],
    ["google-ai-mode|dataforseo", 10],
    ["chatgpt|dataforseo", 1],
  ]);
  expect(counts.size).toBe(expected.size * 50);
  for (const [key, n] of counts) {
    expect(n).toBe(expected.get(key.split("|").slice(0, 2).join("|")));
  }
  expect(slots.slice(0, 500).every((s) => s.provider === "openai")).toBe(true);
  expect(slots.at(-1)).toMatchObject({ engine: "chatgpt", provider: "dataforseo", runIndex: 0 });
  expect(new Set(slots.map((s) => s.intentSetId))).toEqual(new Set([INTENT_SET]));
});

test("the API lane declares each city, as its request does", async () => {
  const { slots } = await loadPlan((await planCanary(freshDate())).measurementId);
  const api = slots.filter((s) => s.provider === "openai");
  expect(new Set(api.map((s) => `${s.geoDeclared.level}:${s.geoDeclared.label}`))).toEqual(
    new Set(["city:Bogotá, D.C.", "city:Medellín"]),
  );
});

test("the sealed plan carries the control profile and the canary version", async () => {
  const date = freshDate();
  const { measurementId } = await planCanary(date);
  const [row] = await withSystem("capture.test", (tx) =>
    tx
      .select({ digest: measurementPlans.digest })
      .from(measurementPlans)
      .where(eq(measurementPlans.id, measurementId)),
  );
  expect(artifactJson("plans", row?.digest ?? null).meta).toEqual({
    canary: { id: "canary@3", version: "2026.11.0" },
    controlProfile: CONTROL_PROFILE,
  });
});

test("an invalid date or a drifted control profile plans nothing", async () => {
  await expect(planCanary("2026-13-45")).rejects.toThrow(/date/);
  await expect(planCanary("2026-02-30")).rejects.toThrow(/date/);
  vi.stubEnv("OPENAI_CONTROL_MODEL", "gpt-6-astra");
  await expect(planCanary(freshDate())).rejects.toThrow(/control-chatgpt@2/);
});
