import { logs, SeverityNumber } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { appEnv, defineEnv } from "@reranker/env";
import { runAfter } from "./after";
import { telemetryEnv } from "./env";
import { scrub } from "./scrub";

type Level = "debug" | "info" | "warn" | "error";
type Attributes = Record<string, string | number | boolean> & { request_id?: string };

const SEVERITY: Record<Level, { rank: number; number: SeverityNumber }> = {
  debug: { rank: 0, number: SeverityNumber.DEBUG },
  info: { rank: 1, number: SeverityNumber.INFO },
  warn: { rank: 2, number: SeverityNumber.WARN },
  error: { rank: 3, number: SeverityNumber.ERROR },
};

const DEFAULT_HOST = "https://us.i.posthog.com";
// Records with no request id (jobs, scripts) share one pending flush.
const UNSCOPED = "";

type State = {
  level: Level;
  provider: LoggerProvider | undefined;
  pending: Set<string>;
};

// Next bundles route handlers and instrumentation separately, so the state lives on globalThis.
const STATE = Symbol.for("reranker.telemetry.logger");
type Holder = typeof globalThis & { [STATE]?: State };

function create(): State {
  try {
    const env = defineEnv([telemetryEnv]);
    const token = env.POSTHOG_PROJECT_TOKEN;
    // Development has no project token by design: logs stay on the console.
    const exporting = appEnv() !== "development" && token !== undefined;
    return {
      level: env.LOG_LEVEL,
      pending: new Set(),
      provider: exporting
        ? new LoggerProvider({
            resource: resourceFromAttributes({
              "service.name": "web",
              "deployment.environment": appEnv(),
              "service.version": process.env.VERCEL_GIT_COMMIT_SHA || "dev",
            }),
            processors: [
              new BatchLogRecordProcessor({
                exporter: new OTLPLogExporter({
                  url: `${env.POSTHOG_HOST ?? DEFAULT_HOST}/i/v1/logs`,
                  headers: { Authorization: `Bearer ${token}` },
                }),
              }),
            ],
          })
        : undefined,
    };
  } catch (error) {
    // A broken environment must not silence the logs it is about to explain.
    console.error(scrub(error));
    return { level: "info", provider: undefined, pending: new Set() };
  }
}

function state(): State {
  const holder = globalThis as Holder;
  holder[STATE] ??= create();
  return holder[STATE];
}

/** The OTLP provider, or undefined where logs stay on the console (development, missing token). */
export function getLoggerProvider(): LoggerProvider | undefined {
  return state().provider;
}

/** Installs the provider globally so libraries that emit OpenTelemetry logs reach PostHog too. */
export function registerLogger(): void {
  const provider = state().provider;
  if (provider) logs.setGlobalLoggerProvider(provider);
}

/** Drops the cached state so a test can build another provider. */
export function resetLogger(): void {
  delete (globalThis as Holder)[STATE];
}

function scheduleFlush(current: State, provider: LoggerProvider, key: string): void {
  if (current.pending.has(key)) return;
  current.pending.add(key);
  runAfter(async () => {
    current.pending.delete(key);
    try {
      await provider.forceFlush();
    } catch (error) {
      console.error(scrub(error));
    }
  });
}

function emit(level: Level, message: string, attrs: Attributes | undefined): void {
  try {
    const current = state();
    if (SEVERITY[level].rank < SEVERITY[current.level].rank) return;
    const body = scrub(message);
    const attributes = scrub({ ...attrs });
    console[level](body, attributes);
    const provider = current.provider;
    if (!provider) return;
    provider.getLogger("reranker").emit({
      severityText: level,
      severityNumber: SEVERITY[level].number,
      body,
      attributes,
    });
    scheduleFlush(current, provider, attrs?.request_id ?? UNSCOPED);
  } catch (error) {
    try {
      console.error(scrub(error));
    } catch {
      // Logging is best effort; there is nowhere left to report.
    }
  }
}

/** Structured logs: leveled by LOG_LEVEL, scrubbed of personal data and exported to PostHog Logs. Never throws. */
export const log = {
  debug: (message: string, attrs?: Attributes) => emit("debug", message, attrs),
  info: (message: string, attrs?: Attributes) => emit("info", message, attrs),
  warn: (message: string, attrs?: Attributes) => emit("warn", message, attrs),
  error: (message: string, attrs?: Attributes) => emit("error", message, attrs),
};

/** The id Vercel stamps on every request, so a log line ties back to its request. */
export function requestIdFrom(headers: Headers): string {
  return headers.get("x-vercel-id") ?? "local";
}
