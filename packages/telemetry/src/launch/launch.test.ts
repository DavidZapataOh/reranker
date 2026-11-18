import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const readNeonProduction = vi.fn();
vi.mock("@reranker/db/neon-production", () => ({ readNeonProduction }));

const {
  checkBetterStackReady,
  checkBetterStackRouting,
  checkGitHubRepo,
  checkNeonProduction,
  checkPostHogBilling,
  checkPostHogProjects,
  checkResend,
  checkSmokeCron,
  checkTraces,
  checkVercelBilling,
  gateBlockers,
  LAUNCH_CHECK_IDS,
  LAUNCH_GATES,
  runLaunchCheck,
} = await import("./index");

const MONITORS = "https://incidents.betterstack.com/api/v2/monitors";
const WEBHOOKS = "https://incidents.betterstack.com/api/v2/incoming-webhooks";
const RESEND_DOMAINS = "https://api.resend.com/domains";
const POSTHOG = "https://us.posthog.com/api";
const REPO = "https://api.github.com/repos/DavidZapataOh/reranker";
const TEAM = "https://api.vercel.com/v2/teams/team_Z821WJ1qhLyT3ohz19uC3MOm";
const HEALTH = "https://reranker.co/api/health";
const healthy = () => HttpResponse.json({ status: "ok" });

beforeAll(() => server.listen());
beforeEach(() => vi.stubEnv("APP_ENV", "production"));
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllEnvs();
  readNeonProduction.mockReset();
});
afterAll(() => server.close());

const ready = {
  historyRetentionSeconds: 604_800,
  branch: { name: "main", protected: true },
  compute: { suspendTimeoutSeconds: -1, minCu: 0.5, maxCu: 4 },
};

describe("neon-production", () => {
  beforeEach(() => {
    vi.stubEnv("NEON_API_KEY", "neon-key");
    vi.stubEnv("NEON_PROJECT_ID", "late-frost-12345");
  });

  test("passes when production is always on, 0.5–4 CU, 7 days of history and protected", async () => {
    readNeonProduction.mockResolvedValue(ready);
    await expect(checkNeonProduction()).resolves.toMatchObject({ status: "pass" });
    expect(readNeonProduction).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "neon-key", projectId: "late-frost-12345" }),
    );
  });

  test("names every setting that falls short", async () => {
    readNeonProduction.mockResolvedValue({
      historyRetentionSeconds: 86_400,
      branch: { name: "main", protected: false },
      compute: { suspendTimeoutSeconds: 300, minCu: 0.25, maxCu: 1 },
    });
    const result = await checkNeonProduction();
    expect(result.status).toBe("fail");
    for (const part of ["escala a cero", "0,25", "1 CU", "1 día", "protegida"]) {
      expect(result.reason).toContain(part);
    }
  });

  test("a project without its compute fails", async () => {
    readNeonProduction.mockResolvedValue({ ...ready, compute: null, branch: null });
    await expect(checkNeonProduction()).resolves.toMatchObject({ status: "fail" });
  });

  test("without credentials it cannot tell", async () => {
    vi.stubEnv("NEON_API_KEY", "");
    await expect(checkNeonProduction()).rejects.toThrow("falta NEON_API_KEY o NEON_PROJECT_ID");
  });
});

