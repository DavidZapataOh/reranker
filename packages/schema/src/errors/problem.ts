import { getTranslator, type Locale } from "@reranker/i18n";
import { registerSchema } from "../registry";
import { z } from "../z";
import { type FieldError, isAppError } from "./app-error";
import { ERROR_CODES, ERRORS, type ErrorCode } from "./catalog";

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

const TYPE_BASE = "https://reranker.co/errores/";

export const ProblemDetails = registerSchema(
  "ProblemDetails",
  z
    .strictObject({
      type: z.url(),
      title: z.string().min(1),
      status: z.int().min(400).max(599),
      detail: z.string().min(1),
      instance: z.string().optional(),
      code: z.enum(ERROR_CODES),
      request_id: z.string().nullable(),
      retry_after: z.int().nonnegative().optional(),
      errors: z
        .array(z.strictObject({ pointer: z.string(), code: z.string(), detail: z.string() }))
        .optional(),
    })
    .refine((p) => !ERRORS[p.code].retryable || p.retry_after !== undefined, {
      path: ["retry_after"],
    }),
);

export type ProblemDetails = z.infer<typeof ProblemDetails>;

type Translator = ReturnType<typeof getTranslator<"errors">>;
type MessageKey = Parameters<Translator>[0];
type Params = Record<string, string | number>;

function rethrow(error: Error): never {
  throw error;
}

// One translator per locale keeps compiled ICU messages cached across calls. Field params come
// from callers, so field details use a strict translator that throws instead of rendering a key.
const translators = new Map<Locale, { t: Translator; strict: Translator }>();

function translatorsFor(locale: Locale): { t: Translator; strict: Translator } {
  let pair = translators.get(locale);
  if (!pair) {
    pair = {
      t: getTranslator(locale, "errors"),
      strict: getTranslator(locale, "errors", { onError: rethrow }),
    };
    translators.set(locale, pair);
  }
  return pair;
}

function toMessageParams(params: Record<string, unknown> | undefined): Params {
  const result: Params = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value === "string" || typeof value === "number") result[key] = value;
    else if (typeof value === "boolean") result[key] = String(value);
  }
  return result;
}

// A rule without a message, or params that cannot fill it, gets the generic field message.
function fieldDetail(strict: Translator, field: FieldError): string {
  const key = `validation.${field.code}` as MessageKey;
  if (strict.has(key)) {
    try {
      return strict(key, toMessageParams(field.params));
    } catch {
      // Params that cannot fill the message get the generic one below.
    }
  }
  return strict("validation.custom");
}

export function toProblem(
  error: unknown,
  ctx: { locale: Locale; instance?: string; requestId?: string },
): ProblemDetails {
  const { t, strict } = translatorsFor(ctx.locale);
  const known = isAppError(error) && error.code !== "internal" ? error : undefined;
  const code: ErrorCode = known?.code ?? "internal";
  const definition: { status: number; retryAfterSeconds?: number } = ERRORS[code];
  const retryAfter = known?.retryAfterSeconds ?? definition.retryAfterSeconds;
  const params: Params = { ...known?.params };
  if (retryAfter !== undefined) {
    params.seconds = retryAfter;
    params.minutes = Math.ceil(retryAfter / 60);
    params.hours = retryAfter >= 3600 ? Math.ceil(retryAfter / 3600) : 0;
  }

  const problem: ProblemDetails = {
    type: TYPE_BASE + code,
    title: t(`${code}.title` as MessageKey, params),
    status: definition.status,
    detail: t(`${code}.detail` as MessageKey, params),
    code,
    request_id: ctx.requestId ?? null,
  };
  if (ctx.instance !== undefined) problem.instance = ctx.instance;
  if (retryAfter !== undefined) problem.retry_after = retryAfter;
  if (known?.fieldErrors?.length) {
    problem.errors = known.fieldErrors.map((field) => ({
      pointer: field.pointer,
      code: field.code,
      detail: fieldDetail(strict, field),
    }));
  }
  return problem;
}
