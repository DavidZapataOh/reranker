import { inspect } from "node:util";
import { DEFAULT_LOCALE, type Locale } from "@reranker/i18n";
import {
  type ActionResult,
  isAppError,
  PROBLEM_CONTENT_TYPE,
  type ProblemDetails,
  toActionResult,
  toProblem,
} from "@reranker/schema";
import { captureServerEvent, log, requestIdFrom, scrub } from "@reranker/telemetry";
import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { getLocale } from "next-intl/server";

// The cause is for logs only: it never reaches a response, and what is logged is scrubbed first.
function describeCause(error: unknown): string {
  const cause = isAppError(error) ? (error.cause ?? error) : error;
  return inspect(scrub(cause), { depth: 4 });
}

// Reporting is best effort: a failing logger or telemetry must never change what the caller returns.
function report(error: unknown, problem: ProblemDetails, requestId: string | undefined): void {
  try {
    const attrs = {
      code: problem.code,
      status: problem.status,
      ...(requestId === undefined ? {} : { request_id: requestId }),
    };
    if (problem.status >= 500) {
      log.error("problem returned", { ...attrs, cause: describeCause(error) });
    } else {
      log.warn("problem returned", attrs);
    }
    captureServerEvent(
      { name: "problem_returned", props: { code: problem.code, status: problem.status } },
      { subject: { system: true } },
    );
  } catch {
    // Nothing is left to report to.
  }
}

/** The RFC 9457 response for an error thrown inside a Route Handler. */
export async function problemResponse(error: unknown, request: Request): Promise<Response> {
  const requestId = requestIdFrom(request.headers);
  const problem = toProblem(error, {
    locale: DEFAULT_LOCALE,
    requestId,
    instance: new URL(request.url).pathname,
  });
  report(error, problem, requestId);
  const response = new Response(JSON.stringify(problem), {
    status: problem.status,
    headers: { "Content-Type": PROBLEM_CONTENT_TYPE },
  });
  if (problem.retry_after !== undefined) {
    response.headers.set("Retry-After", String(problem.retry_after));
  }
  return response;
}

async function currentRequestId(): Promise<string | undefined> {
  try {
    return requestIdFrom(await headers());
  } catch {
    // Outside a request there is no id to tie the log line to.
    return undefined;
  }
}

/** Runs a Server Action body: failures travel as an RFC 9457 problem; redirect and notFound pass through. */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  let thrown: unknown;
  const result = await toActionResult(
    async () => {
      try {
        return await fn();
      } catch (error) {
        thrown = error;
        throw error;
      }
    },
    { locale: (await getLocale()) as Locale, rethrow: unstable_rethrow },
  );
  if (!result.ok) report(thrown, result.problem, await currentRequestId());
  return result;
}
