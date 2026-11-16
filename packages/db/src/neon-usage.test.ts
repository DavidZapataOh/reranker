import { expect, test } from "vitest";
import { NeonUsageSchema, readNeonUsage, toNeonUsage } from "./neon-usage";

// Shaped after GET /projects/{id} and GET /projects/{id}/branches on the Free plan.
const project = {
  id: "late-frost-12345",
  name: "reranker-prod",
  compute_time_seconds: 180_000,
  active_time_seconds: 400_000,
  synthetic_storage_size: 0,
  consumption_period_start: "2026-11-01T00:00:00Z",
  consumption_period_end: "2026-12-01T00:00:00Z",
};
const branches = [
  { id: "br-main-1", project_id: project.id, logical_size: 100_000_000 },
  { id: "br-ci-2", project_id: project.id, logical_size: 7_000_000 },
];

function route(url: string, status?: number) {
  if (status) return Response.json({ message: "rejected" }, { status });
  if (new URL(url).pathname.endsWith("/branches")) {
    return Response.json({ branches, pagination: {} });
  }
  return Response.json({ project });
}

test("converts compute_time_seconds to CU-hours and sums branch logical_size", () => {
  const usage = toNeonUsage(project, branches);
  expect(usage).toMatchObject({
    projectId: project.id,
    computeHours: 50,
    storageBytes: 107_000_000,
    computePct: 50,
  });
  expect(usage.storagePct).toBeCloseTo((107_000_000 / 1_073_741_824) * 100, 6);
  expect(NeonUsageSchema.safeParse({ projects: [usage] }).success).toBe(true);
});

test("treats a branch without logical_size as empty", () => {
  expect(toNeonUsage(project, [{}]).storageBytes).toBe(0);
});

test("normalizes the billing period to ISO instants", () => {
  const usage = toNeonUsage(project, branches);
  expect(usage.periodStart).toBe("2026-11-01T00:00:00.000Z");
  expect(usage.periodEnd).toBe("2026-12-01T00:00:00.000Z");
});

test("reads every project through the official client", async () => {
  const seen: string[] = [];
  const usage = await readNeonUsage({
    apiKey: "test-key",
    projectIds: [project.id, "other-project-9"],
    fetch: async (input, init) => {
      const url = new Request(input, init).url;
      seen.push(new URL(url).pathname);
      return route(url);
    },
  });
  expect(usage.projects).toHaveLength(2);
  expect(usage.projects[0]?.computeHours).toBe(50);
  expect(seen.some((path) => path.endsWith(`/projects/${project.id}`))).toBe(true);
  expect(seen.some((path) => path.endsWith("/projects/other-project-9/branches"))).toBe(true);
});

test("sums branches across pages", async () => {
  let page = 0;
  const usage = await readNeonUsage({
    apiKey: "test-key",
    projectIds: [project.id],
    fetch: async (input, init) => {
      const url = new Request(input, init).url;
      if (!new URL(url).pathname.endsWith("/branches")) return route(url);
      page += 1;
      return page === 1
        ? Response.json({ branches: [branches[0]], pagination: { next: "c1" } })
        : Response.json({ branches: [branches[1]], pagination: {} });
    },
  });
  expect(usage.projects[0]?.storageBytes).toBe(107_000_000);
});

test("fails loudly when the API rejects the key", async () => {
  await expect(
    readNeonUsage({
      apiKey: "bad",
      projectIds: [project.id],
      fetch: async (input, init) => route(new Request(input, init).url, 401),
    }),
  ).rejects.toThrow();
});
