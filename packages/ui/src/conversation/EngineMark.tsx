import type { EngineId } from "@reranker/i18n";
import { copy } from "../copy.ts";

// The consuming app serves the brand marks from /engines, the same files the landing uses.
const icons: Record<EngineId, string> = {
  chatgpt: "/engines/openai.svg",
  gemini: "/engines/gemini.svg",
  "google-ai-overview": "/engines/google.svg",
  perplexity: "/engines/perplexity.svg",
};

export function EngineMark({ engine, size = 16 }: { engine: EngineId; size?: 16 | 20 }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[14px] leading-tight font-semibold text-ink">
      {/* biome-ignore lint/performance/noImgElement: the package is framework-agnostic and the icons are static SVG with fixed dimensions */}
      <img src={icons[engine]} alt="" width={size} height={size} className="shrink-0" />
      {copy.engines[engine]}
    </span>
  );
}
