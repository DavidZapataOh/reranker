import type { EngineAnswer } from "./answer";

const GROUNDING_REDIRECT = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/";

async function locationOf(url: string, timeoutMs: number): Promise<string | undefined> {
  try {
    // Manual: only the Location header is needed, and the target site is never contacted.
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel();
    const location = res.headers.get("location");
    if (res.status < 300 || res.status > 399 || !location) return undefined;
    const target = new URL(location, url);
    return target.protocol === "https:" || target.protocol === "http:" ? target.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adds `resolvedUrl` to Gemini's grounding redirects, so a source can be attributed to its site.
 * The returned `url` is kept as is; a redirect that fails or is slow simply stays unresolved.
 */
export async function resolveRedirects(
  answer: EngineAnswer,
  opts: { timeoutMs?: number; concurrency?: number } = {},
): Promise<EngineAnswer> {
  const { timeoutMs = 3000, concurrency = 20 } = opts;
  const pending = [
    ...new Set(answer.sources.map((s) => s.url).filter((u) => u.startsWith(GROUNDING_REDIRECT))),
  ];
  if (pending.length === 0) return answer;

  const resolved = new Map<string, string>();
  const worker = async () => {
    for (let url = pending.pop(); url !== undefined; url = pending.pop()) {
      const target = await locationOf(url, timeoutMs);
      if (target !== undefined) resolved.set(url, target);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));

  return {
    ...answer,
    sources: answer.sources.map((source) => {
      const resolvedUrl = resolved.get(source.url);
      return resolvedUrl === undefined ? source : { ...source, resolvedUrl };
    }),
  };
}