describe("resend", () => {
  const restricted = () =>
    HttpResponse.json(
      {
        statusCode: 401,
        name: "restricted_api_key",
        message: "This API key is restricted to only send emails.",
      },
      { status: 401 },
    );

  test("a sending-only key and a quota above Resend Free pass both checks", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_production");
    server.use(http.get(RESEND_DOMAINS, restricted));
    const [plan, key] = await checkResend(1_600);
    expect(plan).toMatchObject({ id: "resend-plan", status: "pass" });
    expect(key).toMatchObject({ id: "resend-sending-key", status: "pass" });
  });

  test("a full-access key fails, and the Free daily quota header fails the plan", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_production");
    server.use(
      http.get(RESEND_DOMAINS, () =>
        HttpResponse.json({ data: [] }, { headers: { "x-resend-daily-quota": "12" } }),
      ),
    );
    const [plan, key] = await checkResend(1_600);
    expect(plan.status).toBe("fail");
    expect(plan.reason).toContain("Free");
    expect(key.status).toBe("fail");
  });

  test("a quota still sized for Resend Free fails the plan", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_production");
    server.use(http.get(RESEND_DOMAINS, restricted));
    const [plan] = await checkResend(100);
    expect(plan).toMatchObject({ status: "fail" });
    expect(plan.reason).toContain("QUOTA_RESEND_EMAILS_DAILY");
  });

  test("an inactive key is no answer about its permission", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_production");
    server.use(
      http.get(RESEND_DOMAINS, () =>
        HttpResponse.json(
          { statusCode: 403, name: "restricted_api_key", message: "API key is not active" },
          { status: 403 },
        ),
      ),
    );
    const [, key] = await checkResend(1_600);
    expect(key.status).toBe("unknown");
  });

  test("without the key neither can be told", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const results = await checkResend(1_600);
    expect(results.map((r) => r.status)).toEqual(["unknown", "unknown"]);
  });
});

describe("better stack", () => {
  const monitor = (over: Record<string, unknown> = {}) => ({
    id: "1",
    type: "monitor",
    attributes: {
      url: "https://reranker.co/api/ready",
      paused: false,
      check_frequency: 30,
      effective_check_frequency: 30,
      effective_check_frequency_reason: null,
      policy_id: null,
      call: true,
      push: true,
      ...over,
    },
  });
  const page = (data: unknown[], next: string | null = null) => ({
    data,
    pagination: { first: null, last: null, prev: null, next },
  });

  beforeEach(() => vi.stubEnv("BETTERSTACK_API_TOKEN", "bs-token"));

  test("passes with a 30 s monitor on /api/ready that pages the on-call person", async () => {
    let auth: string | null = null;
    server.use(
      http.get(MONITORS, ({ request }) => {
        auth = request.headers.get("authorization");
        const pageNumber = new URL(request.url).searchParams.get("page");
        return pageNumber === "2"
          ? HttpResponse.json(page([monitor()]))
          : HttpResponse.json(
              page([monitor({ url: "https://reranker.co/" })], `${MONITORS}?page=2`),
            );
      }),
    );
    await expect(checkBetterStackReady()).resolves.toMatchObject({ status: "pass" });
    expect(auth).toBe("Bearer bs-token");
  });

  test("a slower or missing monitor fails", async () => {
    server.use(
      http.get(MONITORS, () =>
        HttpResponse.json(
          page([
            monitor({
              check_frequency: 180,
              effective_check_frequency: 180,
              call: false,
              push: false,
            }),
          ]),
        ),
      ),
    );
    const slow = await checkBetterStackReady();
    expect(slow.status).toBe("fail");
    expect(slow.reason).toContain("180 s");
    server.use(http.get(MONITORS, () => HttpResponse.json(page([]))));
    await expect(checkBetterStackReady()).resolves.toMatchObject({ status: "fail" });
  });

  test("routing passes when an incoming webhook pages the on-call person", async () => {
    server.use(
      http.get(WEBHOOKS, () =>
        HttpResponse.json(
          page([
            { id: "4", attributes: { paused: false, policy_id: "12", call: false, push: false } },
          ]),
        ),
      ),
    );
    await expect(checkBetterStackRouting()).resolves.toMatchObject({ status: "pass" });
    server.use(
      http.get(WEBHOOKS, () =>
        HttpResponse.json(
          page([
            { id: "4", attributes: { paused: false, policy_id: null, call: false, push: false } },
          ]),
        ),
      ),
    );
    await expect(checkBetterStackRouting()).resolves.toMatchObject({ status: "fail" });
  });

  test("a pagination link to another host is refused", async () => {
    server.use(
      http.get(MONITORS, () => HttpResponse.json(page([], "https://evil.example/api/v2/monitors"))),
    );
    await expect(checkBetterStackReady()).rejects.toThrow();
  });

  test("without the token it cannot tell", async () => {
    vi.stubEnv("BETTERSTACK_API_TOKEN", "");
    await expect(checkBetterStackReady()).rejects.toThrow("falta BETTERSTACK_API_TOKEN");
  });
});

