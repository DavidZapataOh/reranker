import { EngineId } from "@reranker/schema";
import { expect, test } from "vitest";
import { ENGINES } from "../../src/engines";

test("every engine has a spec keyed by its own id", () => {
  expect(Object.keys(ENGINES).sort()).toEqual([...EngineId.options].sort());
  for (const [id, spec] of Object.entries(ENGINES)) expect(spec.engine).toBe(id);
});

test("the DataForSEO engines reserve the Live and Standard list prices", () => {
  expect(ENGINES["google-ai-overview"]).toMatchObject({
    provider: "dataforseo",
    geoSupport: "city",
    channel: "ui-vendor",
  });
  for (const engine of ["gemini", "google-ai-overview", "chatgpt"] as const) {
    expect(ENGINES[engine].estimate.live).toEqual({ amount_micros: 4000, currency: "USD" });
    expect(ENGINES[engine].estimate.task).toEqual({ amount_micros: 1200, currency: "USD" });
  }
});

test("geo follows what each endpoint accepts", () => {
  expect(ENGINES.gemini.geoSupport).toBe("coordinate");
  expect(ENGINES["google-ai-overview"].geoSupport).toBe("city");
  expect(ENGINES.chatgpt.geoSupport).toBe("country");
  expect(ENGINES.perplexity).toMatchObject({ provider: "brightdata", geoSupport: "country" });
});

test("the DataForSEO engines dispatch slowest first by p50 latency", () => {
  const order = Object.values(ENGINES)
    .filter((spec) => spec.provider === "dataforseo" && spec.engine !== "chatgpt")
    .sort((a, b) => b.p50LatencyMs - a.p50LatencyMs)
    .map((spec) => spec.engine);
  expect(order).toEqual(["gemini", "google-ai-overview"]);
});
