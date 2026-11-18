import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { EngineAnswer } from "@reranker/capture";
import { endPools, withSystem } from "@reranker/db";
import { putArtifact } from "@reranker/evidence";
import { costOf } from "@reranker/jobs";
import { server } from "@reranker/testing/msw";
import { sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { currentExtractorConfig } from "../src/config";
import { extractResponse, type RawCapture } from "../src/extract";

// R2 is exercised by the evidence contract tests; here it is an in-memory bucket.
const bucket = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock("@reranker/evidence", async () => {
  const { createHash: hash } = await import("node:crypto");
  return {
    putArtifact: vi.fn(async (kind: string, bytes: Uint8Array) => {
      const sha256 = hash("sha256").update(bytes).digest("hex");
      bucket.set(`${kind}/${sha256}`, bytes);
      return { sha256, created: true };
    }),
    getArtifact: vi.fn(
      async (kind: string, sha256: string) => bucket.get(`${kind}/${sha256}`) ?? null,
    ),
  };
});
vi.mock("@reranker/flags", () => ({ isEnabled: async () => true }));

const OPENAI_URL = "https://api.openai.com/v1/responses";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1/interactions";
const fixture = (path: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${path}.json`, import.meta.url), "utf8"));

let llmCalls = 0;
const agreed = {
  openai: (): unknown => fixture("openai/completed"),
  gemini: (): unknown => fixture("gemini/completed"),
};
const replies = { ...agreed };
beforeAll(() => {
  process.env.APP_ENV ??= "development";
  vi.stubEnv("OPENAI_API_KEY", "sk-int-openai");
  vi.stubEnv("GEMINI_API_KEY", "gemini-int-key");
  vi.stubEnv("ENTITY_NAME_HMAC_KEY", randomBytes(32).toString("base64url"));
  server.listen();
  server.use(
    http.post(OPENAI_URL, () => {
      llmCalls += 1;
      return HttpResponse.json(replies.openai() as Record<string, unknown>);
    }),
    http.post(GEMINI_URL, () => {
      llmCalls += 1;
      return HttpResponse.json(replies.gemini() as Record<string, unknown>);
    }),
  );
});
afterEach(() => {
  llmCalls = 0;
  Object.assign(replies, agreed);
});
afterAll(async () => {
  server.close();
  vi.unstubAllEnvs();
  await endPools();
});

const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");

async function seededCapture(): Promise<RawCapture> {
  const id = `cap_${randomBytes(13).toString("hex").toUpperCase()}`;
  await withSystem("extraction.test", async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(
      sql`insert into public_panel.measurement_plans (purpose, ref_type, ref_id, digest, slot_count)
          values ('contract-test', 'probe', ${randomUUID()}, ${Buffer.from(hex(id), "hex")}, 1)
          returning id`,
    );
    await tx.execute(
      sql`insert into public_panel.captures (id, measurement_id, slot_index, attempt, intent_set_id,
            intent_id, engine, channel, provider, mode, status, response_bytes, latency_ms,
            cost_amount_micros, cost_currency, envelope_sha256)
          values (${id}, ${rows[0]?.id}, 0, 1, 'is_0123456789abcdef',
            'odontologia.blanqueamiento-dental', 'chatgpt', 'ui-vendor', 'dataforseo', 'live',
            'succeeded', 1024, 900, 4000, 'USD', ${Buffer.from(hex(`envelope:${id}`), "hex")})`,
    );
  });
  const answer = {
    present: true,
    markdown:
      "Te recomiendo la Clínica Dental Sonrisa Paisa en El Poblado; también puedes mirar Doctoralia.",
  } as EngineAnswer;
  return {
    capture: {
      id,
      engine: "chatgpt",
      channel: "ui-vendor",
      status: "succeeded",
      modelReported: null,
      slotId: `slot-${id}`,
    },
    answer,
  };
}

const ctx = {
  spend: { purpose: "contract-test" as const, refType: "extraction-int", refId: randomUUID() },
};

test("retrying after the row was written reads it back and spends nothing", async () => {
  const capture = await seededCapture();
  const first = await extractResponse(capture, ctx);
  const second = await extractResponse(capture, ctx);
  expect(second).toEqual(first);
  expect(llmCalls).toBe(2);
  expect(first).toMatchObject({ answerKind: "names_entities", agreement: "agreed" });
});

test("raw outputs go to the private extractions kind and only their digest to Postgres", async () => {
  const capture = await seededCapture();
  await extractResponse(capture, ctx);
  const { rows } = await withSystem("extraction.test", (tx) =>
    tx.execute<{ outputs: string; config: string; spent: number }>(
      sql`select encode(outputs_sha256, 'hex') as outputs, encode(config_hash, 'hex') as config,
            cost_amount_micros::int as spent
          from public_panel.extractions where capture_id = ${capture.capture.id}`,
    ),
  );
  expect(rows).toHaveLength(1);
  const row = rows[0] as { outputs: string; config: string; spent: number };
  const stored = bucket.get(`extractions/${row.outputs}`) as Uint8Array;
  expect(createHash("sha256").update(stored).digest("hex")).toBe(row.outputs);
  expect(row.config).toBe(currentExtractorConfig.configHash);
  expect(row.spent).toBeGreaterThan(0);
  expect(vi.mocked(putArtifact)).toHaveBeenCalledWith("extractions", stored, {
    contentType: "application/json",
  });
});

const withoutUsage = (body: Record<string, unknown>) => {
  const { usage: _, ...rest } = body;
  return rest;
};

test.each([
  ["both extractors answer", () => {}],
  [
    "the secondary falls back after a billed incomplete answer",
    () => {
      replies.gemini = () => fixture("gemini/incomplete");
    },
  ],
  [
    "the primary refuses without usage",
    () => {
      replies.openai = () => withoutUsage(fixture("openai/refusal"));
    },
  ],
])("the cost equals what the spend ledger settled when %s", async (_, arrange) => {
  arrange();
  const refId = randomUUID();
  const r = await extractResponse(await seededCapture(), {
    spend: { purpose: "contract-test", refType: "extraction-int", refId },
  });
  expect(r.cost.amount_micros).toBeGreaterThan(0);
  expect(r.cost).toEqual(await costOf("extraction-int", refId));
});