describe("posthog", () => {
  beforeEach(() => {
    vi.stubEnv("POSTHOG_LAUNCH_READ_KEY", "phx_launch");
    vi.stubEnv("POSTHOG_PROJECT_ID", "711803");
    vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_production");
  });

  test("billing passes with an active subscription and the pay-as-you-go configuration", async () => {
    vi.stubEnv("POSTHOG_PLAN", "pay-as-you-go");
    server.use(
      http.get(`${POSTHOG}/billing/`, () => HttpResponse.json({ has_active_subscription: true })),
    );
    await expect(checkPostHogBilling()).resolves.toMatchObject({ status: "pass" });
  });

  test("billing fails on the free plan or with the configuration still on free", async () => {
    server.use(
      http.get(`${POSTHOG}/billing/`, () => HttpResponse.json({ has_active_subscription: false })),
    );
    await expect(checkPostHogBilling()).resolves.toMatchObject({ status: "fail" });
    server.use(
      http.get(`${POSTHOG}/billing/`, () => HttpResponse.json({ has_active_subscription: true })),
    );
    const config = await checkPostHogBilling();
    expect(config.status).toBe("fail");
    expect(config.reason).toContain("POSTHOG_PLAN");
  });

  test("projects pass when production has its own project beside another one", async () => {
    const projects = (list: unknown[]) =>
      server.use(
        http.get(`${POSTHOG}/users/@me/`, () =>
          HttpResponse.json({ organization: { id: "org-1" } }),
        ),
        http.get(`${POSTHOG}/organizations/org-1/projects/`, () =>
          HttpResponse.json({ next: null, results: list }),
        ),
      );
    projects([
      { id: 711803, name: "Reranker", api_token: "phc_production" },
      { id: 900001, name: "Reranker · nonprod", api_token: "phc_preview" },
    ]);
    await expect(checkPostHogProjects()).resolves.toMatchObject({ status: "pass" });
    projects([{ id: 711803, name: "Reranker", api_token: "phc_production" }]);
    await expect(checkPostHogProjects()).resolves.toMatchObject({ status: "fail" });
    projects([
      { id: 711803, name: "Reranker", api_token: "phc_other" },
      { id: 900001, name: "Reranker · nonprod", api_token: "phc_production" },
    ]);
    await expect(checkPostHogProjects()).resolves.toMatchObject({ status: "fail" });
  });

  test("without the key it cannot tell", async () => {
    vi.stubEnv("POSTHOG_LAUNCH_READ_KEY", "");
    await expect(checkPostHogBilling()).rejects.toThrow("falta POSTHOG_LAUNCH_READ_KEY");
  });
});

describe("github", () => {
  test("passes for a private repository owned by an organization", async () => {
    vi.stubEnv("GITHUB_REPO_READ_TOKEN", "ghs_token");
    let auth: string | null = null;
    server.use(
      http.get(REPO, ({ request }) => {
        auth = request.headers.get("authorization");
        return HttpResponse.json({ private: true, owner: { type: "Organization" } });
      }),
    );
    await expect(checkGitHubRepo()).resolves.toMatchObject({ status: "pass" });
    expect(auth).toBe("Bearer ghs_token");
  });

  test("a public repository or a personal owner fails", async () => {
    server.use(
      http.get(REPO, () => HttpResponse.json({ private: false, owner: { type: "User" } })),
    );
    const result = await checkGitHubRepo();
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("público");
    expect(result.reason).toContain("personal");
  });

  test("a repository the request cannot see is no answer", async () => {
    server.use(http.get(REPO, () => new HttpResponse(null, { status: 404 })));
    await expect(checkGitHubRepo()).rejects.toThrow("404");
  });
});

