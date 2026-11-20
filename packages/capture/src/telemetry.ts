import { recordVelocity } from "@reranker/jobs/velocity";
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

// Only the call that crosses the threshold alerts, so an incident raises one alert instead of one
// per failed call for as long as it lasts.
async function track(
  key: string,
  flagged: boolean,
  shouldAlert: (w: Window) => boolean,
  alert: (w: Window) => Promise<void>,
): Promise<void> {
  try {
    const now = await recordVelocity(key, { flagged, spend: NO_SPEND });
    const before = { count10m: now.count10m - 1, flagged10m: now.flagged10m - (flagged ? 1 : 0) };
    if (shouldAlert(now) && !shouldAlert(before)) await alert(now);
  } catch (error) {
    log.warn("capture.velocity_failed", {
      key,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

const rateAlert = (kind: OpsAlertKind, flaggedKey: string) => (w: Window) =>
  sendOpsAlert(kind, { calls_10m: w.count10m, [flaggedKey]: w.flagged10m });

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
  runAfter(async () => {
    const tracked = [
      track(
        `capture:${provider}:errors`,
        call.status !== "succeeded",
        shouldAlertErrors,
        rateAlert("capture-dataforseo-errors", "failed_10m"),
      ),
    ];
    // A call that brought no body back had nothing to parse.
    if (call.status !== "no_response") {
      tracked.push(
        track(
          `capture:${provider}:parse`,
          call.parseFailed,
          shouldAlertParse,
          rateAlert("capture-parse-failed", "parse_failed_10m"),
        ),
      );
    }
    if (call.alert === "balance") {
      tracked.push(
        sendOpsAlert("capture-dataforseo-balance", {
          engine: call.engine,
          provider_status_code: call.providerStatusCode ?? 0,
        }),
      );
    }
    await Promise.all(tracked);
  });
}
