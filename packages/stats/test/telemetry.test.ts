import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { AppError } from "@reranker/schema";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { methodology } from "../src/methodology";
import { computeFreeReportStats } from "../src/report";
import {
  captureId,
  ENGINES,
  mention,
  REPORT,
  RIVAL,
  reportInput,
  TARGET,
} from "./fixtures/report-200";

const telemetry = vi.hoisted(() => ({ captureServerEvent: vi.fn() }));
vi.mock("@reranker/telemetry", () => telemetry);

const { runFreeReportStats } = await import("../src/telemetry");

const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });

beforeAll(() => {
  trace.setGlobalTracerProvider(provider);
});

afterEach(() => {
  exporter.reset();
  telemetry.captureServerEvent.mockReset();
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});

// The target recommended first in one answer of four, a rival in every answer.
const sometimes = reportInput({
  mentions: (slot) => [
    ...(slot % 4 === 0 ? [mention({ entityKey: TARGET })] : []),
    mention({ entityKey: RIVAL, ordinal: 2 }),
  ],
});

describe("runFreeReportStats", () => {
  test("emits one stats_computed with the target level and sufficiency and no names", () => {
    const stats = runFreeReportStats(sometimes);
    expect(telemetry.captureServerEvent).toHaveBeenCalledExactlyOnceWith(
      {
        name: "stats_computed",
        props: {
          methodology_hash: methodology.hash,
          compute_ms: expect.any(Number),
          target_level: "sometimes",
          target_sufficiency: stats.target.overall?.sufficiency,
          // Both name in all 25 canonical answers, where Wilson's lower bound sits ~3.9 points
          // under Jeffreys'; every other rate stays within 3.
          wilson_divergences: 2,
          engines_included: 5,
        },
      },
      { subject: { report: REPORT } },
    );
    const [event] = telemetry.captureServerEvent.mock.calls[0] as [
      { props: { compute_ms: number } },
    ];
    expect(Number.isInteger(event.props.compute_ms)).toBe(true);
    expect(event.props.compute_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(telemetry.captureServerEvent.mock.calls)).not.toMatch(/Sonrisas|rival/);
  });

  test("counts rate bounds where Wilson differs from Jeffreys by more than 3 points", () => {
    // Half of every engine fails, so each engine rests on 20 answers; the target is never
    // recommended, and Jeffreys' upper bound at 0 of 20 sits more than 3 points below Wilson's.
    runFreeReportStats(
      reportInput({
        failed: Object.fromEntries(ENGINES.map((engine) => [engine, 20])),
        mentions: () => [mention({ entityKey: RIVAL })],
      }),
    );
    const [{ props }] = telemetry.captureServerEvent.mock.calls[0] as [
      { props: { wilson_divergences: number; target_level: string } },
    ];
    expect(props.wilson_divergences).toBeGreaterThanOrEqual(5);
    expect(props.target_level).toBe("invisible");
  });

  test("engines without a valid answer neither count as included nor carry a rate to check", () => {
    const failed = Object.fromEntries(ENGINES.filter((e) => e !== "gemini").map((e) => [e, 40]));
    runFreeReportStats(reportInput({ failed }));
    expect(telemetry.captureServerEvent).toHaveBeenCalledExactlyOnceWith(
      { name: "stats_computed", props: expect.objectContaining({ engines_included: 1 }) },
      { subject: { report: REPORT } },
    );
  });

  test("a report without canonical answers checks only the rates it carries", () => {
    const input = reportInput();
    const canonical = new Set(
      input.plan.observations.flatMap((o, slot) => (o.isCanonical ? [captureId(slot)] : [])),
    );
    for (const c of input.captures) {
      if (!canonical.has(c.capture.id)) continue;
      c.capture.status = "provider_error";
      c.answer = null;
    }
    for (const e of input.extractions) {
      if (!canonical.has(e.captureId)) continue;
      e.answerKind = "capture_failed";
      e.mentions = [];
    }
    const stats = runFreeReportStats(input);
    expect(stats.canonicalOnly).toBeNull();
    expect(telemetry.captureServerEvent).toHaveBeenCalledExactlyOnceWith(
      { name: "stats_computed", props: expect.objectContaining({ engines_included: 5 }) },
      { subject: { report: REPORT } },
    );
  });

  test("the span carries methodology_hash and ends", () => {
    runFreeReportStats(sometimes);
    const [span, ...rest] = exporter.getFinishedSpans();
    expect(rest).toEqual([]);
    expect(span?.name).toBe("stats.compute");
    expect(span?.attributes).toMatchObject({ methodology_hash: methodology.hash });
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
  });

  test("the wrapper returns exactly the pure result", () => {
    expect(JSON.stringify(runFreeReportStats(sometimes))).toBe(
      JSON.stringify(computeFreeReportStats(sometimes)),
    );
  });

  test("a failing computation is recorded on the span, rethrown and sends no event", () => {
    expect(() => runFreeReportStats(reportInput({ mixedConfig: true }))).toThrow(AppError);
    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events.map((e) => e.name)).toEqual(["exception"]);
    expect(telemetry.captureServerEvent).not.toHaveBeenCalled();
  });
});
