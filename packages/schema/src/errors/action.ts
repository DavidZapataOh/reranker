import type { Locale } from "@reranker/i18n";
import { type ProblemDetails, toProblem } from "./problem";

// Next.js hides thrown Server Action errors in production, so failures travel as data.
export type ActionResult<T> = { ok: true; data: T } | { ok: false; problem: ProblemDetails };

export async function toActionResult<T>(
  fn: () => Promise<T>,
  ctx: { locale: Locale; rethrow?: (error: unknown) => void },
): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    // Framework control flow (redirect, notFound) must escape before it is turned into a problem.
    ctx.rethrow?.(error);
    return { ok: false, problem: toProblem(error, { locale: ctx.locale }) };
  }
}
