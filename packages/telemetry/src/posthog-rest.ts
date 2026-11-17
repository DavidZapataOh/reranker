import { z } from "@reranker/schema";

// The private API lives on the app host; us.i.posthog.com only ingests events and serves /flags.
const APP_HOST = "https://us.posthog.com";
const PROJECT_ID = 711803;
const TIMEOUT_MS = 15_000;
const PAGE_SIZE = 100;

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
 * Bearer-authenticated client for the project's private REST API. Paths are relative to
 * `/api/projects/{id}/`, and the key only ever goes to the app host.
 */
export function createPostHogRest(apiKey: string) {
  const base = `${APP_HOST}/api/projects/${PROJECT_ID}/`;

  async function request(url: string, init?: RequestInit, signal?: AbortSignal): Promise<unknown> {
    // Whatever a paginated `next` link says, the key is not sent elsewhere.
    if (new URL(url).origin !== APP_HOST) throw new Error(`Refusing to call ${url}`);
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
        : AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { detail?: string } | null;
      throw new PostHogApiError(res.status, body?.detail ?? res.statusText);
    }
    return res.json();
  }

  return {
    send(
      path: string,
      method: "POST" | "PATCH",
      body: unknown,
      signal?: AbortSignal,
    ): Promise<unknown> {
      return request(`${base}${path}`, { method, body: JSON.stringify(body) }, signal);
    },
    /** Every row of a paginated list endpoint, following the `next` links. */
    async list<S extends z.ZodType>(path: string, row: S): Promise<z.output<S>[]> {
      const page = z.object({ next: z.string().nullable(), results: z.array(row) });
      const rows: z.output<S>[] = [];
      const sep = path.includes("?") ? "&" : "?";
      let url: string | null = `${base}${path}${sep}limit=${PAGE_SIZE}`;
      while (url) {
        const parsed: z.output<typeof page> = page.parse(await request(url));
        rows.push(...parsed.results);
        url = parsed.next;
      }
      return rows;
    },
  };
}
