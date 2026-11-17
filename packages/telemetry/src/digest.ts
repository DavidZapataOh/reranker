import { defineEnv, EnvValidationError } from "@reranker/env";
import {
  CURRENCIES,
  type CurrencyCode,
  DEFAULT_LOCALE,
  formatMoney,
  formatNumber,
  formatPercent,
} from "@reranker/i18n";
import type { ProviderCost } from "@reranker/schema";
import { Resend } from "resend";
import { alertEnv, OPS_FROM } from "./alerts";
import { log } from "./logger";
import type { ActionsUsage } from "./providers/github-actions-usage";
import { POSTHOG_FREE_LIMITS } from "./providers/posthog-usage";
import { SourceError } from "./providers/source-error";

export { pingHeartbeat } from "./providers/betterstack";
export { dataforseoBalance } from "./providers/dataforseo-balance";
export { type ActionsUsage, githubActionsUsage } from "./providers/github-actions-usage";
export { POSTHOG_FREE_LIMITS, posthogUsage } from "./providers/posthog-usage";
export { SourceError } from "./providers/source-error";

export type SourceResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "sin dato"; detail?: string };

export type DigestThresholds = {
  /** Percentages of an allowance that warn. */
  warning: readonly number[];
  /** Percentage of an allowance that is critical. */
  critical: number;
  /** Percentage of Resend's daily quota above which it warns. */
  resendDaily: number;
  /** Monthly Neon budget the estimated spend is measured against. */
  neonMonthlyUsd: number;
};

// Neon's organization is on Launch: no allowance runs out and nothing is suspended, so the
// percentages measure the month's estimated spend against this budget. US$20 is the low end of
// the specification's estimate for the first months.
export const DIGEST_THRESHOLDS = {
  warning: [50, 80],
  critical: 95,
  resendDaily: 70,
  neonMonthlyUsd: 20,
} as const satisfies DigestThresholds;

/** Launch plan rates, https://neon.com/docs/introduction/plans (read 2026-11-16). */
const NEON_USD_PER_CU_HOUR = 0.106;
const NEON_USD_PER_GIB_MONTH = 0.35;
const GIB = 1024 ** 3;

export const SOURCE_TIMEOUT_MS = 10_000;

export type SpendScope = {
  scope: string;
  day: ProviderCost;
  cap: ProviderCost;
  month: ProviderCost;
};

export type NeonProject = { name: string; computeHours: number; storageBytes: number };

export type DigestInput = {
  /** The run's date, `YYYY-MM-DD`. */
  date: string;
  /** The day that just closed, which the spend and email counts describe. */
  day: string;
  spend: SourceResult<readonly SpendScope[]>;
  dataforseo: SourceResult<{ balanceUsd: number }>;
  neon: SourceResult<readonly NeonProject[]>;
  github: SourceResult<ActionsUsage>;
  posthog: SourceResult<{ events: number; exceptions: number }>;
  resend: SourceResult<{ sent: number; limit: number }>;
  workflows: SourceResult<{ estimatedEvents: number; ratio: number }>;
  switches: SourceResult<Readonly<Record<string, boolean>>>;
  thresholds?: Partial<DigestThresholds>;
};

export type DigestAlert = {
  kind: "free-tier-quota" | "neon-quota";
  payload: Record<string, string | number | boolean>;
};

function reasonOf(error: unknown): string {
  if (error instanceof SourceError) return error.message;
  if (error instanceof EnvValidationError) {
    return `variable inválida: ${error.issues.map((issue) => issue.name).join(", ")}`;
  }
  // A provider's message can carry anything, so only the error's class reaches the email.
  return error instanceof Error ? `error inesperado (${error.name})` : "error inesperado";
}

/**
 * Runs one source with a time bound. A source that fails or does not answer in `ms` is "sin dato"
 * and its request is aborted, so one slow provider never holds the digest back. Never rejects.
 */
export function fetchWithin<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number = SOURCE_TIMEOUT_MS,
): Promise<SourceResult<T>> {
  const controller = new AbortController();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const detail = `sin respuesta en ${ms / 1000} s`;
      controller.abort(new SourceError(detail));
      resolve({ ok: false, reason: "sin dato", detail });
    }, ms);
    Promise.resolve()
      .then(() => fn(controller.signal))
      .then(
        (value) => resolve({ ok: true, value }),
        (error: unknown) => resolve({ ok: false, reason: "sin dato", detail: reasonOf(error) }),
      )
      .finally(() => clearTimeout(timer));
  });
}

type Crossing = { severity: "warning" | "critical"; threshold: number };

