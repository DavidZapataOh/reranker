import { randomUUID } from "node:crypto";
import { getGeo } from "@reranker/catalog";
import { endPools } from "@reranker/db";
import { getCountry } from "@reranker/i18n/countries";
import { releaseSpend, reserveSpend, settleSpend } from "@reranker/jobs";
import { cost } from "@reranker/schema";
import { requireEnv } from "@reranker/testing/env";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { EngineAnswer } from "../../src/answer";
import { createBrightData } from "../../src/brightdata/client";
import { ChatGptRecord, parseChatGpt } from "../../src/brightdata/parse/chatgpt";
import { scrapeOne } from "../../src/brightdata/scrape";
import { classifyResponse } from "../../src/brightdata/status";
import { RawSink } from "../../src/raw/raw-sink";

const PEREIRA = "co-c1003665";
// One record at US$1.50 per thousand, under the contract-test cap; failed records are free.
const ESTIMATE = cost(1_500, "USD");
// Recorded ChatGPT scrapes finished in 82 and 124 s, and others were still running after 234 s.
const DEADLINE_MS = 8 * 60_000;

beforeAll(() => {
  // The env helpers read APP_ENV, which the contract job does not set.
  vi.stubEnv("APP_ENV", process.env.APP_ENV || "development");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await endPools();
});

// A retry would pay for a second record and outlast the nightly job.
test("a ChatGPT answer asked from Pereira's centroid parses and keeps its exact bytes", {
  retry: 0,
  timeout: DEADLINE_MS + 60_000,
}, async () => {
  const target = getGeo(PEREIRA);
  const country = getCountry(target.country).providers.brightdata?.country;
  if (!country || !target.center) throw new Error(`${PEREIRA} has no country or centroid`);
  const geolocation = `${target.center.lat.toFixed(4)},${target.center.lng.toFixed(4)}`;
  const input = {
    url: "https://chatgpt.com/",
    prompt: "dónde comprar un colchón en Pereira",
    country,
    index: 1,
    geolocation,
  };

  const reservation = await reserveSpend({
    provider: "brightdata",
    channel: "ui-vendor",
    engine: "chatgpt",
    purpose: "contract-test",
    refType: "brightdata-contract",
    refId: randomUUID(),
    estimate: ESTIMATE,
  });
  const sink = new RawSink();
  const client = createBrightData(sink, { apiKey: requireEnv("BRIGHTDATA_API_KEY_CI") });
  const out = await scrapeOne(client, "chatgpt", input, {
    signal: AbortSignal.timeout(DEADLINE_MS),
    deadline: Date.now() + DEADLINE_MS,
  }).catch(async (error: unknown) => {
    // Once a snapshot exists Bright Data may still bill it.
    if (sink.status !== 202) await releaseSpend(reservation);
    throw error;
  });
  if (out.kind === "pending") {
    throw new Error(`snapshot ${out.snapshotId} not ready after ${out.polls} polls`);
  }
  const classified = classifyResponse(out.http, out.body, sink.headers ?? new Headers());
  if (classified.kind === "ok") await settleSpend(reservation, ESTIMATE);
  else await releaseSpend(reservation);

  expect(JSON.parse(new TextDecoder().decode(sink.request ?? new Uint8Array()))).toEqual({
    input: [input],
  });
  expect(Buffer.from(sink.response ?? []).equals(Buffer.from(out.body))).toBe(true);
  expect(classified).toMatchObject({ kind: "ok" });
  if (classified.kind !== "ok") return;
  expect(ChatGptRecord.safeParse(classified.record).success).toBe(true);
  const answer = parseChatGpt(classified.record);
  expect(EngineAnswer.parse(answer)).toEqual(answer);
  expect(answer).toMatchObject({ provider: "brightdata", engine: "chatgpt", present: true });
  expect(answer.sources.length).toBeGreaterThan(0);
});
