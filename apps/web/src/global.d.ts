import type { Locale, Messages } from "@reranker/i18n";
import type { formats } from "./i18n/request";

declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
    Formats: typeof formats;
  }
}
