import { expect, test } from "vitest";
import { readNeonProduction } from "./neon-production";

const PROJECT = "late-frost-12345";

// Shaped after GET /projects/{id}, /branches and /endpoints in https://neon.com/docs/reference/api.
const branches = [
  { id: "br-main", name: "main", default: true, protected: true },
  { id: "br-ci", name: "ci/run-1", default: false, protected: false },
];
const endpoints = [
  {
    id: "ep-ro",
    branch_id: "br-main",
    type: "read_only",
    suspend_timeout_seconds: 0,
    autoscaling_limit_min_cu: 0.25,
    autoscaling_limit_max_cu: 1,
  },
  {
    id: "ep-rw",
    branch_id: "br-main",
    type: "read_write",
    suspend_timeout_seconds: -1,
    autoscaling_limit_min_cu: 0.5,
    autoscaling_limit_max_cu: 4,
  },
  {
    id: "ep-ci",
    branch_id: "br-ci",
    type: "read_write",
    suspend_timeout_seconds: 300,
    autoscaling_limit_min_cu: 0.25,
    autoscaling_limit_max_cu: 0.25,
  },
];

function api(over: { branches?: unknown[]; endpoints?: unknown[] } = {}) {
  return async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(new Request(input, init).url).pathname;
    if (path.endsWith("/branches")) {
      return Response.json({ branches: over.branches ?? branches, pagination: {} });
    }
    if (path.endsWith("/endpoints"))
      return Response.json({ endpoints: over.endpoints ?? endpoints });
    return Response.json({ project: { id: PROJECT, history_retention_seconds: 604_800 } });
  };
}

test("reads the default branch and its read-write compute", async () => {
  await expect(
    readNeonProduction({ apiKey: "test-key", projectId: PROJECT, fetch: api() }),
  ).resolves.toEqual({
    historyRetentionSeconds: 604_800,
    branch: { name: "main", protected: true },
    compute: { suspendTimeoutSeconds: -1, minCu: 0.5, maxCu: 4 },
  });
});

test("a project without a default branch or compute reports them missing", async () => {
  await expect(
    readNeonProduction({
      apiKey: "test-key",
      projectId: PROJECT,
      fetch: api({ branches: [branches[1]], endpoints: [] }),
    }),
  ).resolves.toEqual({ historyRetentionSeconds: 604_800, branch: null, compute: null });
});

test("fails loudly when the API rejects the key", async () => {
  await expect(
    readNeonProduction({
      apiKey: "bad",
      projectId: PROJECT,
      fetch: async () => Response.json({ message: "rejected" }, { status: 401 }),
    }),
  ).rejects.toThrow();
});
