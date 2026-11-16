import { z } from "@reranker/schema";

// The private API lives on the app host; us.i.posthog.com only ingests events and serves /flags.
const APP_HOST = "https://us.posthog.com";
const PROJECT_ID = 711803;
const TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;

export type RemoteFlag = { key: string; active: boolean };

export type CreateFlagPayload = {
  key: string;
  name: string;
  active: boolean;
  filters: {
    groups: {
      properties: { key: string; type: "person"; operator: "exact"; value: string[] }[];
      rollout_percentage: number;
    }[];
  };
  tags: string[];
};

const FlagPage = z.object({
  next: z.string().nullable(),
  results: z.array(z.object({ key: z.string(), active: z.boolean() })),
});

export class PostHogApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`PostHog API ${status}: ${detail}`);
    this.name = "PostHogApiError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Feature flag definitions API. Listing needs a personal API key with `feature_flag:read`, creating
 * one with `feature_flag:write`; project secret keys do not reach these endpoints.
 */
export function createPostHogApi(apiKey: string) {
  const base = `${APP_HOST}/api/projects/${PROJECT_ID}/feature_flags/`;

  async function request(url: string, init?: RequestInit): Promise<unknown> {
    // The key goes only to the app host, whatever a paginated `next` link says.
    if (new URL(url).origin !== APP_HOST) throw new Error(`Refusing to call ${url}`);
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { detail?: string } | null;
      throw new PostHogApiError(res.status, body?.detail ?? res.statusText);
    }
    return res.json();
  }

  return {
    /** Every live flag, following the paginated `next` links. */
    async listFlags(): Promise<RemoteFlag[]> {
      const flags: RemoteFlag[] = [];
      let url: string | null = `${base}?limit=${PAGE_SIZE}`;
      while (url) {
        const page: z.output<typeof FlagPage> = FlagPage.parse(await request(url));
        flags.push(...page.results);
        url = page.next;
      }
      return flags;
    },
    async createFlag(payload: CreateFlagPayload): Promise<void> {
      await request(base, { method: "POST", body: JSON.stringify(payload) });
    },
  };
}

export type PostHogApi = ReturnType<typeof createPostHogApi>;
