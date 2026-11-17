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
import { digestEnv } from "./env";
import type { CheckResult, GatedFlag } from "./launch/types";
import { log } from "./logger";
import { type PostHogPlan, postHogLimits } from "./posthog-plan";
import type { ActionsUsage } from "./providers/github-actions-usage";
import { SourceError } from "./providers/source-error";
import { PENDING_STAGES } from "./stages";

export { pingHeartbeat } from "./providers/betterstack";
export { dataforseoBalance } from "./providers/dataforseo-balance";
export { type ActionsUsage, githubActionsUsage } from "./providers/github-actions-usage";
export { posthogUsage } from "./providers/posthog-usage";
export { SourceError } from "./providers/source-error";

export type SourceResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "sin dato"; detail?: string };

export type DigestThresholds = {
  /** Percentages of a free allowance that warn. */
  warning: readonly number[];
  /** Percentage of a free allowance that is critical. */
  critical: number;
  /** Percentage of Resend's daily quota above which it warns. */
  resendDaily: number;
  /** Lines of a monthly budget: it warns from the first and is critical from the second. */
  budget: { warning: number; critical: number };
};

export const DIGEST_THRESHOLDS = {
  warning: [50, 80],
  critical: 95,
  resendDaily: 70,
  budget: { warning: 70, critical: 100 },
} as const satisfies DigestThresholds;

// Production always on at 0.5 CU is about US$39 a month (0.5 × 730 h × US$0.106), plus its peaks,
// storage and the nonprod project.
const NEON_DEFAULT_BUDGET_USD = 60;

/** The monthly Neon budget, `NEON_MONTHLY_BUDGET_USD` or its default. */
export function neonBudgetUsd(): number {
  return (
    defineEnv([digestEnv.pick({ NEON_MONTHLY_BUDGET_USD: true })]).NEON_MONTHLY_BUDGET_USD ??
    NEON_DEFAULT_BUDGET_USD
  );
}

export const SOURCE_TIMEOUT_MS = 10_000;

export type SpendScope = {
  scope: string;
  day: ProviderCost;
  cap: ProviderCost;
  month: ProviderCost;
};

export type NeonProject = {
  name: string;
  computeHours: number;
  storageGbMonths: number;
  spendUsd: number;
};

export type WorkflowSpend = {
  estimatedEvents: number;
  spendUsd: number;
  budgetUsd: number;
  ratio: number;
};

/** What the "Escalones pendientes" section reads: the launch checks and the volume triggers. */
export type StagesInput = {
  checks: readonly CheckResult[];
  /** Whether each gated flag is on in production. */
  flagsOn: SourceResult<Readonly<Record<GatedFlag, boolean>>>;
  triggers: Readonly<
    Record<"spendCapPressure" | "primitiveLatency" | "providerVolume", SourceResult<boolean>>
  >;
};

