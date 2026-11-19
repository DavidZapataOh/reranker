import { randomBytes } from "node:crypto";
import { jcs, sha256Hex } from "@reranker/catalog";
import { withSystem } from "@reranker/db";
import { captures, evidenceEntries } from "@reranker/db/schema";
import { latestNormalized, readRaw } from "@reranker/evidence";
import { InvalidInputError } from "@reranker/jobs/errors";
import type { EngineId } from "@reranker/schema";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { EngineAnswer } from "../src/answer";
import { getAnswer, listAnswers, reparse } from "../src/answers";
import { captureSlots } from "../src/capture";
import { newCaptureId, slotId } from "../src/slot";
import {
  fixture,
  frozen,
  INTENT_SET,
  installCaptureHarness,
  provider,
  r2,
  rowsOf,
  SITE,
} from "./support/capture-harness";

vi.mock("../../evidence/src/signer", () => ({ loadSigner: vi.fn() }));
vi.mock("@reranker/jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/jobs")>()),
  enqueue: vi.fn(async () => ({ jobId: "evidence.integrate:test", created: true })),
}));
vi.mock("@reranker/flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@reranker/flags")>()),
  assertCaptureAllowed: vi.fn(async () => {}),
}));

// Parsers at whatever version a test raises them to.
const versions = vi.hoisted(() => ({ gemini: 1, "google-ai-overview": 1 }));
vi.mock("../src/dataforseo/parse/gemini", async (importOriginal) => {
  const { parseGemini } = await importOriginal<typeof import("../src/dataforseo/parse/gemini")>();
  return {
    parseGemini: (bytes: Uint8Array) => ({
      ...parseGemini(bytes),
      parserVersion: `gemini@${versions.gemini}`,
    }),
  };
});
vi.mock("../src/dataforseo/parse/ai-overview", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/dataforseo/parse/ai-overview")>();
  return {
    ...original,
    parseAiOverview: (bytes: Uint8Array) => ({
      ...original.parseAiOverview(bytes),
      parserVersion: `google-ai-overview@${versions["google-ai-overview"]}`,
    }),
  };
});
beforeEach(() => Object.assign(versions, { gemini: 1, "google-ai-overview": 1 }));

// Counts the system transactions of a reason and the statements each one runs.
const counted = vi.hoisted(() => ({ reason: "", transactions: 0, statements: 0 }));
vi.mock("@reranker/db", async (importOriginal) => {
  const db = await importOriginal<typeof import("@reranker/db")>();
  const withSystem: typeof db.withSystem = (reason, fn, opts) => {
    if (reason !== counted.reason) return db.withSystem(reason, fn, opts);
    counted.transactions += 1;
    return db.withSystem(
      reason,
      (tx) =>
        fn(
          new Proxy(tx, {
            get(target, key, receiver) {
              const value = Reflect.get(target, key, receiver);
              if (typeof value !== "function") return value;
              return (...args: unknown[]) => {
                if (["execute", "select", "insert", "update", "delete"].includes(String(key))) {
                  counted.statements += 1;
                }
                return value.apply(target, args);
              };
            },
          }),
        ),
      opts,
    );
  };
  return { ...db, withSystem };
});

installCaptureHarness();

const opts = (m: string) => ({
  mode: "live" as const,
  spend: { purpose: "contract-test" as const, refType: "capture-test", refId: m },
});

async function captured(engines: EngineId[]) {
  const { m, ids } = await frozen(engines);
  await expect(captureSlots(m, ids, opts(m))).resolves.toMatchObject({ failed: [] });
  const rows = await rowsOf(m);
  return { m, ids, rows: [...rows].sort((a, b) => a.slotIndex - b.slotIndex) };
}

const urlOf = (input: unknown) => (input instanceof Request ? input.url : String(input));
const REDIRECT_HOSTS = ["google.com", "www.google.com", "vertexaisearch.cloud.google.com"];
const redirectFetches = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([input]) => REDIRECT_HOSTS.includes(new URL(urlOf(input)).hostname)).length;

const digestOf = (answer: EngineAnswer | null) => (answer === null ? null : sha256Hex(jcs(answer)));

