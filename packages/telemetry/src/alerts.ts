import { appEnv, defineEnv, secret } from "@reranker/env";
import { z } from "@reranker/schema";
import { Resend } from "resend";
import { runAfter } from "./after";
import { claimDelivery } from "./delivery";
import { telemetryEnv } from "./env";
import { captureServerEvent } from "./events";
import { log } from "./logger";
import { scrub } from "./scrub";

export type OpsAlertSeverity = "info" | "warning" | "critical";

type OpsAlert = { severity: OpsAlertSeverity; runbook: string; source: string };

/**
 * Alerts that fire from the telemetry layer. Each plan adds its own kinds, with their runbook,
 * where the alert is raised.
 */
export const opsAlerts = {
  "exceptions-in-production": {
    severity: "warning",
    runbook: "exceptions-in-production.md",
    source: "posthog",
  },
  "flags-not-ready": { severity: "critical", runbook: "flags-not-ready.md", source: "flags" },
  "capture-channel-disabled": {
    severity: "info",
    runbook: "disable-capture-channel.md",
    source: "flags",
  },
  "free-tier-quota": { severity: "warning", runbook: "free-tier-quota.md", source: "digest" },
  "db-rls-violation": { severity: "critical", runbook: "db-rls-violation.md", source: "db" },
  "db-pool-exhausted": { severity: "warning", runbook: "db-pool-exhausted.md", source: "db" },
  "neon-quota": { severity: "warning", runbook: "neon-quota.md", source: "digest" },
  "uptime-down": { severity: "critical", runbook: "uptime-down.md", source: "betterstack" },
  "heartbeat-missed": {
    severity: "critical",
    runbook: "heartbeat-missed.md",
    source: "betterstack",
  },
  // At 100% the payload raises it to critical; 80% only warns.
  "jobs-spend-cap-reached": {
    severity: "warning",
    runbook: "jobs-spend-cap-reached.md",
    source: "jobs",
  },
  "jobs-provider-saturated": {
    severity: "warning",
    runbook: "jobs-provider-saturated.md",
    source: "jobs",
  },
  "jobs-breaker-open": { severity: "critical", runbook: "jobs-breaker-open.md", source: "jobs" },
  "jobs-workflow-failures": {
    severity: "critical",
    runbook: "jobs-workflow-failures.md",
    source: "jobs",
  },
  "jobs-hobby-quota": { severity: "warning", runbook: "jobs-hobby-quota.md", source: "jobs" },
  "network-ranges-stale": {
    severity: "warning",
    runbook: "network-ranges-stale.md",
    source: "jobs",
  },
} as const satisfies Record<string, OpsAlert>;

export type OpsAlertKind = keyof typeof opsAlerts;

/**
 * Alerts raised by a provider or a workflow rather than by the application. They never pass
 * through `sendOpsAlert`; the registry only ties each one to its runbook.
 */
export const externalAlerts = {
  "ci-minutes-exhausted": { runbook: "ci-minutes-exhausted.md", source: "github" },
  "deployment-check-stuck": { runbook: "deployment-check-stuck.md", source: "vercel" },
  "nightly-failure": { runbook: "nightly-failure.md", source: "github" },
  "quality-check-failed": { runbook: "quality-check-failed.md", source: "github" },
} as const satisfies Record<
  string,
  {
    runbook: string;
    source: "posthog" | "github" | "vercel" | "betterstack" | "google-cloud" | "openai";
  }
>;

/** Runbooks for procedures nobody is alerted about; each owning plan adds its own. */
export const procedures = [
  "rotate-secret.md",
  "neon-setup.md",
  "db-rotate-password.md",
] as const satisfies readonly string[];

/** Sender of every operations email: alerts and the daily digest. */
export const OPS_FROM = "Reranker alertas <alertas@reranker.co>";
const RUNBOOKS = "https://github.com/DavidZapataOh/reranker/blob/main/docs/runbooks";

export const alertEnv = z.object({
  OPS_ALERT_EMAIL: telemetryEnv.shape.OPS_ALERT_EMAIL,
  RESEND_API_KEY: secret(
    z.string().startsWith("re_").optional(),
    "Resend API key used to email critical alerts",
  ),
});

// Created on first send so importing the module never needs the key.
let client: Resend | undefined;
let warnedUnconfigured = false;

function resend(key: string): Resend {
  client ??= new Resend(key);
  return client;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finalSeverity(kind: OpsAlertKind, payload: Record<string, unknown>): OpsAlertSeverity {
  const override = payload.severity;
  return override === "warning" || override === "critical" ? override : opsAlerts[kind].severity;
}

function body(kind: OpsAlertKind, payload: Record<string, string | number | boolean>): string {
  const lines = Object.entries(payload).map(([key, value]) => `${key}: ${value}`);
  return [...lines, "", `Runbook: ${RUNBOOKS}/${opsAlerts[kind].runbook}`].join("\n");
}

async function email(
  kind: OpsAlertKind,
  severity: OpsAlertSeverity,
  payload: Record<string, string | number | boolean>,
): Promise<void> {
  const env = defineEnv([alertEnv]);
  if (!env.OPS_ALERT_EMAIL || !env.RESEND_API_KEY) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      log.warn("ops.alert.email_unconfigured");
    }
    return;
  }
  const bucket = new Date();
  bucket.setUTCMinutes(0, 0, 0);
  if (!(await claimDelivery(kind))) return;
  const { error } = await resend(env.RESEND_API_KEY).emails.send(
    {
      from: OPS_FROM,
      to: env.OPS_ALERT_EMAIL,
      subject: `[${severity}] ${kind}`,
      text: body(kind, payload),
    },
    { idempotencyKey: `ops-alert/${kind}/${bucket.toISOString()}` },
  );
  if (error) log.error("ops.alert.email_failed", { kind, name: error.name });
}

/**
 * Logs and captures every alert; critical ones also reach the inbox, once per kind per hour and at
 * most 15 a day. Never throws: an alert about a failure must not become another failure.
 */
export async function sendOpsAlert(
  kind: OpsAlertKind,
  payload: Record<string, string | number | boolean> = {},
): Promise<void> {
  try {
    const severity = finalSeverity(kind, payload);
    const env = appEnv();
    const safe = scrub(payload);
    (severity === "critical" ? log.error : log.warn)("ops.alert", { kind, ...safe });
    captureServerEvent(
      { name: "ops_alert", props: { kind, severity, env } },
      { subject: { system: true } },
    );
    if (severity !== "critical" || env !== "production") return;
    runAfter(() =>
      email(kind, severity, safe).catch((error) =>
        log.error("ops.alert.email_failed", { kind, error: reason(error) }),
      ),
    );
  } catch (error) {
    log.error("ops.alert.failed", { kind, error: reason(error) });
  }
}
