import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resetAppEnv } from "@reranker/env";
import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { createBrightData } from "../../../src/brightdata/client";
import { scrapeOne } from "../../../src/brightdata/scrape";
import { RawSink } from "../../../src/raw/raw-sink";

const API = "https://api.brightdata.com";
const PERPLEXITY = "gd_m7dhdot1vw9a7gc1n";
const scrapeUrl = `${API}/datasets/v3/scrape?dataset_id=${PERPLEXITY}&format=json&include_errors=true`;
const progress = (id: string) => `${API}/datasets/v3/progress/${id}`;
const snapshot = (id: string) => `${API}/datasets/v3/snapshot/${id}?format=json`;

const input = {
  url: "https://www.perplexity.ai",
  prompt: "mejor odontólogo en Medellín",
  country: "CO",
  index: 7,
};

const utf8 = (text: string) => new TextEncoder().encode(text);

// Escaped unicode and spacing a re-serialized body would lose.
const RECORDS = utf8(
  `[{"url":"https://www.perplexity.ai","prompt":"mejor odont\\u00f3logo en Medell\\u00edn","answer_text":"Cl\\u00ednica Dental","index":7,"sources":[{"url":"https://example.co"}]}]`,
);
const SNAPSHOT = utf8(`[ {"answer_text_markdown": "**Cl\\u00ednica**", "index": 7} ]`);

type Step = [status: number, body: Uint8Array | object | string, headers?: Record<string, string>];
type Call = { method: string; url: string; body: string; authorization: string | null };

/** Answers every Bright Data call with the next scripted response, in order. */
function scripted(steps: Step[]) {
  const calls: Call[] = [];
  const queue = [...steps];
  server.use(
    http.all(`${API}/*`, async ({ request }) => {
      calls.push({
        method: request.method,
        url: request.url,
        body: await request.text(),
        authorization: request.headers.get("authorization"),
      });
      const step = queue.shift();
      if (!step) throw new Error(`unscripted call to ${request.url}`);
      const [status, body, headers = {}] = step;
      if (body instanceof Uint8Array) {
        return new HttpResponse(body, {
          status,
          headers: { "content-type": "application/json", ...headers },
        });
      }
      if (typeof body === "string") return new HttpResponse(body, { status, headers });
      return HttpResponse.json(body, { status, headers });
    }),
  );
  return calls;
}

// Advances the mocked clock, so the deadline sees the time a real wait would take.
function fakeSleep() {
  const calls: number[] = [];
  const sleep = async (ms: number) => {
    calls.push(ms);
    vi.setSystemTime(Date.now() + ms);
  };
  return Object.assign(sleep, { calls });
}

const opts = (extra: { deadline?: number; sleep?: (ms: number) => Promise<void> } = {}) => ({
  signal: new AbortController().signal,
  deadline: Date.now() + 85_000,
  sleep: fakeSleep(),
  ...extra,
});

beforeAll(() => server.listen());
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("BRIGHTDATA_API_KEY", "test-key");
  resetAppEnv();
});
afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetAppEnv();
});
afterAll(() => server.close());

test("one input per sync request with format=json and include_errors=true", async () => {
  const calls = scripted([[200, RECORDS]]);
  await scrapeOne(createBrightData(new RawSink()), "perplexity", input, opts());
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    method: "POST",
    url: scrapeUrl,
    authorization: "Bearer test-key",
  });
  expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ input: [input] });
});

test("the chatgpt dataset id comes from the environment", async () => {
  vi.stubEnv("BRIGHTDATA_CHATGPT_DATASET_ID", "gd_newchatgptversion");
  const calls = scripted([[200, RECORDS]]);
  const client = createBrightData(new RawSink());
  await scrapeOne(client, "chatgpt", { ...input, url: "https://chatgpt.com/" }, opts());
  expect(client.datasetId("chatgpt")).toBe("gd_newchatgptversion");
  expect(new URL(calls[0]?.url ?? "").searchParams.get("dataset_id")).toBe("gd_newchatgptversion");
});

test("an explicit key wins over the environment, and no key at all fails before any call", () => {
  vi.stubEnv("BRIGHTDATA_API_KEY", "");
  resetAppEnv();
  expect(() => createBrightData(new RawSink())).toThrowError(/BRIGHTDATA_API_KEY/);
  expect(createBrightData(new RawSink(), { apiKey: "ci-key" }).datasetId("perplexity")).toBe(
    PERPLEXITY,
  );
});