describe("reparse", () => {
  test("raising parserVersion and reparsing derives a new answer without touching raw bytes or the row", async () => {
    // Its references come wrapped in Google redirects, resolved when it was captured.
    const { rows } = await captured(["google-ai-overview"]);
    const before = rows[0];
    if (!before) throw new Error("no capture stored");
    const id = before.id as `cap_${string}`;
    const raw = await readRaw(id);
    expect((await getAnswer(id)).parserVersion).toBe("google-ai-overview@1");

    versions["google-ai-overview"] = 2;
    const resolving = redirectFetches();
    const answer = await reparse(id);
    expect(answer.parserVersion).toBe("google-ai-overview@2");
    // Where each redirect led was established at capture time and carries over unchanged.
    expect(redirectFetches()).toBe(resolving);
    const redirected = answer.sources.filter((s) => s.url.includes("/goto?"));
    expect(redirected.length).toBeGreaterThan(0);
    expect(redirected.every((s) => s.resolvedUrl === SITE)).toBe(true);

    const [after] = await rowsOf(before.measurementId);
    expect(after).toEqual(before);
    expect(Buffer.from(await readRaw(id)).equals(Buffer.from(raw))).toBe(true);
    expect(await getAnswer(id)).toEqual(answer);
    expect(await latestNormalized(id)).toEqual({ sha256: digestOf(answer), parserVersion: 2 });

    // The same parser version again stores nothing new.
    await expect(reparse(id)).resolves.toEqual(answer);
    const entries = await withSystem("capture.test", (tx) =>
      tx.select().from(evidenceEntries).where(eq(evidenceEntries.ref, id)),
    );
    expect(entries).toHaveLength(1);
  });

  test("a capture the provider answered with an error cannot be reparsed", async () => {
    const { m, ids } = await frozen(["gemini"]);
    provider.next.push(fixture("errors/40210.bin"));
    await captureSlots(m, ids, opts(m));
    const [row] = await rowsOf(m);
    if (!row) throw new Error("no capture stored");
    await expect(reparse(row.id)).rejects.toBeInstanceOf(InvalidInputError);
  });

  test("an id that is not a capture id is rejected before any read", async () => {
    await expect(reparse("cap_nope")).rejects.toBeInstanceOf(InvalidInputError);
    await expect(getAnswer("nope")).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("listAnswers", () => {
  test("lists each succeeded capture with its newest reading; a failed parse lists with answer null", async () => {
    const unparsable = JSON.parse(
      new TextDecoder().decode(fixture("recorded/live/gemini-dentistas-medellin.json")),
    );
    unparsable.tasks[0].result = [];
    provider.next.push(new TextEncoder().encode(JSON.stringify(unparsable)));
    // The first call served is the empty Gemini result: slowest engines go first.
    const { m, ids, rows } = await captured(["gemini", "gemini", "google-ai-overview"]);
    const parsedGemini = rows.find((r) => r.engine === "gemini" && r.normalizedSha256 !== null);
    if (!parsedGemini) throw new Error("no parsed Gemini capture");
    versions.gemini = 2;
    await reparse(parsedGemini.id);

    const listed = await listAnswers(m);
    expect(listed.map((l) => l.slotId)).toEqual(ids);
    expect(listed.filter((l) => l.answer === null)).toHaveLength(1);
    expect(listed.find((l) => l.captureId === parsedGemini.id)?.answer?.parserVersion).toBe(
      "gemini@2",
    );
    for (const { captureId, slotId: id, capture, answer } of listed) {
      const row = rows.find((r) => r.id === captureId);
      expect(capture).toEqual({
        id: captureId,
        engine: row?.engine,
        channel: "ui-vendor",
        status: "succeeded",
        modelReported: row?.modelReported,
        slotId: id,
      });
      expect(digestOf(answer)).toBe(
        (await latestNormalized(captureId as `cap_${string}`))?.sha256 ?? null,
      );
    }
  });

  test("listAnswers is one query for 200 captures", async () => {
    const { m } = await frozen(["gemini"]);
    const answer = (version: number): EngineAnswer => ({
      parserVersion: `gemini@${version}`,
      engine: "gemini",
      channel: "ui-vendor",
      provider: "dataforseo",
      modelReported: "3.5 Flash-Lite",
      present: true,
      markdown: `reading ${version}`,
      sources: [],
      searchQueries: "unavailable",
    });
    const store = (a: EngineAnswer) => {
      const bytes = jcs(a);
      const sha256 = sha256Hex(bytes);
      r2.set(`normalized/${sha256}`, new Uint8Array(bytes));
      return Buffer.from(sha256, "hex");
    };
    const ids = Array.from({ length: 200 }, () => newCaptureId());
    await withSystem("capture.test", async (tx) => {
      await tx.insert(captures).values(
        ids.map((id, slotIndex) => ({
          id,
          measurementId: m,
          slotIndex,
          attempt: 1,
          intentSetId: INTENT_SET,
          intentId: "dental_clinic.intent-0",
          engine: "gemini" as const,
          channel: "ui-vendor" as const,
          provider: "dataforseo" as const,
          mode: "live" as const,
          status: "succeeded" as const,
          responseBytes: 1,
          latencyMs: 1,
          parserVersion: 1,
          cost_amount_micros: 4000,
          cost_currency: "USD",
          envelopeSha256: randomBytes(32),
          normalizedSha256: store(answer(1)),
        })),
      );
      // Every third capture has two re-derivations; only the highest counts.
      await tx.insert(evidenceEntries).values(
        ids
          .filter((_, i) => i % 3 === 0)
          .flatMap((ref) =>
            [2, 3].map((revision) => ({
              ref,
              kind: "reparse" as const,
              revision,
              envelopeSha256: randomBytes(32),
              normalizedSha256: store(answer(revision)),
            })),
          ),
      );
    });

    counted.reason = "capture.answers";
    counted.transactions = 0;
    counted.statements = 0;
    const listed = await listAnswers(m);
    expect(counted).toMatchObject({ transactions: 1, statements: 1 });
    counted.reason = "";

    expect(listed.map((l) => l.slotId)).toEqual(ids.map((_, i) => slotId(m, i)));
    expect(listed.map((l) => l.answer?.parserVersion)).toEqual(
      ids.map((_, i) => (i % 3 === 0 ? "gemini@3" : "gemini@1")),
    );
    for (const { captureId, answer } of listed) {
      expect(digestOf(answer)).toBe((await latestNormalized(captureId as `cap_${string}`))?.sha256);
    }
  });
});
