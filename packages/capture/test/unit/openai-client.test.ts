import { readFileSync } from "node:fs";
import { resetAppEnv } from "@reranker/env";
import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { InternalServerError } from "openai";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { callControl, createOpenAIControl } from "../../src/openai/client";
import { RawSink } from "../../src/raw/raw-sink";

const RESPONSES = "https://api.openai.com/v1/responses";
const API_KEY = "sk-control-unit";
const recorded = (name: string) =>
  readFileSync(new URL(`../fixtures/recorded/openai/${name}`, import.meta.url));

// Bytes and headers of a real control call, recorded by the contract test.
const WIRE = recorded("control-medellin.json");
const WIRE_HEADERS = JSON.parse(recorded("control-medellin.headers.json").toString()) as Record<
  string,
  string
>;
const params = JSON.parse(
  recorded("control-medellin.request.json").toString(),
) as ResponseCreateParamsNonStreaming;

function serve(status: number, body: Uint8Array | string, headers: Record<string, string>) {
  const seen: { authorization: string | null; body: string }[] = [];
  server.use(
    http.post(RESPONSES, async ({ request }) => {
      seen.push({
        authorization: request.headers.get("authorization"),
        body: await request.text(),
      });
      return new HttpResponse(body, { status, headers });
    }),
  );
  return seen;
}

beforeAll(() => server.listen());
beforeEach(() => {
  vi.stubEnv("APP_ENV", "development");
  resetAppEnv();
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
  resetAppEnv();
});
afterAll(() => server.close());

test("bytes from asResponse equal the wire bytes and parse to the recorded object", async () => {
  serve(200, WIRE, WIRE_HEADERS);
  const sink = new RawSink();
  const { response, bytes } = await callControl(
    createOpenAIControl(sink, { apiKey: API_KEY }),
    params,
  );
  expect(Buffer.from(bytes).equals(WIRE)).toBe(true);
  expect(Buffer.from(bytes).equals(Buffer.from(sink.response ?? []))).toBe(true);
  expect(JSON.parse(Buffer.from(bytes).toString())).toEqual(JSON.parse(WIRE.toString()));
  expect(response.headers.get("x-request-id")).toBe(WIRE_HEADERS["x-request-id"]);
  expect(sink.headers?.get("openai-processing-ms")).toBe(WIRE_HEADERS["openai-processing-ms"]);
});

test("the sealed request carries user_location and tool_choice required", async () => {
  const seen = serve(200, WIRE, WIRE_HEADERS);
  const sink = new RawSink();
  await callControl(createOpenAIControl(sink, { apiKey: API_KEY }), params);
  const sealed = JSON.parse(Buffer.from(sink.request ?? []).toString());
  expect(sealed).toEqual(params);
  expect(sealed).toMatchObject({
    tool_choice: "required",
    tools: [{ user_location: { type: "approximate", country: "CO", city: "Medellín" } }],
  });
  expect(seen).toEqual([
    { authorization: `Bearer ${API_KEY}`, body: Buffer.from(sink.request ?? []).toString() },
  ]);
  expect(sink.url).toBe(RESPONSES);
});

test("the client never retries on its own", async () => {
  const seen = serve(500, JSON.stringify({ error: { message: "boom", type: "server_error" } }), {
    "content-type": "application/json",
  });
  const sink = new RawSink();
  await expect(
    callControl(createOpenAIControl(sink, { apiKey: API_KEY }), params),
  ).rejects.toBeInstanceOf(InternalServerError);
  expect(seen).toHaveLength(1);
  expect(sink.calls).toBe(1);
  expect(sink.status).toBe(500);
});

test("the client waits 90 s at most and leaves retries to the capture step", () => {
  const client = createOpenAIControl(new RawSink(), { apiKey: API_KEY });
  expect(client.timeout).toBe(90_000);
  expect(client.maxRetries).toBe(0);
});

test("the key comes from OPENAI_CONTROL_API_KEY and its absence is refused", async () => {
  expect(() => createOpenAIControl(new RawSink())).toThrowError(/OPENAI_CONTROL_API_KEY/);
  vi.stubEnv("OPENAI_CONTROL_API_KEY", API_KEY);
  resetAppEnv();
  const seen = serve(200, WIRE, WIRE_HEADERS);
  await callControl(createOpenAIControl(new RawSink()), params);
  expect(seen[0]?.authorization).toBe(`Bearer ${API_KEY}`);
});