describe("vercel-billing", () => {
  const activePro = { billing: { plan: "pro", status: "active" }, softBlock: null };

  test("passes for an active Pro team that is not blocked and a site that answers", async () => {
    vi.stubEnv("VERCEL_BILLING_READ_TOKEN", "vercel-read");
    let auth: string | null = null;
    server.use(
      http.get(TEAM, ({ request }) => {
        auth = request.headers.get("authorization");
        return HttpResponse.json(activePro);
      }),
      http.get(HEALTH, healthy),
    );
    await expect(checkVercelBilling()).resolves.toMatchObject({
      id: "vercel-billing",
      status: "pass",
    });
    expect(auth).toBe("Bearer vercel-read");
  });

  test("an unpaid invoice names the block, the plan status and the 402", async () => {
    vi.stubEnv("VERCEL_BILLING_READ_TOKEN", "vercel-read");
    server.use(
      http.get(TEAM, () =>
        HttpResponse.json({
          billing: { plan: "pro", status: "canceled" },
          softBlock: { blockedAt: 1_795_000_000_000, reason: "UNPAID_INVOICE" },
        }),
      ),
      http.get(HEALTH, () => new HttpResponse(null, { status: 402 })),
    );
    const result = await checkVercelBilling();
    expect(result.status).toBe("fail");
    for (const part of ["UNPAID_INVOICE", "canceled", "402"]) {
      expect(result.reason).toContain(part);
    }
  });

  test("a hard block or a team back on Hobby fails", async () => {
    vi.stubEnv("VERCEL_BILLING_READ_TOKEN", "vercel-read");
    server.use(
      http.get(TEAM, () =>
        HttpResponse.json({ billing: { plan: "hobby", status: "active" }, blocked: 1 }),
      ),
      http.get(HEALTH, healthy),
    );
    const result = await checkVercelBilling();
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("bloqueado");
    expect(result.reason).toContain("hobby");
  });

  test("without the token a 402 still fails the check", async () => {
    vi.stubEnv("VERCEL_BILLING_READ_TOKEN", "");
    server.use(http.get(HEALTH, () => new HttpResponse(null, { status: 402 })));
    const result = await checkVercelBilling();
    expect(result.status).toBe("fail");
    expect(result.reason).toContain("402");
  });

  test("without the token and with the site up the plan cannot be told", async () => {
    vi.stubEnv("VERCEL_BILLING_READ_TOKEN", "");
    server.use(http.get(HEALTH, healthy));
    await expect(checkVercelBilling()).resolves.toEqual({
      id: "vercel-billing",
      status: "unknown",
      reason: "falta VERCEL_BILLING_READ_TOKEN",
    });
  });

  test("a team without a plan status, an API error or an unreachable site is unknown", async () => {
    vi.stubEnv("VERCEL_BILLING_READ_TOKEN", "vercel-read");
    server.use(
      http.get(TEAM, () => HttpResponse.json({ billing: { plan: "pro" } })),
      http.get(HEALTH, () => HttpResponse.error()),
    );
    const silent = await checkVercelBilling();
    expect(silent.status).toBe("unknown");
    expect(silent.reason).toContain("estado del plan");
    expect(silent.reason).toContain("reranker.co sin respuesta");
    server.use(
      http.get(TEAM, () => HttpResponse.json({ error: { code: "forbidden" } }, { status: 403 })),
      http.get(HEALTH, healthy),
    );
    await expect(checkVercelBilling()).resolves.toMatchObject({
      status: "unknown",
      reason: "respuesta HTTP 403",
    });
  });
});

