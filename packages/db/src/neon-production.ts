import { createNeonClient } from "@neon/sdk";

export type NeonProduction = {
  historyRetentionSeconds: number;
  /** The project's default branch, the one production connects to. */
  branch: { name: string; protected: boolean } | null;
  /** The default branch's read-write compute. */
  compute: { suspendTimeoutSeconds: number; minCu: number; maxCu: number } | null;
};

/**
 * The production settings that matter to availability, read from the control plane, which never
 * wakes a compute. `suspendTimeoutSeconds` is -1 when scale to zero is off
 * (https://neon.com/docs/reference/api).
 */
export async function readNeonProduction(opts: {
  apiKey: string;
  projectId: string;
  fetch?: typeof fetch;
}): Promise<NeonProduction> {
  const neon = createNeonClient({
    apiKey: opts.apiKey,
    throwOnError: true,
    ...(opts.fetch && { fetch: opts.fetch }),
  });
  const { projectId } = opts;
  const [project, branches, endpoints] = await Promise.all([
    neon.projects.get({ projectId }),
    neon.branches.list({ projectId }).all(),
    neon.postgres.endpoints.list({ projectId }),
  ]);
  const branch = branches.find((b) => b.default);
  const compute =
    branch && endpoints.find((e) => e.branch_id === branch.id && e.type === "read_write");
  return {
    historyRetentionSeconds: project.history_retention_seconds,
    branch: branch ? { name: branch.name, protected: branch.protected } : null,
    compute: compute
      ? {
          suspendTimeoutSeconds: compute.suspend_timeout_seconds,
          minCu: compute.autoscaling_limit_min_cu,
          maxCu: compute.autoscaling_limit_max_cu,
        }
      : null,
  };
}
