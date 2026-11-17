import { defineEnv } from "@reranker/env";
import { Resend } from "resend";
import { alertEnv } from "../alerts";
import { type CheckResult, verdict } from "./types";

// Resend Free sends at most 100 emails a day; paid plans have no daily quota
// (https://resend.com/docs/knowledge-base/account-quotas-and-limits).
const FREE_DAILY_QUOTA = 100;
// Only sent to Free plan users (https://resend.com/docs/api-reference/rate-limit).
const FREE_PLAN_HEADER = "x-resend-daily-quota";

const env = alertEnv.pick({ RESEND_API_KEY: true });

const unknown = (reason: string): [CheckResult, CheckResult] => [
  { id: "resend-plan", status: "unknown", reason },
  { id: "resend-sending-key", status: "unknown", reason },
];

/**
 * Resend exposes neither the plan nor a key's permission, so both come from the closest documented
 * signals of one read-only call: listing domains answers 401 `restricted_api_key` to a
 * sending-only key (https://resend.com/docs/api-reference/errors), and only Free accounts get the
 * daily quota header. The plan also needs the configured quota recalculated past Free's 100.
 */
export async function checkResend(
  dailyQuota: number | undefined,
): Promise<[CheckResult, CheckResult]> {
  const key = defineEnv([env]).RESEND_API_KEY;
  if (!key) return unknown("falta RESEND_API_KEY");
  const { data, error, headers } = await new Resend(key).domains.list();
  // The SDK reports a request that never got an answer as an error without a status.
  const answered = data !== null || typeof error?.statusCode === "number";
  const noAnswer = `sin respuesta de Resend (${error?.name ?? "error"})`;

  const plan: string[] = [];
  if (headers?.[FREE_PLAN_HEADER] !== undefined) plan.push("la cuenta sigue en Resend Free");
  if (dailyQuota === undefined || dailyQuota <= FREE_DAILY_QUOTA) {
    plan.push(
      `QUOTA_RESEND_EMAILS_DAILY en ${dailyQuota ?? FREE_DAILY_QUOTA}, el cupo de Resend Free`,
    );
  }
  const planResult: CheckResult =
    plan.length === 0 && !answered
      ? { id: "resend-plan", status: "unknown", reason: noAnswer }
      : verdict("resend-plan", plan, `cupo diario de ${dailyQuota} sin el límite de Resend Free`);

  let sending: CheckResult;
  if (error?.name === "restricted_api_key" && error.statusCode === 401) {
    sending = { id: "resend-sending-key", status: "pass", reason: "la clave solo envía correos" };
  } else if (data) {
    sending = {
      id: "resend-sending-key",
      status: "fail",
      reason: "la clave de producción tiene acceso total",
    };
  } else {
    sending = {
      id: "resend-sending-key",
      status: "unknown",
      reason: answered ? `respuesta HTTP ${error?.statusCode} (${error?.name})` : noAnswer,
    };
  }
  return [planResult, sending];
}