describe("deployment", () => {
  test("traces pass only with a tracer provider registered", () => {
    expect(checkTraces(true).status).toBe("pass");
    expect(checkTraces(false).status).toBe("fail");
  });

  test("the smoke cron must run every 15 minutes", () => {
    expect(checkSmokeCron([{ path: "/api/cron/daily", schedule: "0 10 * * *" }]).status).toBe(
      "fail",
    );
    expect(checkSmokeCron([{ path: "/api/cron/smoke", schedule: "0 * * * *" }]).status).toBe(
      "fail",
    );
    for (const schedule of ["*/15 * * * *", "0,15,30,45 * * * *", "*/5 * * * *"]) {
      expect(checkSmokeCron([{ path: "/api/cron/smoke", schedule }]).status).toBe("pass");
    }
  });
});

describe("runLaunchCheck", () => {
  test("returns every check in order, a failing source as unknown with its reason", async () => {
    server.use(
      http.get(HEALTH, healthy),
      http.get(REPO, () => HttpResponse.json({ private: false, owner: { type: "User" } })),
    );
    const results = await runLaunchCheck({ crons: [], tracing: false, resendDailyQuota: 100 });
    expect(results.map((r) => r.id)).toEqual([...LAUNCH_CHECK_IDS]);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId["neon-production"]).toMatchObject({
      status: "unknown",
      reason: "falta NEON_API_KEY o NEON_PROJECT_ID",
    });
    expect(byId["github-private-org"]?.status).toBe("fail");
    expect(byId.traces?.status).toBe("fail");
    expect(byId["vercel-billing"]).toMatchObject({
      status: "unknown",
      reason: "falta VERCEL_BILLING_READ_TOKEN",
    });
  });

  test("a gate lists the checks of its flag that did not pass", () => {
    const results = LAUNCH_CHECK_IDS.map((id) => ({
      id,
      status: id === "traces" ? ("fail" as const) : ("pass" as const),
      reason: "",
    }));
    expect(gateBlockers(results, "accounts")).toEqual([]);
    expect(gateBlockers(results, "free-report-live").map((r) => r.id)).toEqual(["traces"]);
    expect(LAUNCH_GATES.accounts).toEqual(["vercel-billing", "neon-production", "resend-plan"]);
    const unknown = results.map((r) => ({ ...r, status: "unknown" as const }));
    expect(gateBlockers(unknown, "accounts")).toHaveLength(3);
  });
});

describe("repositoryInputs", () => {
  test("reads the crons, the instrumentation and the quota of a repository", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { repositoryInputs } = await import("./index");
    const root = mkdtempSync(join(tmpdir(), "launch-"));
    mkdirSync(join(root, "apps/web/src"), { recursive: true });
    const crons = [{ path: "/api/cron/smoke", schedule: "*/15 * * * *" }];
    writeFileSync(join(root, "apps/web/vercel.json"), JSON.stringify({ crons }));
    expect(repositoryInputs(root, {})).toEqual({
      crons,
      tracing: false,
      resendDailyQuota: undefined,
    });
    writeFileSync(
      join(root, "apps/web/src/instrumentation.ts"),
      'import { registerOTel } from "@vercel/otel";\nregisterOTel({ serviceName: "web" });\n',
    );
    expect(repositoryInputs(root, { QUOTA_RESEND_EMAILS_DAILY: "1600" })).toEqual({
      crons,
      tracing: true,
      resendDailyQuota: 1600,
    });
  });
});

