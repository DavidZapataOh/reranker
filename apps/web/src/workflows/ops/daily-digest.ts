import { withSystem } from "@reranker/db";
import { readNeonUsage } from "@reranker/db/neon-usage";
import { defineEnv } from "@reranker/env";
import { captureSwitchSnapshot } from "@reranker/flags";
import { DEFAULT_COUNTRY_CODE, getCountry } from "@reranker/i18n/countries";
import {
  checkWorkflowBudget,
  consumeQuota,
  type DailyStep,
  loadJobsConfig,
  primitiveLatency,
  providerVolume,
  QuotaExceededError,
  reportStepError,
  spendCapPressure,
} from "@reranker/jobs";
import { toStepError } from "@reranker/jobs/step-errors";
import { type CurrencyCode, cost, type ProviderCost } from "@reranker/schema";
import { log, sendOpsAlert } from "@reranker/telemetry";
import {
  buildDailyDigest,
  dataforseoBalance,
  digestEmailConfigured,
  fetchWithin,
  githubActionsUsage,
  type NeonProject,
  neonBudgetUsd,
  pingHeartbeat,
  posthogUsage,
  SourceError,
  type SpendScope,
  type StagesInput,
  sendDailyDigest,
} from "@reranker/telemetry/digest";
import { digestEnv, telemetryEnv } from "@reranker/telemetry/env";
import { postHogPlan } from "@reranker/telemetry/posthog-plan";
import { sql } from "drizzle-orm";

export type DigestResult = { sent: boolean; alerts: number; missing: string[] };

const DAY_MS = 86_400_000;
const TIME_ZONE = getCountry(DEFAULT_COUNTRY_CODE).timeZone;

const neonEnv = digestEnv.pick({
  NEON_API_KEY: true,
  NEON_PROJECT_ID: true,
  NEON_NONPROD_PROJECT_ID: true,
});
const heartbeatEnv = telemetryEnv.pick({ BETTERSTACK_HEARTBEAT_DAILY_URL: true });

function previousDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

type SpendRow = {
  scope: string;
  currency: CurrencyCode;
  day_used: string;
  day_cap: string | null;
  month_used: string;
};

/**
 * The closed day's spend per scope against the cap it ran under, beside the month so far. Every
 * provider is listed, at zero when it spent nothing; caps of other scopes appear only if used.
 */
async function readSpend(day: string): Promise<SpendScope[]> {
  const { rows } = await withSystem("ops.digest.spend", (tx) =>
    tx.execute<SpendRow>(
      sql`select scope, used_currency as currency,
                 coalesce(sum(used_amount_micros) filter (where day = ${day}::date), 0)::bigint as day_used,
                 max(cap_amount_micros) filter (where day = ${day}::date)::bigint as day_cap,
                 sum(used_amount_micros)::bigint as month_used
            from ops.spend_counters
           where day between date_trunc('month', ${day}::date)::date and ${day}::date
           group by scope, used_currency`,
    ),
  );
  const caps: Readonly<Record<string, ProviderCost>> = loadJobsConfig().caps;
  const byScope = new Map(rows.map((row) => [row.scope, row]));
  const listed = Object.keys(caps).filter((s) => s === "global" || s.startsWith("provider:"));
  const scopes = new Set([...listed, ...byScope.keys()]);
  return [...scopes].map((scope) => {
    const row = byScope.get(scope);
    const configured = caps[scope];
    const currency = row?.currency ?? configured?.currency ?? "USD";
    return {
      scope,
      day: cost(Number(row?.day_used ?? 0), currency),
      cap:
        row?.day_cap != null
          ? cost(Number(row.day_cap), currency)
          : (configured ?? cost(0, currency)),
      month: cost(Number(row?.month_used ?? 0), currency),
    };
  });
}

/**
 * Emails sent through Resend on the closed day: the quota's counters plus the alert emails,
 * which are capped in their own table and never pass through the quota.
 */
async function readResend(day: string): Promise<{ sent: number; limit: number }> {
  const { rows } = await withSystem("ops.digest.resend", (tx) =>
    tx.execute<{ quota: number; alerts: number }>(
      sql`select
            (select coalesce(sum(used), 0) from ops.quota_counters
              where day = ${day}::date and name = 'resend.emails')::int as quota,
            (select count(*) from ops.alert_deliveries
              where bucket_hour >= ${day}::date::timestamp at time zone ${TIME_ZONE}
                and bucket_hour < (${day}::date + 1)::timestamp at time zone ${TIME_ZONE})::int as alerts`,
    ),
  );
  const row = rows[0];
  return {
    sent: (row?.quota ?? 0) + (row?.alerts ?? 0),
    limit: loadJobsConfig().quotas["resend.emails"].daily,
  };
}

