import { DEFAULT_LOCALE, getTranslator } from "@reranker/i18n";
import { z } from "zod";
import { es } from "zod/locales";

const t = getTranslator(DEFAULT_LOCALE, "errors.validation");

type Params = Record<string, string | number>;

// Only metadata is forwarded to the message: never `input`, which can hold personal data.
function safeParams(iss: z.core.$ZodRawIssue): Params {
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

function translateIssue(iss: z.core.$ZodRawIssue): string | undefined {
  if (!t.has(iss.code)) return undefined;
  return t(iss.code as Parameters<typeof t>[0], safeParams(iss));
}

z.config(es());
z.config({ customError: translateIssue });

export { z };
