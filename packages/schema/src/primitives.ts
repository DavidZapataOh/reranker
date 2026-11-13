import { LOCALES } from "@reranker/i18n";
import { COUNTRIES } from "@reranker/i18n/countries";
import { CURRENCY_CODES } from "./decimal";
import { z } from "./z";

export const Uuid = z.uuid();
export const Timestamp = z.iso.datetime();
export const DateOnly = z.iso.date();

export const CountryCode = z.enum(Object.keys(COUNTRIES) as [keyof typeof COUNTRIES]);
export type CountryCode = z.infer<typeof CountryCode>;
export const CurrencyCode = z.enum(CURRENCY_CODES);
export type CurrencyCode = z.infer<typeof CurrencyCode>;
export const LocaleCode = z.enum(LOCALES);
export type LocaleCode = z.infer<typeof LocaleCode>;

export const Email = z.string().trim().toLowerCase().max(254).pipe(z.email());

export const Url = z.url({ protocol: /^https?$/, hostname: z.regexes.domain });

export const Cursor = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);

export const Page = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), next_cursor: Cursor.nullable() });

export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: Cursor.optional(),
});
