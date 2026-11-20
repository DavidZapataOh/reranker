import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { endPools } from "@reranker/db";
import { releaseSpend, reserveSpend, settleSpend } from "@reranker/jobs";
import { requireEnv } from "@reranker/testing/env";
import type {
  Response as OpenAIResponse,
  ResponseCreateParamsNonStreaming,
} from "openai/resources/responses/responses";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { callControl, createOpenAIControl } from "../../src/openai/client";
import { CONTROL_RESERVE, costFromUsage } from "../../src/openai/cost";
import { RawSink } from "../../src/raw/raw-sink";

// Each run rewrites the recording, which the client and parser tests replay as real wire bytes.
const RECORDED = new URL("../fixtures/recorded/openai/", import.meta.url);

// The control profile, asked from Medellín.
const params: ResponseCreateParamsNonStreaming = {
  model: "gpt-6.1-terra",
  input: "¿Qué odontólogo me recomiendas en Medellín?",
  store: false,
  max_output_tokens: 1200,
  tool_choice: "required",
  include: ["web_search_call.action.sources"],
  reasoning: { effort: "low" },
  tools: [
    {
      type: "web_search_2025_08_26",
      search_context_size: "medium",
      user_location: {
        type: "approximate",
        country: "CO",
        city: "Medellín",
        region: "Antioquia",
        timezone: "America/Bogota",
      },
    },
  ],
};

beforeAll(() => {
  // The env helpers read APP_ENV, which the contract job does not set.
  vi.stubEnv("APP_ENV", process.env.APP_ENV || "development");
  mkdirSync(RECORDED, { recursive: true });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await endPools();
});

function searchesIn(response: OpenAIResponse): number {
  return response.output.filter(
    (item) => item.type === "web_search_call" && item.action?.type === "search",
  ).length;
}

// One searched answer per run, a few US cents at most, reserved under the contract-test cap.
test("a control call from Medellín searches, cites and keeps its exact bytes", async () => {
  const reservation = await reserveSpend({
    provider: "openai",
    estimate: CONTROL_RESERVE,
    purpose: "contract-test",
    refType: "openai-control-contract",
    refId: randomUUID(),
  });
  const sink = new RawSink();
  const client = createOpenAIControl(sink, { apiKey: requireEnv("OPENAI_API_KEY_CI") });
  // Nothing was billed without a response; once one arrives, its usage settles the call.
  const { response, bytes } = await callControl(client, params).catch(async (error: unknown) => {
    await releaseSpend(reservation);
    throw error;
  });
  const body = JSON.parse(Buffer.from(bytes).toString()) as OpenAIResponse;
  await settleSpend(
    reservation,
    body.usage ? costFromUsage(body.usage, searchesIn(body), body.model) : CONTROL_RESERVE,
  );

  writeFileSync(new URL("control-medellin.json", RECORDED), bytes);
  writeFileSync(
    new URL("control-medellin.request.json", RECORDED),
    sink.request ?? new Uint8Array(),
  );
  const headers = {
    "content-type": response.headers.get("content-type"),
    "x-request-id": response.headers.get("x-request-id"),
    "openai-processing-ms": response.headers.get("openai-processing-ms"),
  };
  writeFileSync(
    new URL("control-medellin.headers.json", RECORDED),
    `${JSON.stringify(headers, null, 2)}\n`,
  );

  expect(Buffer.from(bytes).equals(Buffer.from(sink.response ?? []))).toBe(true);
  expect(JSON.parse(Buffer.from(sink.request ?? []).toString())).toEqual(params);
  expect(headers["x-request-id"]).toMatch(/\S/);
  expect(Number(headers["openai-processing-ms"])).toBeGreaterThan(0);
  expect(body.status).toBe("completed");
  expect(body.model).not.toBe("");
  expect(body.usage?.input_tokens).toBeGreaterThan(0);
  expect(searchesIn(body)).toBeGreaterThanOrEqual(1);
  const annotations = body.output.flatMap((item) =>
    item.type === "message"
      ? item.content.flatMap((part) => (part.type === "output_text" ? part.annotations : []))
      : [],
  );
  expect(annotations.some((a) => a.type === "url_citation")).toBe(true);
}, 90_000);
