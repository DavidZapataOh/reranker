import { defineEnv } from "@reranker/env";
import { z } from "@reranker/schema";
import { launchEnv } from "../env";
import { httpError, SourceError } from "../providers/source-error";
import { type CheckResult, verdict } from "./types";

// https://vercel.com/docs/rest-api/teams/get-a-team
const TEAM = "https://api.vercel.com/v2/teams/team_Z821WJ1qhLyT3ohz19uC3MOm";
// Vercel answers every request of a disabled team with 402 DEPLOYMENT_DISABLED
// (https://vercel.com/docs/errors/DEPLOYMENT_DISABLED), so this needs no token.
const HEALTH = "https://reranker.co/api/health";
const PAID_PLANS = new Set(["pro", "enterprise"]);

const env = launchEnv.pick({ VERCEL_BILLING_READ_TOKEN: true });

// The published schema only lists `billing.plan`. The team also carries `billing.status`,
// `softBlock` and `blocked`, which Vercel sets when an invoice goes unpaid; `softBlock` has the
// shape it has, documented, on the user (`GET /v2/user`).
const Team = z.object({
  billing: z.object({ plan: z.string(), status: z.string().nullish() }).nullable(),
  softBlock: z.object({ reason: z.string().nullish() }).nullish(),
  blocked: z.unknown().optional(),
});

type Reading = { problems: string[]; unverified: string[] };

function why(error: unknown): string {
  if (error instanceof SourceError) return error.message;
  return error instanceof Error ? `error inesperado (${error.name})` : "error inesperado";
}

async function readTeam(signal: AbortSignal | undefined): Promise<Reading> {
  const token = defineEnv([env]).VERCEL_BILLING_READ_TOKEN;
  if (!token) throw new SourceError("falta VERCEL_BILLING_READ_TOKEN");
  const response = await fetch(TEAM, {
    headers: { Authorization: `Bearer ${token}` },
    ...(signal && { signal }),
  });
  if (!response.ok) throw httpError(response);
  const team = Team.parse(await response.json());
  const problems: string[] = [];
  const unverified: string[] = [];
  if (team.softBlock) {
    const reason = team.softBlock.reason;
    problems.push(`Vercel tiene bloqueado el equipo${reason ? ` (${reason})` : ""}`);
  }
  if (team.blocked != null && team.blocked !== false) problems.push("el equipo está bloqueado");
  if (!team.billing) {
    problems.push("el equipo no tiene plan");
  } else {
    const { plan, status } = team.billing;
    if (!PAID_PLANS.has(plan)) problems.push(`el equipo está en ${plan}`);
    if (!status) unverified.push("Vercel no informa el estado del plan");
    else if (status !== "active") problems.push(`el plan está ${status}`);
  }
  return { problems, unverified };
}

async function probeSite(signal: AbortSignal | undefined): Promise<Reading> {
  let response: Response;
  try {
    response = await fetch(HEALTH, { cache: "no-store", ...(signal && { signal }) });
  } catch {
    return { problems: [], unverified: ["reranker.co sin respuesta"] };
  }
  await response.body?.cancel();
  // Any other failure is the uptime monitors' to report; only a 402 is about billing.
  return { problems: response.status === 402 ? ["reranker.co responde 402"] : [], unverified: [] };
}

/**
 * The Vercel team is paid up and serving: not blocked, on a paid plan whose status is active, and
 * reranker.co not answering 402. The site probe runs without the token, so a disabled deployment
 * fails the check even when the plan cannot be read.
 */
export async function checkVercelBilling(signal?: AbortSignal): Promise<CheckResult> {
  const readings = await Promise.all([
    readTeam(signal).catch((error: unknown) => ({ problems: [], unverified: [why(error)] })),
    probeSite(signal),
  ]);
  const problems = readings.flatMap((r) => r.problems);
  const unverified = readings.flatMap((r) => r.unverified);
  if (problems.length === 0 && unverified.length > 0) {
    return { id: "vercel-billing", status: "unknown", reason: unverified.join("; ") };
  }
  return verdict("vercel-billing", problems, "plan Pro activo, sin bloqueo y reranker.co responde");
}
