import { DEFAULT_LOCALE, getTranslator } from "@reranker/i18n";
// The namespace import keeps zod tree-shakeable for client bundles; the named `z` export does not.
import * as z from "zod";
import { es } from "zod/locales";

type Translator = ReturnType<typeof getTranslator<"errors.validation">>;
type MessageKey = Parameters<Translator>[0];
type Params = Record<string, string | number>;

let translator: Translator | undefined;

// Built on the first issue instead of at import: most modules that import z never fail a parse.
function validationTranslator(): Translator {
  translator ??= getTranslator(DEFAULT_LOCALE, "errors.validation");
  return translator;
}

// Only metadata is forwarded to the message: never `input`, which can hold personal data.
export function safeParams(iss: object): Params {
  const params: Params = {};
  const raw = iss as Record<string, unknown>;
  for (const key of ["origin", "minimum", "maximum", "inclusive", "format", "divisor"]) {
    const value = raw[key];
    if (typeof value === "string" || typeof value === "number") {
      params[key] = value;
    } else if (typeof value === "boolean") {
      params[key] = String(value);
    } else if (typeof value === "bigint") {
      params[key] = Number(value);
    }
  }
  if (typeof raw.expected === "string") params.expected = raw.expected;
  if (Array.isArray(raw.keys)) params.count = raw.keys.length;
  return params;
}

// A refinement names its message with `params: { code }`; codes outside the catalog stay "custom".
export function issueCode(iss: {
  readonly code: string;
  readonly params?: Record<string, unknown> | undefined;
}): string {
  const named = iss.params?.code;
  if (
    iss.code === "custom" &&
    typeof named === "string" &&
    validationTranslator().has(named as MessageKey)
  ) {
    return named;
  }
  return iss.code;
}

function translateIssue(iss: z.core.$ZodRawIssue): string | undefined {
  const t = validationTranslator();
  const code = issueCode(iss) as MessageKey;
  if (!t.has(code)) return undefined;
  return t(code, safeParams(iss));
}

z.config(es());
z.config({ customError: translateIssue });

export { z };
