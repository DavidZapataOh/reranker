import { recordVelocities } from "@reranker/jobs/velocity";
import {
  type CaptureChannel,
  type CaptureProvider,
  cost,
  type EngineId,
  type ProviderCost,
} from "@reranker/schema";
import {
  captureServerEvent,
  log,
  type OpsAlertKind,
  runAfter,
  sendOpsAlert,
} from "@reranker/telemetry";
import type { CaptureRecord } from "./adapters";

/** One provider call as operations see it, whether or not anything came back. */
export interface CaptureCall {
  engine: EngineId;
  provider: CaptureProvider;
  channel: CaptureChannel;
  mode: CaptureRecord["mode"];
  status: CaptureRecord["status"] | "no_response";
  latencyMs: number;
  cost: ProviderCost | null;
  parseFailed: boolean;
  surfaceAbsent: boolean;
  late: boolean;
  providerStatusCode: number | null;
  /** Set when the provider refused for lack of funds: nothing works until the account is funded. */
  alert?: "balance" | undefined;
}

type Window = { count10m: number; flagged10m: number };

const NO_SPEND = cost(0, "USD");

const shouldAlertErrors = (w: Window) => w.count10m >= 20 && w.flagged10m / w.count10m > 0.2;
const shouldAlertParse = (w: Window) => w.count10m >= 20 && w.flagged10m / w.count10m > 0.05;

// The alert kinds and their runbook are DataForSEO's; another provider adds its own.
const ALERTED: ReadonlySet<CaptureProvider> = new Set(["dataforseo"]);

export function captureCallOf(
  record: CaptureRecord,
  ctx: { channel: CaptureChannel; late: boolean; alert?: "balance" | undefined },
): CaptureCall {
  return {
    engine: record.slot.engine,
    provider: record.slot.provider,
    channel: ctx.channel,
    mode: record.mode,
    status: record.status,
    latencyMs: record.latencyMs,
    cost: record.cost,
    parseFailed: record.parseError !== null,
    surfaceAbsent: record.answer?.present === false,
    late: ctx.late,
    providerStatusCode: record.providerStatusCode,
    alert: ctx.alert,
  };
}

type Tracked = {
  key: string;
  flagged: boolean;
  shouldAlert: (w: Window) => boolean;
  kind: OpsAlertKind;
  flaggedLabel: string;
};

type Pending = { tracked: Tracked[]; done: (windows: Window[] | null) => void };

// Bounds one statement; a burst larger than this drains in several, one after the other.
const MAX_BATCH_CALLS = 500;

// One writer per instance: the first call's windows go out alone, and the calls that finish
// while a write is in flight go together in the next one. A burst then holds one system
// connection at a time instead of one per call, and its windows are not lost to a pool wait.
const writer: { waiting: Pending[]; running: boolean } = { waiting: [], running: false };

async function drain(): Promise<void> {
  writer.running = true;
  while (writer.waiting.length > 0) {
    const batch = writer.waiting.splice(0, MAX_BATCH_CALLS);
    let windows: Window[] | null = null;
    try {
      windows = await recordVelocities(
        batch.flatMap((p) =>
          p.tracked.map(({ key, flagged }) => ({ key, flagged, spend: NO_SPEND })),
        ),
      );
    } catch (error) {
      log.warn("capture.velocity_failed", {
        calls: batch.length,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
    let next = 0;
    for (const p of batch) {
      p.done(windows?.slice(next, next + p.tracked.length) ?? null);
      next += p.tracked.length;
    }
  }
  writer.running = false;
}

function recordWindows(tracked: Tracked[]): Promise<Window[] | null> {
  const recorded = new Promise<Window[] | null>((done) => writer.waiting.push({ tracked, done }));
  if (!writer.running) void drain();
  return recorded;
}

// Only the call that crosses a threshold alerts, so an incident raises one alert instead of one
// per failed call for as long as it lasts. Each call gets the windows right after its own sample.
async function track(tracked: Tracked[]): Promise<void> {
  const windows = await recordWindows(tracked);
  if (!windows) return;
  const alerts = tracked.flatMap(({ flagged, shouldAlert, kind, flaggedLabel }, i) => {
    const now = windows[i];
    if (!now) return [];
    const before = {
      count10m: now.count10m - 1,
      flagged10m: now.flagged10m - (flagged ? 1 : 0),
    };
    if (!shouldAlert(now) || shouldAlert(before)) return [];
    return [sendOpsAlert(kind, { calls_10m: now.count10m, [flaggedLabel]: now.flagged10m })];
  });
  await Promise.all(alerts);
}

/**
 * Emits the call's `capture_call` event and feeds the provider's alert windows. Never throws, and
 * the database work runs after the response so it adds nothing to the capture's own overhead.
 */
export function recordCaptureCall(call: CaptureCall): void {
  captureServerEvent(
    {
      name: "capture_call",
      props: {
        engine: call.engine,
        provider: call.provider,
        channel: call.channel,
        mode: call.mode,
        status: call.status,
        latency_ms: call.latencyMs,
        cost_micros: call.cost?.amount_micros ?? null,
        parse_failed: call.parseFailed,
        surface_absent: call.surfaceAbsent,
        late: call.late,
      },
    },
    { subject: { system: true } },
  );
  if (!ALERTED.has(call.provider)) return;
  const { provider } = call;
  const tracked: Tracked[] = [
    {
      key: `capture:${provider}:errors`,
      flagged: call.status !== "succeeded",
      shouldAlert: shouldAlertErrors,
      kind: "capture-dataforseo-errors",
      flaggedLabel: "failed_10m",
    },
  ];
  // A call that brought no body back had nothing to parse.
  if (call.status !== "no_response") {
    tracked.push({
      key: `capture:${provider}:parse`,
      flagged: call.parseFailed,
      shouldAlert: shouldAlertParse,
      kind: "capture-parse-failed",
      flaggedLabel: "parse_failed_10m",
    });
  }
  runAfter(async () => {
    await Promise.all([
      track(tracked),
      call.alert === "balance" &&
        sendOpsAlert("capture-dataforseo-balance", {
          engine: call.engine,
          provider_status_code: call.providerStatusCode ?? 0,
        }),
    ]);
  });
}
