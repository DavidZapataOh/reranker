import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProxyTracerProvider, trace } from "@opentelemetry/api";
import { type CheckResult, type Cron, type LaunchInputs, verdict } from "./types";

const SMOKE_PATH = "/api/cron/smoke";
const SMOKE_EVERY_MINUTES = 15;

/** Traces of every request with `@vercel/otel` (https://vercel.com/docs/tracing/instrumentation). */
export function checkTraces(tracing: boolean): CheckResult {
  return verdict(
    "traces",
    tracing ? [] : ["no hay proveedor de trazas registrado con @vercel/otel"],
    "trazas con @vercel/otel",
  );
}

// Minutes a cron's minute field fires on, or null for a field this check does not read.
function minutesOf(field: string): number[] | null {
  const step = /^(?:\*|0-59)\/(\d+)$/.exec(field);
  if (step) {
    const every = Number(step[1]);
    return Array.from({ length: Math.ceil(60 / every) }, (_, i) => i * every);
  }
  if (field === "*") return Array.from({ length: 60 }, (_, i) => i);
  if (!/^\d+(,\d+)*$/.test(field)) return null;
  return field
    .split(",")
    .map(Number)
    .sort((a, b) => a - b);
}

function everyFifteenMinutes(schedule: string): boolean {
  const [minute, ...rest] = schedule.trim().split(/\s+/);
  if (!minute || rest.length !== 4 || rest.some((f) => f !== "*")) return false;
  const minutes = minutesOf(minute);
  if (!minutes || minutes.length === 0) return false;
  const gaps = minutes.map((m, i) => (minutes[i + 1] ?? (minutes[0] ?? 0) + 60) - m);
  return Math.max(...gaps) <= SMOKE_EVERY_MINUTES;
}

/** A per-engine smoke test registered as a Vercel cron at least every 15 minutes. */
export function checkSmokeCron(crons: readonly Cron[]): CheckResult {
  const smoke = crons.find((c) => c.path.startsWith(SMOKE_PATH) && everyFifteenMinutes(c.schedule));
  return verdict(
    "smoke-cron",
    smoke ? [] : [`no hay cron de ${SMOKE_PATH} cada ${SMOKE_EVERY_MINUTES} min en vercel.json`],
    `${SMOKE_PATH} cada ${SMOKE_EVERY_MINUTES} min`,
  );
}

const NOOP = new ProxyTracerProvider().getDelegate();

/** Whether this process registered a tracer provider, as `registerOTel` does at startup. */
export function tracerRegistered(): boolean {
  const provider = trace.getTracerProvider();
  return provider instanceof ProxyTracerProvider ? provider.getDelegate() !== NOOP : true;
}

/**
 * The inputs as the repository at `root` declares them, for runs outside the deployment: the
 * crons of `apps/web/vercel.json`, whether the instrumentation registers `@vercel/otel`, and the
 * email brake in the environment the command runs with. The spend caps need the deployment.
 */
export function repositoryInputs(root: string, env = process.env): LaunchInputs {
  const vercel = JSON.parse(readFileSync(join(root, "apps/web/vercel.json"), "utf8")) as {
    crons?: Cron[];
  };
  const instrumentation = join(root, "apps/web/src/instrumentation.ts");
  const source = existsSync(instrumentation) ? readFileSync(instrumentation, "utf8") : "";
  const floor = Number(env.QUOTA_RESEND_EMAILS_HOURLY_FLOOR);
  return {
    crons: vercel.crons ?? [],
    tracing: /from\s+["']@vercel\/otel["']/.test(source) && source.includes("registerOTel("),
    resendHourlyFloor:
      env.QUOTA_RESEND_EMAILS_HOURLY_FLOOR && Number.isInteger(floor) ? floor : undefined,
    spendCaps: undefined,
  };
}