function crossing(percent: number, t: DigestThresholds): Crossing | null {
  // Two decimals, so a float a hair under the line still crosses it.
  const p = Math.round(percent * 100) / 100;
  if (p >= t.critical) return { severity: "critical", threshold: t.critical };
  const hit = t.warning.filter((w) => p >= w);
  return hit.length > 0 ? { severity: "warning", threshold: Math.max(...hit) } : null;
}

// The digest is read by the operator, in the product's only locale.
const FORMAT = { locale: DEFAULT_LOCALE } as const;

const num = (n: number) => formatNumber(Math.round(n * 10) / 10, FORMAT);
const pct = (percent: number) =>
  formatPercent(percent / 100, { ...FORMAT, maximumFractionDigits: 0 });

function money(c: { amount_micros: number; currency: CurrencyCode }): string {
  const microsPerMinor = 10 ** (6 - CURRENCIES[c.currency].exponent);
  return formatMoney(
    { amount_minor: Math.round(c.amount_micros / microsPerMinor), currency: c.currency },
    FORMAT,
  );
}

const usd = (amount: number) =>
  money({ amount_micros: Math.round(amount * 1_000_000), currency: "USD" });

function section<T>(
  label: string,
  result: SourceResult<T>,
  render: (value: T) => string[],
): string[] {
  if (result.ok) return render(result.value);
  return [`${label}: sin dato${result.detail ? ` (${result.detail})` : ""}`];
}

function spendLines(day: string, scopes: readonly SpendScope[]): string[] {
  const shown = scopes
    .filter((s) => s.scope === "global" || s.scope.startsWith("provider:"))
    .sort((a, b) =>
      a.scope === "global" ? -1 : b.scope === "global" ? 1 : a.scope.localeCompare(b.scope),
    );
  const reached = scopes
    .filter((s) => s.cap.amount_micros > 0 && s.day.amount_micros >= s.cap.amount_micros)
    .map((s) => s.scope);
  return [
    `Gasto del ${day}`,
    ...shown.map((s) => {
      const name = s.scope === "global" ? "Total" : s.scope.slice("provider:".length);
      return `- ${name}: ${money(s.day)} de ${money(s.cap)} · mes: ${money(s.month)}`;
    }),
    `Topes alcanzados el ${day}: ${reached.length > 0 ? reached.join(", ") : "ninguno"}`,
  ];
}

/**
 * The digest's text and the alerts its thresholds cross. Pure: every reading arrives in `input`.
 * Workflow usage and spend caps appear only in the text; their alerts are raised where they are
 * measured, so the digest never duplicates them.
 */