test("the sealed bytes equal what fetch delivered for a 200", async () => {
  scripted([[200, RECORDS]]);
  const sink = new RawSink();
  const out = await scrapeOne(createBrightData(sink), "perplexity", input, opts());
  expect(Buffer.from(sink.response ?? []).equals(Buffer.from(RECORDS))).toBe(true);
  expect(new TextDecoder().decode(sink.request ?? new Uint8Array())).toBe(
    JSON.stringify({ input: [input] }),
  );
  expect(out).toMatchObject({ kind: "response", http: 200, snapshotId: null, polls: 0 });
  expect(Buffer.from(out.kind === "response" ? out.body : []).equals(Buffer.from(RECORDS))).toBe(
    true,
  );
  expect(out).toMatchObject({ contentType: "application/json" });
});

test("202 → waits retry-after → progress running → ready → downloads the snapshot", async () => {
  const calls = scripted([
    [202, { snapshot_id: "s_1", message: "still in progress" }, { "retry-after": "10" }],
    [200, { snapshot_id: "s_1", dataset_id: PERPLEXITY, status: "running" }],
    [200, { snapshot_id: "s_1", dataset_id: PERPLEXITY, status: "ready" }],
    [200, SNAPSHOT],
  ]);
  const sleep = fakeSleep();
  const sink = new RawSink();
  const out = await scrapeOne(createBrightData(sink), "perplexity", input, opts({ sleep }));
  expect(sleep.calls).toEqual([10_000, 10_000]);
  expect(calls.map((c) => c.url)).toEqual([
    scrapeUrl,
    progress("s_1"),
    progress("s_1"),
    snapshot("s_1"),
  ]);
  expect(calls.slice(1).every((c) => c.authorization === "Bearer test-key")).toBe(true);
  expect(out).toMatchObject({ kind: "response", http: 200, snapshotId: "s_1", polls: 2 });
  // The download answers the scrape: the sink keeps the scrape request with the snapshot bytes.
  expect(Buffer.from(sink.response ?? []).equals(Buffer.from(SNAPSHOT))).toBe(true);
  expect(JSON.parse(new TextDecoder().decode(sink.request ?? new Uint8Array()))).toEqual({
    input: [input],
  });
});

test("without retry-after the poll waits Bright Data's documented 10 s", async () => {
  scripted([
    [202, { snapshot_id: "s_2" }],
    [200, { status: "starting" }],
    [200, { status: "ready" }],
    [200, SNAPSHOT],
  ]);
  const sleep = fakeSleep();
  const out = await scrapeOne(
    createBrightData(new RawSink()),
    "perplexity",
    input,
    opts({ sleep }),
  );
  expect(sleep.calls).toEqual([10_000, 10_000]);
  expect(out).toMatchObject({ kind: "response", snapshotId: "s_2" });
});

test.each([
  [202, { status: "building", message: "Snapshot is building, try again in 10s" }],
  [409, { error: "Snapshot is not ready for download" }],
])("a download answering %i is fetched again after the wait", async (status, notReady) => {
  const calls = scripted([
    [202, { snapshot_id: "s_3" }, { "retry-after": "5" }],
    [200, { status: "ready" }],
    [status, notReady],
    [200, SNAPSHOT],
  ]);
  const sleep = fakeSleep();
  const sink = new RawSink();
  const out = await scrapeOne(createBrightData(sink), "perplexity", input, opts({ sleep }));
  expect(sleep.calls).toEqual([5_000, 5_000]);
  expect(calls.map((c) => c.url).slice(2)).toEqual([snapshot("s_3"), snapshot("s_3")]);
  expect(out).toMatchObject({ kind: "response", http: 200, snapshotId: "s_3", polls: 2 });
  expect(Buffer.from(sink.response ?? []).equals(Buffer.from(SNAPSHOT))).toBe(true);
});

test("deadline before ready returns pending with the snapshot id and never polls past it", async () => {
  const calls = scripted([
    [202, { snapshot_id: "s_4" }, { "retry-after": "10" }],
    [200, { status: "running" }],
    [200, { status: "running" }],
  ]);
  const sleep = fakeSleep();
  const sink = new RawSink();
  const out = await scrapeOne(
    createBrightData(sink),
    "perplexity",
    input,
    opts({ sleep, deadline: Date.now() + 25_000 }),
  );
  expect(out).toEqual({ kind: "pending", snapshotId: "s_4", polls: 2 });
  expect(sleep.calls).toEqual([10_000, 10_000]);
  expect(calls).toHaveLength(3);
  // The 202 stays as the recorded response: it carries the id a later pickup needs.
  expect(JSON.parse(new TextDecoder().decode(sink.response ?? new Uint8Array()))).toMatchObject({
    snapshot_id: "s_4",
  });
  expect(sink.status).toBe(202);
});

