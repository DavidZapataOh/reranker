import {
  createTranslator,
  type IntlError,
  type NamespaceKeys,
  type NestedKeyOf,
} from "use-intl/core";
import messages from "../messages/es-CO.json" with { type: "json" };
import { defaultTimeZone, getFormats } from "./formats";
import type { Locale } from "./locales";

export type Messages = typeof messages;

export type TranslatorOptions = {
  // By default a message that cannot be rendered is logged and replaced by its key.
  readonly onError?: (error: IntlError) => void;
};

// Statically imported: with a single locale there is nothing to load lazily.
export function getTranslator<N extends NamespaceKeys<Messages, NestedKeyOf<Messages>>>(
  locale: Locale,
  namespace: N,
  options: TranslatorOptions = {},
) {
  return createTranslator({
    locale,
    messages,
    namespace,
    timeZone: defaultTimeZone(locale),
    formats: getFormats(locale),
    ...options,
  });
}