describe("edges", () => {
  test("a registered tracer provider counts, the default no-op one does not", async () => {
    const { trace } = await import("@opentelemetry/api");
    const { tracerRegistered } = await import("./index");
    expect(tracerRegistered()).toBe(false);
    const tracer = trace.getTracer("noop");
    trace.setGlobalTracerProvider({ getTracer: () => tracer });
    try {
      expect(tracerRegistered()).toBe(true);
    } finally {
      trace.disable();
    }
  });

  test("a schedule outside every 15 minutes, or one this check cannot read, fails", () => {
    for (const schedule of ["* * * * *", "0-59/15 * * * *"]) {
      expect(checkSmokeCron([{ path: "/api/cron/smoke", schedule }]).status).toBe("pass");
    }
    for (const schedule of ["15 * * * *", "*/15 * * * 1", "a * * * *", "*/15 * *"]) {
      expect(checkSmokeCron([{ path: "/api/cron/smoke", schedule }]).status).toBe("fail");
    }
  });

  test("a history window of a few days is named in days", async () => {
    vi.stubEnv("NEON_API_KEY", "neon-key");
    vi.stubEnv("NEON_PROJECT_ID", "late-frost-12345");
    readNeonProduction.mockResolvedValue({ ...ready, historyRetentionSeconds: 3 * 86_400 });
    const result = await checkNeonProduction();
    expect(result.reason).toContain("3 días");
  });

  test("a Resend request that fails leaves both Resend checks unknown", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_production");
    server.use(
      http.get(RESEND_DOMAINS, () => HttpResponse.error()),
      http.get(HEALTH, healthy),
      http.get(REPO, () => HttpResponse.json({ private: true, owner: { type: "Organization" } })),
    );
    const results = await runLaunchCheck({ crons: [], tracing: true, resendDailyQuota: 1_600 });
    const resend = results.filter((r) => r.id.startsWith("resend-"));
    expect(resend.map((r) => r.status)).toEqual(["unknown", "unknown"]);
  });

  test("an unset quota is Resend Free's, and an error without a status is unknown", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_production");
    server.use(
      http.get(RESEND_DOMAINS, () =>
        HttpResponse.json({ name: "application_error", message: "x" }, { status: 500 }),
      ),
    );
    const [plan, key] = await checkResend(undefined);
    expect(plan.reason).toContain("QUOTA_RESEND_EMAILS_DAILY en 100");
    expect(key.status).toBe("unknown");
  });

  test("a paused monitor, a slowed one and a malformed URL are told apart", async () => {
    vi.stubEnv("BETTERSTACK_API_TOKEN", "bs-token");
    const monitor = (attributes: Record<string, unknown>) => ({
      attributes: {
        url: "https://reranker.co/api/ready/",
        paused: true,
        check_frequency: 30,
        effective_check_frequency: 60,
        effective_check_frequency_reason: "slowed_down",
        policy_id: "9",
        ...attributes,
      },
    });
    server.use(
      http.get(MONITORS, () =>
        HttpResponse.json({
          data: [monitor({ url: "not a url" }), monitor({})],
          pagination: { next: null },
        }),
      ),
    );
    const result = await checkBetterStackReady();
    expect(result.reason).toContain("pausa");
    expect(result.reason).toContain("60 s");
    expect(result.reason).toContain("slowed_down");
  });

  test("PostHog answering an error is a source error with its status", async () => {
    vi.stubEnv("POSTHOG_LAUNCH_READ_KEY", "phx_launch");
    server.use(
      http.get(`${POSTHOG}/billing/`, () =>
        HttpResponse.json({ detail: "forbidden" }, { status: 403 }),
      ),
    );
    await expect(checkPostHogBilling()).rejects.toThrow("respuesta HTTP 403");
    server.use(http.get(`${POSTHOG}/billing/`, () => HttpResponse.json({ unexpected: true })));
    await expect(checkPostHogBilling()).rejects.toThrow();
  });

  test("the projects check needs the production project id", async () => {
    vi.stubEnv("POSTHOG_LAUNCH_READ_KEY", "phx_launch");
    vi.stubEnv("POSTHOG_PROJECT_ID", "");
    await expect(checkPostHogProjects()).rejects.toThrow("falta POSTHOG_PROJECT_ID");
  });
});
