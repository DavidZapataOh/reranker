import type { ServerEventName, ServerEventOf } from "@reranker/analytics";
import { isAppError } from "@reranker/schema";
import { spendDay } from "./day";
import { guardModeSince } from "./guard-mode";
import type { PaidProvider } from "./providers";
import { takeTokens } from "./rate";
import type { SpendReservation } from "./spend";
import { stepOutcome } from "./step-outcome";

type JobsEventName = Extract<ServerEventName, `jobs.${string}`>;

/** The catalog events of this package, exactly as `@reranker/analytics` declares them. */
export type JobsEvent = { [N in JobsEventName]: ServerEventOf<N> }[JobsEventName];

export type JobsAlertKind =
  | "jobs-spend-cap-reached"
  | "jobs-provider-saturated"
  | "jobs-breaker-open"
  | "jobs-workflow-failures";

export type JobsAlertPayload = Record<string, string | number | boolean>;

/** Where events and alerts go; the host app maps them onto its own telemetry. */
export interface JobsTelemetry {
  capture(event: JobsEvent): void;
  alert(kind: JobsAlertKind, payload: JobsAlertPayload): Promise<void>;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const BREAKER_OPEN_ALERT_MS = 5 * MINUTE_MS;
const SATURATED_ALERT_MS = 10 * MINUTE_MS;
const SPEND_THRESHOLDS = [80, 100] as const;
// More than 3 fatal steps in 15 minutes: the bucket holds 3 and refills them over 15 minutes.
const FATAL_STEPS = { capacity: 3, refillPerSecond: 3 / 900 };
const FATAL_WINDOW_MINUTES = 15;

// Next.js compiles instrumentation, routes and workflow steps into separate module graphs, so the
// sink lives on the process, where every copy of this module finds the one registered at startup.
const SINK = Symbol.for("@reranker/jobs/telemetry");

// This package cannot import the app's telemetry (it pulls in Next), so the app registers a sink.
export function registerJobsTelemetry(sink: JobsTelemetry | null): void {
  Reflect.set(globalThis, SINK, sink ?? undefined);
}

function sink(): JobsTelemetry | undefined {
  return Reflect.get(globalThis, SINK);
}

function report(what: string, error: unknown): void {
  console.error(`[jobs] ${what} failed`, {
    name: error instanceof Error ? error.name : typeof error,
  });
}

/** Sends a catalog event; never throws, and does nothing until a sink is registered. */
export function emit(event: JobsEvent): void {
  try {
    sink()?.capture(event);
  } catch (error) {
    report("telemetry event", error);
  }
}

// When this instance may next ask the fleet-wide dedupe about a key; only cuts round trips.
const quietUntil = new Map<string, number>();

/**
 * Sends `kind` for `key` at most once per `everyMs` across every instance: a token bucket in `ops`
 * holds the one alert of the period. Never throws.
 */
async function alertOnce(
  kind: JobsAlertKind,
  key: string,
  everyMs: number,
  payload: JobsAlertPayload,
): Promise<void> {
  try {
    const target = sink();
    if (!target) return;
    const id = `alert:${kind}:${key}`;
    if ((quietUntil.get(id) ?? 0) > Date.now()) return;
    const taken = await takeTokens(id, { capacity: 1, refillPerSecond: 1000 / everyMs });
    quietUntil.set(id, Date.now() + (taken.ok ? everyMs : taken.retryAfterMs));
    if (taken.ok) await target.alert(kind, payload);
  } catch (error) {
    report(`alert ${kind}`, error);
  }
}

async function spendAlert(scope: string, threshold: number, used: number, cap: number) {
  // The day in the key starts each scope's alerts afresh when its counters reset.
  await alertOnce("jobs-spend-cap-reached", `${spendDay()}:${threshold}:${scope}`, DAY_MS, {
    scope,
    threshold,
    used_micros: used,
    cap_micros: cap,
    severity: threshold >= 100 ? "critical" : "warning",
  });
}

/** Counts a reservation and alerts on each threshold of a scope that it crossed. */
export async function spendReserved(r: SpendReservation): Promise<void> {
  emit({
    name: "jobs.spend.reserved",
    props: { provider: r.provider, purpose: r.purpose, micro_usd: r.reserved.amount_micros },
  });
  if (!sink()) return;
  for (const { scope, used, cap } of r.scopes) {
    const after = used.amount_micros;
    const before = after - r.reserved.amount_micros;
    for (const threshold of SPEND_THRESHOLDS) {
      const limit = (cap.amount_micros * threshold) / 100;
      if (cap.amount_micros > 0 && before < limit && after >= limit) {
        await spendAlert(scope, threshold, after, cap.amount_micros);
      }
    }
  }
}

/** A cap turned work away: the scope is full for this request whether or not it reached 100%. */
export async function spendDenied(scope: string): Promise<void> {
  emit({ name: "jobs.spend.cap_reached", props: { scope } });
  // Used and cap of a denial are not read back; the alert names the scope that is full.
  await alertOnce("jobs-spend-cap-reached", `${spendDay()}:100:${scope}`, DAY_MS, {
    scope,
    threshold: 100,
    severity: "critical",
  });
}

/** Alerts when the breaker has not closed for more than 5 minutes since it opened. */
export async function breakerChecked(
  provider: PaidProvider,
  account: string,
  state: "closed" | "open" | "half_open",
  openedAt: Date | null,
): Promise<void> {
  if (state === "half_open") emit({ name: "jobs.breaker.state", props: { provider, state } });
  if (state === "closed" || openedAt === null) return;
  const openMs = Date.now() - openedAt.getTime();
  if (openMs <= BREAKER_OPEN_ALERT_MS) return;
  await alertOnce("jobs-breaker-open", `${provider}:${account}`, HOUR_MS, {
    provider,
    account,
    open_minutes: Math.floor(openMs / MINUTE_MS),
  });
}

/**
 * Alerts when the saturation guard mode of a provider has held for more than 10 minutes, that is
 * when the predicted wait stayed above its threshold without a gap long enough to release it.
 */
export async function providerSaturated(
  provider: PaidProvider,
  predictedWaitMs: number,
): Promise<void> {
  try {
    if (!sink()) return;
    // Each saturated reading would otherwise read the mode again; once a minute is enough.
    const id = `saturated:${provider}`;
    if ((quietUntil.get(id) ?? 0) > Date.now()) return;
    quietUntil.set(id, Date.now() + MINUTE_MS);
    const since = await guardModeSince(`jobs-saturated:${provider}`);
    if (since === null) return;
    const saturatedMs = Date.now() - since.getTime();
    if (saturatedMs <= SATURATED_ALERT_MS) return;
    await alertOnce("jobs-provider-saturated", provider, HOUR_MS, {
      provider,
      predicted_wait_ms: predictedWaitMs,
      saturated_minutes: Math.floor(saturatedMs / MINUTE_MS),
    });
  } catch (error) {
    report("saturation alert", error);
  }
}

// The error's type or catalog code, never its message, which may carry personal data.
function errorType(err: unknown): string {
  if (isAppError(err)) return err.code;
  return err instanceof Error ? err.name : "unknown";
}

/**
 * Counts a failed step as a retry or as fatal, the same way `toStepError` maps it; a fourth fatal
 * step within 15 minutes alerts. Call it in a step wrapper before rethrowing `toStepError(err)`.
 * Never throws.
 */
export async function reportStepError(workflow: string, step: string, err: unknown): Promise<void> {
  try {
    const props = { workflow, step, error: errorType(err) };
    if (!stepOutcome(err).fatal) {
      emit({ name: "jobs.step.retry", props });
      return;
    }
    emit({ name: "jobs.step.fatal", props });
    if (!sink()) return;
    const { ok } = await takeTokens("alert:jobs-step-fatal", FATAL_STEPS);
    if (ok) return;
    await alertOnce("jobs-workflow-failures", "fleet", HOUR_MS, {
      ...props,
      window_minutes: FATAL_WINDOW_MINUTES,
    });
  } catch (error) {
    report("step error report", error);
  }
}

export function resetJobsTelemetryForTest(): void {
  quietUntil.clear();
}
