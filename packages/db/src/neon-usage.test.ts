import { expect, test } from "vitest";
import { NeonUsageSchema, readNeonUsage, toProjectSpend } from "./neon-usage";

const ORG = "org-quiet-hill-123";
const PROJECT = "late-frost-12345";

type Metric = { metric_name: string; value: number };

function day(date: string, metrics: Record<string, number>) {
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString();
  return {
    timeframe_start: `${date}T00:00:00Z`,
    timeframe_end: next,
    metrics: Object.entries(metrics).map(
      ([metric_name, value]): Metric => ({ metric_name, value }),
    ),
  };
}

// Shaped after the response in https://neon.com/docs/guides/consumption-metrics.
function consumption(projectId: string, days: ReturnType<typeof day>[], plan = "launch") {
  return {
    project_id: projectId,
    periods: [
      {
        period_id: "90c7f107-3fe7-4652-b1da-c61f71043128",
        period_plan: plan,
        period_start: "2026-11-01T00:00:00Z",
        consumption: days,
      },
    ],
  };
}

test("prices each metric at the Launch rates", () => {
  const spend = toProjectSpend(
    consumption(PROJECT, [
      day("2026-11-01", {
        compute_unit_seconds: 3_600 * 12,
        root_branch_bytes_month: 2_000_000_000,
        child_branch_bytes_month: 1_000_000_000,
        instant_restore_bytes_month: 500_000_000,
        snapshot_storage_bytes_month: 1_000_000_000,
        extra_branches_month: 9 * 24 + 744,
      }),
      day("2026-11-02", { compute_unit_seconds: 3_600 * 12, public_network_transfer_bytes: 1e12 }),
    ]),
  );
  // 24 CU-h × 0.106 + 3 GB-mo × 0.35 + 0.5 × 0.20 + 1 × 0.09 + 1 branch-month × 1.50
  // + (1,000 − 500) GB × 0.10
  expect(spend.computeHours).toBe(24);
  expect(spend.storageGbMonths).toBe(3);
  expect(spend.spendUsd).toBeCloseTo(2.544 + 1.05 + 0.1 + 0.09 + 1.5 + 50, 6);
});

test("the included child branches and public transfer cost nothing", () => {
  const spend = toProjectSpend(
    consumption(PROJECT, [
      day("2026-11-01", { extra_branches_month: 9 * 24, public_network_transfer_bytes: 4e11 }),
      day("2026-11-02", { extra_branches_month: 3 * 24, public_network_transfer_bytes: 1e11 }),
    ]),
  );
  expect(spend.spendUsd).toBe(0);
});

test("a Scale period is priced at the Scale rates", () => {
  const spend = toProjectSpend(
    consumption(PROJECT, [day("2026-11-01", { compute_unit_seconds: 3_600 })], "scale"),
  );
  expect(spend.spendUsd).toBeCloseTo(0.222, 6);
});

test("a plan without published rates fails loudly instead of guessing", () => {
  expect(() =>
    toProjectSpend(consumption(PROJECT, [day("2026-11-01", { compute_unit_seconds: 1 })], "x")),
  ).toThrow("x");
});

test("reads the month through the v2 consumption endpoint of the project's organization", async () => {
  const seen: URL[] = [];
  const usage = await readNeonUsage({
    apiKey: "test-key",
    projectIds: [PROJECT, "other-project-9"],
    from: "2026-11-01T00:00:00Z",
    to: "2026-11-17T00:00:00Z",
    fetch: async (input, init) => {
      const url = new URL(new Request(input, init).url);
      seen.push(url);
      if (url.pathname.endsWith(`/projects/${PROJECT}`)) {
        return Response.json({ project: { id: PROJECT, org_id: ORG } });
      }
      return Response.json({
        projects: [
          consumption(PROJECT, [day("2026-11-01", { compute_unit_seconds: 36_000 })]),
          consumption("other-project-9", []),
        ],
        pagination: {},
      });
    },
  });
  const request = seen.find((u) => u.pathname.endsWith("/consumption_history/v2/projects"));
  expect(request?.searchParams.get("org_id")).toBe(ORG);
  expect(request?.searchParams.get("granularity")).toBe("daily");
  expect(request?.searchParams.get("from")).toBe("2026-11-01T00:00:00Z");
  expect(request?.searchParams.get("to")).toBe("2026-11-17T00:00:00Z");
  expect(request?.searchParams.getAll("project_ids").join(",")).toContain(PROJECT);
  expect(usage.projects).toEqual([
    { projectId: PROJECT, computeHours: 10, storageGbMonths: 0, spendUsd: 1.06 },
    { projectId: "other-project-9", computeHours: 0, storageGbMonths: 0, spendUsd: 0 },
  ]);
  expect(NeonUsageSchema.safeParse(usage).success).toBe(true);
});

test("a project the endpoint does not list counts as nothing used", async () => {
  const usage = await readNeonUsage({
    apiKey: "test-key",
    projectIds: [PROJECT],
    from: "2026-11-01T00:00:00Z",
    to: "2026-11-02T00:00:00Z",
    fetch: async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname.endsWith(`/projects/${PROJECT}`)) {
        return Response.json({ project: { id: PROJECT, org_id: ORG } });
      }
      return Response.json({ projects: [], pagination: {} });
    },
  });
  expect(usage.projects).toEqual([
    { projectId: PROJECT, computeHours: 0, storageGbMonths: 0, spendUsd: 0 },
  ]);
});

test("fails loudly when the API rejects the key", async () => {
  await expect(
    readNeonUsage({
      apiKey: "bad",
      projectIds: [PROJECT],
      from: "2026-11-01T00:00:00Z",
      to: "2026-11-02T00:00:00Z",
      fetch: async () => Response.json({ message: "rejected" }, { status: 401 }),
    }),
  ).rejects.toThrow();
});
