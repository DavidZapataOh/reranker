import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { SourceError } from "./source-error";

const { dataforseoBalance } = await import("./dataforseo-balance");
const { githubActionsUsage } = await import("./github-actions-usage");
const { posthogUsage } = await import("./posthog-usage");
const { postHogLimits } = await import("../posthog-plan");
const { pingHeartbeat } = await import("./betterstack");

const USER_DATA = "https://api.dataforseo.com/v3/appendix/user_data";
const USAGE = "https://api.github.com/users/DavidZapataOh/settings/billing/usage";
const QUERY = "https://us.posthog.com/api/projects/711803/query/";
const HEARTBEAT = "https://uptime.betterstack.com/api/v1/heartbeat/token";

beforeAll(() => server.listen());
beforeEach(() => vi.stubEnv("APP_ENV", "production"));
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
});
afterAll(() => server.close());

function userData(balance: unknown, statusCode = 20000) {
  return {
    status_code: 20000,
    tasks: [{ status_code: statusCode, result: [{ login: "x", money: { total: 50, balance } }] }],
  };
}

describe("dataforseoBalance", () => {
  test("needs both credentials", async () => {
    vi.stubEnv("DATAFORSEO_LOGIN", "login");
    await expect(dataforseoBalance()).rejects.toThrow(
      new SourceError("falta DATAFORSEO_LOGIN o DATAFORSEO_PASSWORD"),
    );
  });

  test("reads the balance with basic auth", async () => {
    vi.stubEnv("DATAFORSEO_LOGIN", "login");
    vi.stubEnv("DATAFORSEO_PASSWORD", "secret");
    let auth: string | null = null;
    server.use(
      http.get(USER_DATA, ({ request }) => {
        auth = request.headers.get("authorization");
        return HttpResponse.json(userData(42.75));
      }),
    );
    expect(await dataforseoBalance()).toEqual({ balanceUsd: 42.75 });
    expect(auth).toBe(`Basic ${Buffer.from("login:secret").toString("base64")}`);
  });

  test("an HTTP or task error is a source error naming only the code", async () => {
    vi.stubEnv("DATAFORSEO_LOGIN", "login");
    vi.stubEnv("DATAFORSEO_PASSWORD", "secret");
    server.use(http.get(USER_DATA, () => new HttpResponse(null, { status: 401 })));
    await expect(dataforseoBalance()).rejects.toThrow(new SourceError("respuesta HTTP 401"));
    server.use(http.get(USER_DATA, () => HttpResponse.json(userData(1, 40100))));
    await expect(dataforseoBalance()).rejects.toThrow(new SourceError("código DataForSEO 40100"));
  });
});

