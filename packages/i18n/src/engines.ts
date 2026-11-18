// The closed list of answer engines measured in V0; countries and schemas derive from it.
export const ENGINES = [
  "chatgpt",
  "gemini",
  "google-ai-overview",
  "google-ai-mode",
  "perplexity",
] as const;

export type EngineId = (typeof ENGINES)[number];
