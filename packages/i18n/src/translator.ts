import { createTranslator, type NamespaceKeys, type NestedKeyOf } from "use-intl/core";
import messages from "../messages/es-CO.json" with { type: "json" };
import type { Locale } from "./locales";

export type Messages = typeof messages;

// Statically imported: with a single locale there is nothing to load lazily.
export function getTranslator<N extends NamespaceKeys<Messages, NestedKeyOf<Messages>>>(
  locale: Locale,
  namespace: N,
) {
  return createTranslator({ locale, messages, namespace });
}
