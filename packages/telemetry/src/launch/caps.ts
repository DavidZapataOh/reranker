import { DEFAULT_LOCALE, formatNumber } from "@reranker/i18n";
import type { ProviderCost } from "@reranker/schema";
import { type CheckResult, verdict } from "./types";

/** The daily caps a deployment runs with and, per provider, the lowest cap that never binds first. */
export type SpendCaps = {
  caps: Readonly<Record<string, ProviderCost>>;
  /** Micros by provider: what its purposes can spend on it, plus headroom. */
  floors: Readonly<Record<string, number>>;
};

// The free report cap sized by demand; below it real visitors are deferred before abuse is.
const FREE_REPORT_MIN_MICROS = 200_000_000;

const usd = (micros: number) =>
  `US$${formatNumber(micros / 1_000_000, { locale: DEFAULT_LOCALE })}`;

/** Fails when the free report cap is short of demand or a provider cap could starve a purpose. */
export function spendCapsCheck({ caps, floors }: SpendCaps): CheckResult {
  const problems: string[] = [];
  const freeReport = caps["purpose:free-report"]?.amount_micros ?? 0;
  if (freeReport < FREE_REPORT_MIN_MICROS) {
    problems.push(
      `tope del reporte gratis en ${usd(freeReport)}, por debajo de ${usd(FREE_REPORT_MIN_MICROS)}`,
    );
  }
  for (const [provider, floor] of Object.entries(floors)) {
    const cap = caps[`provider:${provider}`]?.amount_micros ?? 0;
    if (cap < floor) {
      problems.push(`tope de ${provider} en ${usd(cap)}, por debajo de ${usd(floor)}`);
    }
  }
  return verdict(
    "spend-caps",
    problems,
    `reporte gratis en ${usd(freeReport)} y ningún tope de proveedor frena a un propósito`,
  );
}
