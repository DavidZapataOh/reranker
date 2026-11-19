import type { EngineAnswer } from "./answer";

// Gemini's grounding redirects, and the ones AI Overviews put in front of their references.
const REDIRECTS = [
  "https://vertexaisearch.cloud.google.com/grounding-api-redirect/",
  "https://google.com/goto?",
  "https://www.google.com/goto?",
];
// google.com/goto first moves to www.google.com/goto, which then names the site.
const MAX_HOPS = 3;

const isRedirect = (url: string) => REDIRECTS.some((prefix) => url.startsWith(prefix));

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

/** Where a chain of Google redirects leads, without ever contacting the site at its end. */
async function targetOf(url: string, timeoutMs: number): Promise<string | undefined> {
  let current = url;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const next = await locationOf(current, timeoutMs);
    if (next === undefined || !isRedirect(next)) return next;
    current = next;
  }
  return undefined;
}

/**
 * Adds `resolvedUrl` to Google's redirects (Gemini grounding, AI Overview references), so a source can be attributed to its site.
 * The returned `url` is kept as is; a redirect that fails or is slow simply stays unresolved.
 */
export async function resolveRedirects(
  answer: EngineAnswer,
  opts: { timeoutMs?: number; concurrency?: number } = {},
): Promise<EngineAnswer> {
  const { timeoutMs = 3000, concurrency = 20 } = opts;
  const pending = [...new Set(answer.sources.map((s) => s.url).filter(isRedirect))];
  if (pending.length === 0) return answer;

  const resolved = new Map<string, string>();
  const worker = async () => {
    for (let url = pending.pop(); url !== undefined; url = pending.pop()) {
      const target = await targetOf(url, timeoutMs);
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