describe("githubActionsUsage", () => {
  const item = (over: Record<string, unknown>) => ({
    date: "2026-11-02",
    product: "actions",
    sku: "actions_linux",
    quantity: 100,
    unitType: "Minutes",
    pricePerUnit: 0.006,
    grossAmount: 0.6,
    discountAmount: 0.6,
    netAmount: 0,
    ...over,
  });

  test("needs the billing token", async () => {
    await expect(githubActionsUsage("2026-11")).rejects.toThrow(
      new SourceError("falta GITHUB_BILLING_READ_TOKEN"),
    );
  });

  test("counts all Actions minutes but only non-public repositories against the included usage", async () => {
    vi.stubEnv("GITHUB_BILLING_READ_TOKEN", "ghp_test");
    let request: Request | undefined;
    server.use(
      http.get(USAGE, ({ request: r }) => {
        request = r;
        return HttpResponse.json({
          usageItems: [
            item({ repositoryName: "DavidZapataOh/reranker", quantity: 1000, grossAmount: 6 }),
            item({ repositoryName: "secret-repo", quantity: 200, grossAmount: 1.2 }),
            item({ repositoryName: "DavidZapataOh/gone", quantity: 50, grossAmount: 0.3 }),
            item({
              sku: "actions_storage",
              unitType: "GigabyteHours",
              quantity: 5,
              grossAmount: 1,
            }),
            item({ product: "copilot", sku: "copilot", unitType: "Requests", grossAmount: 9 }),
            item({ quantity: 10, grossAmount: 0.06, netAmount: 0.06 }),
          ],
        });
      }),
      http.get("https://api.github.com/repos/DavidZapataOh/reranker", () =>
        HttpResponse.json({ private: false }),
      ),
      http.get("https://api.github.com/repos/DavidZapataOh/secret-repo", () =>
        HttpResponse.json({ private: true }),
      ),
      http.get("https://api.github.com/repos/DavidZapataOh/gone", () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );
    const usage = await githubActionsUsage("2026-11");
    expect(usage.minutesUsed).toBe(1260);
    expect(usage.includedUsedUsd).toBeCloseTo(1.56);
    expect(usage.billedUsd).toBeCloseTo(0.06);
    expect(usage.includedUsd).toBe(12);
    const url = new URL(request?.url ?? "");
    expect(url.searchParams.get("year")).toBe("2026");
    expect(url.searchParams.get("month")).toBe("11");
    expect(request?.headers.get("authorization")).toBe("Bearer ghp_test");
    expect(request?.headers.get("x-github-api-version")).toBe("2026-03-10");
  });

  test("a rejected token is a source error with its status", async () => {
    vi.stubEnv("GITHUB_BILLING_READ_TOKEN", "ghp_test");
    server.use(http.get(USAGE, () => new HttpResponse(null, { status: 403 })));
    await expect(githubActionsUsage("2026-11")).rejects.toThrow(
      new SourceError("respuesta HTTP 403"),
    );
  });

  test("a repository lookup that fails for another reason fails the source", async () => {
    vi.stubEnv("GITHUB_BILLING_READ_TOKEN", "ghp_test");
    server.use(
      http.get(USAGE, () =>
        HttpResponse.json({ usageItems: [item({ repositoryName: "DavidZapataOh/x" })] }),
      ),
      http.get("https://api.github.com/repos/DavidZapataOh/x", () =>
        HttpResponse.json({}, { status: 500 }),
      ),
    );
    await expect(githubActionsUsage("2026-11")).rejects.toThrow(
      new SourceError("respuesta HTTP 500"),
    );
  });
});

describe("posthogUsage", () => {
  test("needs the query key", async () => {
    await expect(posthogUsage()).rejects.toThrow(new SourceError("falta POSTHOG_QUERY_READ_KEY"));
  });

  test("counts this month's events and exceptions with one HogQL query", async () => {
    vi.stubEnv("POSTHOG_QUERY_READ_KEY", "phx_test");
    let body: { query?: { kind?: string; query?: string } } = {};
    server.use(
      http.post(QUERY, async ({ request }) => {
        body = (await request.json()) as typeof body;
        return HttpResponse.json({ results: [[120_000, 300]] });
      }),
    );
    expect(await posthogUsage()).toEqual({ events: 120_000, exceptions: 300 });
    expect(body.query?.kind).toBe("HogQLQuery");
    expect(body.query?.query).toContain("toStartOfMonth(now())");
    expect(postHogLimits("free")).toMatchObject({ events: 1_000_000, exceptions: 100_000 });
  });

  test("an answer of an unexpected shape fails the source", async () => {
    vi.stubEnv("POSTHOG_QUERY_READ_KEY", "phx_test");
    server.use(http.post(QUERY, () => HttpResponse.json({ results: [] })));
    await expect(posthogUsage(new AbortController().signal)).rejects.toThrow();
  });

  test("a rejected key is a source error with its status", async () => {
    vi.stubEnv("POSTHOG_QUERY_READ_KEY", "phx_test");
    server.use(http.post(QUERY, () => HttpResponse.json({ detail: "no" }, { status: 403 })));
    await expect(posthogUsage()).rejects.toThrow(new SourceError("respuesta HTTP 403"));
  });
});

describe("pingHeartbeat", () => {
  test("sends one GET to the heartbeat URL", async () => {
    let calls = 0;
    server.use(
      http.get(HEARTBEAT, () => {
        calls += 1;
        return new HttpResponse(null, { status: 200 });
      }),
    );
    await pingHeartbeat(HEARTBEAT);
    expect(calls).toBe(1);
  });

  test("retries a failed ping and then gives up with the status", async () => {
    let calls = 0;
    server.use(
      http.get(HEARTBEAT, () => {
        calls += 1;
        return new HttpResponse(null, { status: 503 });
      }),
    );
    await expect(pingHeartbeat(HEARTBEAT, { backoffMs: 0 })).rejects.toThrow(
      new SourceError("respuesta HTTP 503"),
    );
    expect(calls).toBe(3);
  });

  test("a network failure is retried like a bad status", async () => {
    server.use(http.get(HEARTBEAT, () => HttpResponse.error()));
    await expect(pingHeartbeat(HEARTBEAT, { backoffMs: 0 })).rejects.toThrow(TypeError);
  });

  test("a ping that succeeds on retry resolves", async () => {
    let calls = 0;
    server.use(
      http.get(HEARTBEAT, () => {
        calls += 1;
        return new HttpResponse(null, { status: calls === 1 ? 502 : 200 });
      }),
    );
    await pingHeartbeat(HEARTBEAT, { backoffMs: 0 });
    expect(calls).toBe(2);
  });
});