test("progress status failed returns the failure body for classification", async () => {
  const failed = utf8(
    `{"snapshot_id":"s_5","dataset_id":"${PERPLEXITY}","status":"failed","error_message":"Snapshot is empty"}`,
  );
  scripted([
    [202, { snapshot_id: "s_5" }, { "retry-after": "10" }],
    [200, failed],
  ]);
  const sink = new RawSink();
  const out = await scrapeOne(createBrightData(sink), "perplexity", input, opts());
  expect(out).toMatchObject({ kind: "response", http: 200, snapshotId: "s_5", polls: 1 });
  expect(Buffer.from(out.kind === "response" ? out.body : []).equals(Buffer.from(failed))).toBe(
    true,
  );
  expect(Buffer.from(sink.response ?? []).equals(Buffer.from(failed))).toBe(true);
});

test("an error on a progress poll comes back with its status and the snapshot id", async () => {
  scripted([
    [202, { snapshot_id: "s_6" }, { "retry-after": "10" }],
    [500, "Internal server error", { "content-type": "text/plain" }],
  ]);
  const out = await scrapeOne(createBrightData(new RawSink()), "perplexity", input, opts());
  expect(out).toMatchObject({ kind: "response", http: 500, snapshotId: "s_6", polls: 1 });
  expect(out).toMatchObject({ contentType: "text/plain" });
});

test.each([
  [401, "Invalid credentials"],
  [429, "You have too many running jobs for this dataset"],
  [400, '{"error":"Invalid input provided","code":"validation_error"}'],
])("a %i on the scrape comes back untouched for classification", async (status, text) => {
  scripted([[status, text, { "content-type": "text/plain" }]]);
  const sink = new RawSink();
  const out = await scrapeOne(createBrightData(sink), "perplexity", input, opts());
  expect(out).toMatchObject({ kind: "response", http: status, snapshotId: null, polls: 0 });
  expect(new TextDecoder().decode(out.kind === "response" ? out.body : undefined)).toBe(text);
  expect(sink.status).toBe(status);
});

test("a 202 without a snapshot id is returned as is, never polled", async () => {
  const calls = scripted([[202, { message: "still in progress" }]]);
  const out = await scrapeOne(createBrightData(new RawSink()), "perplexity", input, opts());
  expect(out).toMatchObject({ kind: "response", http: 202, snapshotId: null, polls: 0 });
  expect(calls).toHaveLength(1);
});

test("an aborted signal stops the scrape before any further call", async () => {
  const calls = scripted([[202, { snapshot_id: "s_7" }, { "retry-after": "10" }]]);
  const controller = new AbortController();
  const sleep = async () => {
    controller.abort(new Error("step ended"));
  };
  await expect(
    scrapeOne(createBrightData(new RawSink()), "perplexity", input, {
      ...opts({ sleep }),
      signal: controller.signal,
    }),
  ).rejects.toThrowError("step ended");
  expect(calls).toHaveLength(1);
});

// Real bodies from a scrape that outlasted the synchronous minute: Bright Data sent the prompt
// 11 minutes after the request, and the progress reports the 708 s the job took in all.
test("a recorded ready progress body leads to the snapshot download", async () => {
  const fixture = (name: string) =>
    new Uint8Array(
      readFileSync(new URL(`../../fixtures/recorded/brightdata/${name}`, import.meta.url)),
    );
  const progressBody = fixture("chatgpt-dentistas-medellin.progress.json");
  const records = new Uint8Array(gunzipSync(fixture("chatgpt-dentistas-medellin.json.gz")));
  scripted([
    [202, { snapshot_id: "sd_mwpb26232aemrsqjjy" }, { "retry-after": "10" }],
    [200, progressBody],
    [200, records],
  ]);
  const sink = new RawSink();
  const out = await scrapeOne(createBrightData(sink), "chatgpt", input, opts());
  expect(out).toMatchObject({ kind: "response", http: 200, snapshotId: "sd_mwpb26232aemrsqjjy" });
  expect(Buffer.from(sink.response ?? []).equals(Buffer.from(records))).toBe(true);
});
