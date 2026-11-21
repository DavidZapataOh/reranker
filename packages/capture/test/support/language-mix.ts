import { randomUUID } from "node:crypto";
import { resetAppEnv } from "@reranker/env";
import { beforeEach, vi } from "vitest";

export const ADS = "/v3/keywords_data/google_ads/search_volume/live";
export const AI = "/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live";

type Volumes = Record<string, number>;

/** DataForSEO's volume endpoints, answering in their documented envelope. */
export const provider = {
  calls: [] as { path: string; location: number; language?: string }[],
  /** Volumes by Google Ads location code; unlisted keywords come back null. */
  ads: new Map<number, Volumes>(),
  ai: new Map<string, Volumes>(),
  delayMs: 0,
  status: 200,
  taskStatus: 20000,
};

const envelope = (taskStatus: number, cost: number, result: unknown[]) => ({
  status_code: 20000,
  status_message: "Ok.",
  cost,
  tasks: [{ id: randomUUID(), status_code: taskStatus, status_message: "Ok.", cost, result }],
});

async function fakeDataForSeo(url: string, init?: RequestInit): Promise<Response> {
  const { pathname } = new URL(url);
  const [task] = JSON.parse(String(init?.body)) as [
    { keywords: string[]; location_code: number; language_code?: string },
  ];
  provider.calls.push({
    path: pathname,
    location: task.location_code,
    ...(task.language_code && { language: task.language_code }),
  });
  await new Promise((resolve) => setTimeout(resolve, provider.delayMs));
  if (provider.status !== 200) return new Response("Bad Gateway", { status: provider.status });
  if (pathname === ADS) {
    const volumes = provider.ads.get(task.location_code) ?? {};
    const rows = task.keywords.map((keyword) => ({
      keyword,
      search_volume: volumes[keyword] ?? null,
    }));
    return Response.json(envelope(provider.taskStatus, 0.09, rows));
  }
  if (pathname === AI) {
    const volumes = provider.ai.get(task.language_code ?? "") ?? {};
    const items = task.keywords.map((keyword) => ({
      keyword,
      ai_search_volume: volumes[keyword] ?? 0,
    }));
    return Response.json(envelope(20000, 0.0102, [{ items }]));
  }
  return new Response(null, { status: 404 });
}

/** Resets the fake before each test and routes every fetch to it. */
export function installFakeDataForSeo(): void {
  beforeEach(() => {
    // The sandbox base, whose host the fake answers for like any other.
    vi.stubEnv("APP_ENV", "development");
    resetAppEnv();
    vi.stubEnv("DATAFORSEO_LOGIN", "language-mix-test");
    vi.stubEnv("DATAFORSEO_PASSWORD", "language-mix-test-password");
    vi.stubGlobal("fetch", vi.fn(fakeDataForSeo));
    Object.assign(provider, {
      calls: [],
      ads: new Map(),
      ai: new Map(),
      delayMs: 0,
      status: 200,
      taskStatus: 20000,
    });
  });
}