export function buildDailyDigest(input: DigestInput): { text: string; alerts: DigestAlert[] } {
  const t: DigestThresholds = { ...DIGEST_THRESHOLDS, ...input.thresholds };
  const alerts: DigestAlert[] = [];
  const quota = (source: string, percent: number, extra: DigestAlert["payload"] = {}) => {
    const hit = crossing(percent, t);
    if (hit) {
      alerts.push({
        kind: "free-tier-quota",
        payload: { source, percent: Math.round(percent), ...hit, ...extra },
      });
    }
  };

  const neon = section("Neon", input.neon, (projects) => {
    const compute = projects.reduce((sum, p) => sum + p.computeHours, 0) * NEON_USD_PER_CU_HOUR;
    const storage =
      (projects.reduce((sum, p) => sum + p.storageBytes, 0) / GIB) * NEON_USD_PER_GIB_MONTH;
    // Storage is billed per GiB-month, so the current size counts for the whole month.
    const spend = compute + storage;
    const percent = t.neonMonthlyUsd > 0 ? (spend / t.neonMonthlyUsd) * 100 : 100;
    const hit = crossing(percent, t);
    if (hit) {
      alerts.push({
        kind: "neon-quota",
        payload: {
          source: "neon",
          spend_usd: Math.round(spend * 100) / 100,
          budget_usd: t.neonMonthlyUsd,
          percent: Math.round(percent),
          ...hit,
        },
      });
    }
    return [
      "Neon (plan Launch, mes en curso)",
      ...projects.map(
        (p) => `- ${p.name}: ${num(p.computeHours)} CU-h · ${num(p.storageBytes / GIB)} GB`,
      ),
      `- gasto estimado del mes ${usd(spend)} de ${usd(t.neonMonthlyUsd)} (${pct(percent)})`,
    ];
  });

  const github = section("GitHub Actions", input.github, (u) => {
    const percent = (u.includedUsedUsd / u.includedUsd) * 100;
    quota("github-actions", percent, {
      used_usd: Math.round(u.includedUsedUsd * 100) / 100,
      included_usd: u.includedUsd,
    });
    return [
      `GitHub Actions: ${num(u.minutesUsed)} min este mes · ${usd(u.includedUsedUsd)} de ${usd(u.includedUsd)} incluidos (${pct(percent)}) · facturado ${usd(u.billedUsd)}`,
    ];
  });

  const posthog = section("PostHog", input.posthog, (u) => {
    const events = (u.events / POSTHOG_FREE_LIMITS.events) * 100;
    const exceptions = (u.exceptions / POSTHOG_FREE_LIMITS.exceptions) * 100;
    quota("posthog-events", events);
    quota("posthog-exceptions", exceptions);
    return [
      `PostHog: ${num(u.events)} eventos de ${num(POSTHOG_FREE_LIMITS.events)} (${pct(events)}) · ${num(u.exceptions)} excepciones de ${num(POSTHOG_FREE_LIMITS.exceptions)} (${pct(exceptions)})`,
    ];
  });

  const resend = section("Resend", input.resend, ({ sent, limit }) => {
    const percent = (sent / limit) * 100;
    if (percent > t.resendDaily) {
      const severity = percent >= t.critical ? "critical" : "warning";
      alerts.push({
        kind: "free-tier-quota",
        payload: {
          source: "resend",
          day: input.day,
          sent,
          limit,
          percent: Math.round(percent),
          severity,
          threshold: severity === "critical" ? t.critical : t.resendDaily,
        },
      });
    }
    return [`Resend: ${num(sent)} correos el ${input.day} de ${num(limit)} (${pct(percent)})`];
  });

  const text = [
    `Resumen diario · ${input.date}`,
    "",
    ...section(`Gasto del ${input.day}`, input.spend, (scopes) => spendLines(input.day, scopes)),
    "",
    ...section("DataForSEO", input.dataforseo, ({ balanceUsd }) => [
      `DataForSEO: saldo ${usd(balanceUsd)}`,
    ]),
    "",
    ...neon,
    "",
    ...github,
    ...posthog,
    ...resend,
    ...section("Workflows (estimado)", input.workflows, ({ estimatedEvents, ratio }) => [
      `Workflows (estimado): ${num(estimatedEvents)} eventos (${pct(ratio * 100)} del presupuesto mensual)`,
    ]),
    "",
    ...section("Kill switches", input.switches, (switches) => [
      "Kill switches",
      ...Object.entries(switches).map(([key, on]) => `- ${key}: ${on ? "encendido" : "apagado"}`),
    ]),
  ].join("\n");

  return { text, alerts };
}

let client: Resend | undefined;

function mailConfig(): { to: string; key: string } | undefined {
  try {
    const env = defineEnv([alertEnv]);
    return env.OPS_ALERT_EMAIL && env.RESEND_API_KEY
      ? { to: env.OPS_ALERT_EMAIL, key: env.RESEND_API_KEY }
      : undefined;
  } catch (error) {
    if (!(error instanceof EnvValidationError)) throw error;
    log.error("ops.digest.email_misconfigured", {
      variables: error.issues.map((i) => i.name).join(","),
    });
    return undefined;
  }
}

/** True once the operations inbox and the Resend key both exist. */
export function digestEmailConfigured(): boolean {
  return mailConfig() !== undefined;
}

const QUOTA_HEADERS = {
  resend_daily_quota: "x-resend-daily-quota",
  resend_monthly_quota: "x-resend-monthly-quota",
} as const;

function quotaHeaders(headers: Record<string, string> | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, header] of Object.entries(QUOTA_HEADERS)) {
    const value = Number(headers?.[header] ?? Number.NaN);
    if (Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/**
 * Emails the digest as plain text to the operations inbox. Keyed by date, so a retried step
 * cannot send it twice. Reports whether it went out; never throws.
 */
export async function sendDailyDigest(date: string, text: string): Promise<boolean> {
  const mail = mailConfig();
  if (!mail) return false;
  try {
    client ??= new Resend(mail.key);
    const { error, headers } = await client.emails.send(
      { from: OPS_FROM, to: mail.to, subject: `Resumen diario · ${date}`, text },
      { idempotencyKey: `ops-digest/${date}` },
    );
    if (error) {
      log.error("ops.digest.email_failed", { name: error.name });
      return false;
    }
    // Resend's own count of today's sends (UTC day), which also includes every alert email.
    log.info("ops.digest.email_sent", { date, ...quotaHeaders(headers) });
    return true;
  } catch (error) {
    log.error("ops.digest.email_failed", {
      name: error instanceof Error ? error.name : "unknown",
    });
    return false;
  }
}
