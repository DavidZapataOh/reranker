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
  "uptime-down": { severity: "critical", runbook: "uptime-down.md", source: "betterstack" },
  "heartbeat-missed": {
    severity: "critical",
    runbook: "heartbeat-missed.md",
    source: "betterstack",
  },
} as const satisfies Record<string, OpsAlert>;

export type OpsAlertKind = keyof typeof opsAlerts;

const FROM = "Reranker alertas <alertas@reranker.co>";
const RUNBOOKS = "https://github.com/DavidZapataOh/reranker/blob/main/docs/runbooks";

const alertEnv = z.object({
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
      from: FROM,
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
