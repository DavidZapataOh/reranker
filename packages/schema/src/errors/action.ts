import type { Locale } from "@reranker/i18n";
import { isAppError } from "./app-error";
import { type ProblemDetails, toProblem } from "./problem";

// Next.js hides thrown Server Action errors in production, so failures travel as data.
export type ActionResult<T> = { ok: true; data: T } | { ok: false; problem: ProblemDetails };

export async function toActionResult<T>(
  fn: () => Promise<T>,
  ctx: {
    locale: Locale;
    rethrow?: (error: unknown) => void;
    // Reports what the caller only sees as "internal": AppErrors are expected outcomes.
    onError?: (error: unknown) => void;
  },
): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    // Framework control flow (redirect, notFound) must escape before it is turned into a problem.
    ctx.rethrow?.(error);
    if (!isAppError(error)) ctx.onError?.(error);
    return { ok: false, problem: toProblem(error, { locale: ctx.locale }) };
  }
}