/** Both projects' month so far, through the closed day (UTC days, as Neon counts them). */
async function readNeon(
  day: string,
  signal: AbortSignal,
): Promise<{ budgetUsd: number; projects: NeonProject[] }> {
  const env = defineEnv([neonEnv]);
  const { NEON_API_KEY: apiKey, NEON_PROJECT_ID: prod, NEON_NONPROD_PROJECT_ID: nonprod } = env;
  if (!apiKey || !prod || !nonprod) {
    throw new SourceError("falta NEON_API_KEY, NEON_PROJECT_ID o NEON_NONPROD_PROJECT_ID");
  }
  const names = new Map([
    [prod, "reranker-prod"],
    [nonprod, "reranker-nonprod"],
  ]);
  const { projects } = await readNeonUsage({
    apiKey,
    projectIds: [prod, nonprod],
    from: `${day.slice(0, 7)}-01T00:00:00Z`,
    to: `${nextDay(day)}T00:00:00Z`,
    fetch: (input, init) => fetch(input, { ...init, signal }),
  });
  return {
    budgetUsd: neonBudgetUsd(),
    projects: projects.map((p) => ({ ...p, name: names.get(p.projectId) ?? p.projectId })),
  };
}

/** The launch checks, the gated flags and the volume triggers, for "Escalones pendientes". */
async function readStages(day: string): Promise<StagesInput> {
  // Loaded here so the other steps of the bundle never pay for the provider clients.
  const [{ runLaunchCheck }, { deploymentInputs, readGatedFlags }] = await Promise.all([
    import("@reranker/telemetry/launch"),
    import("../../lib/launch-state"),
  ]);
  const [checks, flagsOn, pressure, latency, volume] = await Promise.all([
    runLaunchCheck(deploymentInputs()),
    fetchWithin(() => readGatedFlags()),
    fetchWithin(async () => (await spendCapPressure(day)).fired),
    fetchWithin(async () => (await primitiveLatency()).fired),
    fetchWithin(async () => (await providerVolume(day.slice(0, 7))).fired),
  ]);
  return {
    checks,
    flagsOn,
    triggers: { spendCapPressure: pressure, primitiveLatency: latency, providerVolume: volume },
  };
}

async function sendDigest(date: string, text: string): Promise<boolean> {
  if (!digestEmailConfigured()) {
    log.warn("ops.digest.email_unconfigured", { date });
    return false;
  }
  try {
    await consumeQuota("resend.emails", { priority: "high" });
  } catch (error) {
    if (!(error instanceof QuotaExceededError)) throw error;
    log.error("ops.digest.quota_exceeded", { date });
    return false;
  }
  return sendDailyDigest(date, text);
}

// Runs after the email went out, so it never throws: a retried step would only repeat the rest.
async function ping(): Promise<void> {
  try {
    const url = defineEnv([heartbeatEnv]).BETTERSTACK_HEARTBEAT_DAILY_URL;
    if (!url) {
      log.warn("ops.digest.heartbeat_unconfigured");
      return;
    }
    await pingHeartbeat(url);
  } catch (error) {
    log.error("ops.digest.heartbeat_failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

/**
 * Builds and sends the digest of the day before `date` (`YYYY-MM-DD`, Bogota): sources in
 * parallel, each bounded, so a slow or absent one is "sin dato" instead of blocking the rest;
 * then the alerts its thresholds cross, the email, and the heartbeat only if the email went out.
 */
export async function runDailyDigest(date: string): Promise<DigestResult> {
  const day = previousDay(date);
  const month = day.slice(0, 7);
  const [spend, dataforseo, neon, github, posthog, resend, workflows, switches, stages] =
    await Promise.all([
      fetchWithin(() => readSpend(day)),
      fetchWithin((signal) => dataforseoBalance(signal)),
      fetchWithin((signal) => readNeon(day, signal)),
      fetchWithin((signal) => githubActionsUsage(month, signal)),
      fetchWithin((signal) => posthogUsage(signal)),
      fetchWithin(() => readResend(day)),
      // The spend only goes in the text: its alert is raised by the checkWorkflowBudget step.
      fetchWithin(() => checkWorkflowBudget(month)),
      fetchWithin(async () => (await captureSwitchSnapshot()).switches),
      // Every part is bounded on its own; launch checks never reject.
      readStages(day),
    ] as const);
  const sources = { spend, dataforseo, neon, github, posthog, resend, workflows, switches };
  const missing = Object.entries(sources)
    .filter(([, result]) => !result.ok)
    .map(([source]) => source);
  if (missing.length > 0) {
    log.warn("ops.digest.sources_missing", { date, sources: missing.join(",") });
  }

  const { text, alerts } = buildDailyDigest({
    date,
    day,
    ...sources,
    posthogPlan: postHogPlan(),
    stages,
  });
  for (const alert of alerts) await sendOpsAlert(alert.kind, alert.payload);

  const sent = await sendDigest(date, text);
  if (sent) await ping();
  log.info("ops.digest.done", { date, sent, alerts: alerts.length, missing: missing.length });
  return { sent, alerts: alerts.length, missing };
}

async function opsDigestStep(date: string): Promise<void> {
  "use step";
  try {
    await runDailyDigest(date);
  } catch (error) {
    await reportStepError("daily", "opsDigest", error);
    throw toStepError(error);
  }
}

/** Last of the daily steps, so it reports on everything the steps before it did. */
export const opsDigest: DailyStep = { name: "opsDigest", run: opsDigestStep };
