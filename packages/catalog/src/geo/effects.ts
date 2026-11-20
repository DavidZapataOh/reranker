import { readFileSync } from "node:fs";
import { getCountry } from "@reranker/i18n/countries";
import type { CaptureProvider, EngineId } from "@reranker/schema";
import type { EngineGeo, GeoTarget, QuestionScope } from "@reranker/schema/measurement";

export type ChatgptCityEffect = "confirmed" | "not_shown";

export type GeoForEngineOptions = {
  provider?: CaptureProvider;
  chatgptCityEffect?: ChatgptCityEffect;
};

// Written by the precision benchmark once it has measured whether ChatGPT answers change with
// the coordinate; until then ChatGPT is only ever labelled by country.
const BASELINE = new URL("../../../benchmark/baseline.json", import.meta.url);

export function readChatgptCityEffect(file: URL): ChatgptCityEffect {
  let baseline: { chatgptCityEffect?: unknown } | null;
  try {
    baseline = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "not_shown";
    throw error;
  }
  return baseline?.chatgptCityEffect === "confirmed" ? "confirmed" : "not_shown";
}

let cityEffect: ChatgptCityEffect | undefined;

export function chatgptCityEffect(): ChatgptCityEffect {
  cityEffect ??= readChatgptCityEffect(BASELINE);
  return cityEffect;
}

/**
 * The location the report declares for an engine: only what that engine is actually asked
 * from. `null` when the engine is not offered in the business country.
 */
export function geoForEngine(
  engine: EngineId,
  target: GeoTarget,
  scope: QuestionScope,
  opts: GeoForEngineOptions = {},
): EngineGeo | null {
  const country = getCountry(target.country);
  if (!country.engines.includes(engine)) return null;
  const byCountry: EngineGeo = { level: "country", label: country.name };
  if (scope === "national" || target.level === "country") return byCountry;

  switch (engine) {
    // Google is targeted by DataForSEO location code, which stops at the region for
    // municipalities without one of their own.
    case "google-ai-overview":
    case "google-ai-mode":
      return { level: target.dataforseo.level, label: target.dataforseo.label };
    // Gemini is asked from a coordinate, so it is declared at the place that point belongs to:
    // the municipality itself, or the region of a town no source locates.
    case "gemini":
      if (!target.center) return byCountry;
      return { level: target.center.level, label: target.center.label };
    case "chatgpt": {
      const byCity =
        opts.provider === "brightdata" &&
        target.center?.level === "city" &&
        (opts.chatgptCityEffect ?? chatgptCityEffect()) === "confirmed";
      return byCity ? { level: "city", label: target.name } : byCountry;
    }
    case "perplexity":
      return byCountry;
  }
}