export type DigestInput = {
  /** The run's date, `YYYY-MM-DD`. */
  date: string;
  /** The day that just closed, which the spend and email counts describe. */
  day: string;
  spend: SourceResult<readonly SpendScope[]>;
  dataforseo: SourceResult<{ balanceUsd: number }>;
  neon: SourceResult<{ budgetUsd: number; projects: readonly NeonProject[] }>;
  github: SourceResult<ActionsUsage>;
  posthog: SourceResult<{ events: number; exceptions: number }>;
  posthogPlan: PostHogPlan;
  resend: SourceResult<{ sent: number; limit: number }>;
  workflows: SourceResult<WorkflowSpend>;
  switches: SourceResult<Readonly<Record<string, boolean>>>;
  stages: StagesInput;
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

function budgetCrossing(percent: number, t: DigestThresholds): Crossing | null {
  const p = Math.round(percent * 100) / 100;
  if (p >= t.budget.critical) return { severity: "critical", threshold: t.budget.critical };
  if (p >= t.budget.warning) return { severity: "warning", threshold: t.budget.warning };
  return null;
}

const triggerState = (fired: SourceResult<boolean>) =>
  !fired.ok
    ? "disparador sin dato"
    : fired.value
      ? "disparador cumplido"
      : "disparador sin cumplir";

/**
 * Every provider tier still pending, with its cost, its trigger and whether the trigger fired. A
 * launch stage is pending while one of its checks does not pass, and its trigger fires once its
 * gated flag is on in production.
 */
function stageLines(stages: StagesInput): string[] {
  const checks = new Map(stages.checks.map((c) => [c.id, c]));
  const lines: string[] = [];
  for (const stage of PENDING_STAGES) {
    const head = `- ${stage.name} · ${stage.cost} · ${stage.trigger}`;
    if ("checks" in stage) {
      const open = stage.checks
        .map((id): CheckResult => checks.get(id) ?? { id, status: "unknown", reason: "sin dato" })
        .filter((c) => c.status !== "pass");
      if (open.length === 0) continue;
      const { flagsOn } = stages;
      const fired: SourceResult<boolean> = flagsOn.ok
        ? { ok: true, value: stage.gates.some((flag) => flagsOn.value[flag]) }
        : flagsOn;
      const failing = open.filter((c) => c.status === "fail").map((c) => c.reason);
      const unverified = open.filter((c) => c.status === "unknown").map((c) => c.reason);
      const detail = [
        ...(failing.length > 0 ? [`falta: ${failing.join("; ")}`] : []),
        ...(unverified.length > 0 ? [`sin verificar: ${unverified.join("; ")}`] : []),
      ];
      lines.push(`${head} · ${triggerState(fired)} · ${detail.join(" · ")}`);
    } else if ("volume" in stage) {
      lines.push(`${head} · ${triggerState(stages.triggers[stage.volume])}`);
    } else {
      lines.push(`${head} · ${stage.verifiedBy}`);
    }
  }
  return ["Escalones pendientes", ...(lines.length > 0 ? lines : ["- ninguno"])];
}

/**
 * The digest's text and the alerts its thresholds cross. Pure: every reading arrives in `input`.
 * Workflow spend, spend caps, pending stages and their triggers appear only in the text; their
 * alerts are raised where they are measured, so the digest never duplicates them.
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

  const neon = section("Neon", input.neon, ({ budgetUsd, projects }) => {
    const spend = projects.reduce((sum, p) => sum + p.spendUsd, 0);
    const percent = budgetUsd > 0 ? (spend / budgetUsd) * 100 : 100;
    const hit = budgetCrossing(percent, t);
    if (hit) {
      alerts.push({
        kind: "neon-quota",
        payload: {
          source: "neon",
          spend_usd: Math.round(spend * 100) / 100,
          budget_usd: budgetUsd,
          percent: Math.round(percent),
          ...hit,
        },
      });
    }
    return [
      "Neon (plan Launch, mes en curso)",
      ...projects.map(
        (p) =>
          `- ${p.name}: ${num(p.computeHours)} CU-h · ${num(p.storageGbMonths)} GB-mes · ${usd(p.spendUsd)}`,
      ),
      `- gasto del mes ${usd(spend)} de ${usd(budgetUsd)} (${pct(percent)})`,
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

  const limits = postHogLimits(input.posthogPlan);
  const posthog = section("PostHog", input.posthog, (u) => {
    // On pay-as-you-go nothing is dropped past the allowances; PostHog's billing limits cap spend.
    if (limits.events === null || limits.exceptions === null) {
      return [
        `PostHog (pago por uso): ${num(u.events)} eventos · ${num(u.exceptions)} excepciones este mes`,
      ];
    }
    const events = (u.events / limits.events) * 100;
    const exceptions = (u.exceptions / limits.exceptions) * 100;
    quota("posthog-events", events);
    quota("posthog-exceptions", exceptions);
    return [
      `PostHog: ${num(u.events)} eventos de ${num(limits.events)} (${pct(events)}) · ${num(u.exceptions)} excepciones de ${num(limits.exceptions)} (${pct(exceptions)})`,
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
    ...section("Workflows (estimado)", input.workflows, (w) => [
      `Workflows (estimado): ${num(w.estimatedEvents)} eventos · ${usd(w.spendUsd)} de ${usd(w.budgetUsd)} (${pct(w.ratio * 100)})`,
    ]),
    "",
    ...section("Kill switches", input.switches, (switches) => [
      "Kill switches",
      ...Object.entries(switches).map(([key, on]) => `- ${key}: ${on ? "encendido" : "apagado"}`),
    ]),
    "",
    ...stageLines(input.stages),
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
