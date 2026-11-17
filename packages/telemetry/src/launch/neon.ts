import { readNeonProduction } from "@reranker/db/neon-production";
import { defineEnv } from "@reranker/env";
import { DEFAULT_LOCALE, formatNumber } from "@reranker/i18n";
import { digestEnv } from "../env";
import { SourceError } from "../providers/source-error";
import { type CheckResult, verdict } from "./types";

const MIN_CU = 0.5;
const MAX_CU = 4;
const HISTORY_SECONDS = 7 * 86_400;
const NEVER_SUSPEND = -1;

const env = digestEnv.pick({ NEON_API_KEY: true, NEON_PROJECT_ID: true });
const cu = (n: number) => formatNumber(n, { locale: DEFAULT_LOCALE });

/**
 * reranker-prod as production needs it: no scale to zero (a cold start costs up to 1.2 s against a
 * 2 s connection timeout), 0.5–4 CU, 7 days of instant restore and a protected default branch.
 */
export async function checkNeonProduction(signal?: AbortSignal): Promise<CheckResult> {
  const { NEON_API_KEY: apiKey, NEON_PROJECT_ID: projectId } = defineEnv([env]);
  if (!apiKey || !projectId) throw new SourceError("falta NEON_API_KEY o NEON_PROJECT_ID");
  const prod = await readNeonProduction({
    apiKey,
    projectId,
    fetch: (input, init) => fetch(input, { ...init, ...(signal && { signal }) }),
  });
  const problems: string[] = [];
  const { compute, branch } = prod;
  if (!compute) {
    problems.push("la rama principal no tiene cómputo de lectura y escritura");
  } else {
    if (compute.suspendTimeoutSeconds !== NEVER_SUSPEND) problems.push("escala a cero encendida");
    if (compute.minCu < MIN_CU)
      problems.push(`mínimo ${cu(compute.minCu)} CU (pide ${cu(MIN_CU)})`);
    if (compute.maxCu < MAX_CU) problems.push(`máximo ${cu(compute.maxCu)} CU (pide ${MAX_CU})`);
  }
  if (prod.historyRetentionSeconds < HISTORY_SECONDS) {
    const days = cu(Math.round((prod.historyRetentionSeconds / 86_400) * 10) / 10);
    problems.push(`restauración de ${days} ${days === "1" ? "día" : "días"} (pide 7)`);
  }
  if (!branch?.protected) problems.push("la rama principal no está protegida");
  return verdict(
    "neon-production",
    problems,
    "siempre encendido, 0,5–4 CU, 7 días de restauración y rama protegida",
  );
}
