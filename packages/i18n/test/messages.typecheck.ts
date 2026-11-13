import { DEFAULT_LOCALE, getTranslator } from "../src/index";

// Compiled by `tsc --noEmit`, never run: an unknown message key must fail the type check.
const t = getTranslator(DEFAULT_LOCALE, "common");
// @ts-expect-error unknown keys must not compile
t("doesNotExist");
t("appName");
