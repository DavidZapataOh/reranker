import { createNeonClient } from "@neon/sdk";
import { z } from "@reranker/schema";

// Free plan allowances per project (https://neon.com/docs/introduction/plans).
const COMPUTE_HOURS_LIMIT = 100;
const STORAGE_BYTES_LIMIT = 1_073_741_824;

export const NeonUsageSchema = z.object({
  projects: z.array(
    z.object({
      projectId: z.string(),
      periodStart: z.iso.datetime(),
      periodEnd: z.iso.datetime(),
      computeHours: z.number().nonnegative(),
      computeHoursLimit: z.literal(COMPUTE_HOURS_LIMIT),
      storageBytes: z.number().int().nonnegative(),
      storageBytesLimit: z.literal(STORAGE_BYTES_LIMIT),
      computePct: z.number(),
      storagePct: z.number(),
    }),
  ),
});

export type NeonUsage = z.infer<typeof NeonUsageSchema>;
type ProjectUsage = NeonUsage["projects"][number];

type ProjectFields = {
  id: string;
  compute_time_seconds: number;
  consumption_period_start: string;
  consumption_period_end: string;
};

export function toNeonUsage(
  project: ProjectFields,
  branches: readonly { logical_size?: number }[],
): ProjectUsage {
  const computeHours = project.compute_time_seconds / 3600;
  const storageBytes = branches.reduce((sum, branch) => sum + (branch.logical_size ?? 0), 0);
  return {
    projectId: project.id,
    periodStart: new Date(project.consumption_period_start).toISOString(),
    periodEnd: new Date(project.consumption_period_end).toISOString(),
    computeHours,
    computeHoursLimit: COMPUTE_HOURS_LIMIT,
    storageBytes,
    storageBytesLimit: STORAGE_BYTES_LIMIT,
    computePct: (computeHours / COMPUTE_HOURS_LIMIT) * 100,
    storagePct: (storageBytes / STORAGE_BYTES_LIMIT) * 100,
  };
}

/**
 * Reads the control-plane fields of each project, which never wake its compute. The consumption
 * history endpoints are not used: they need a paid plan and answer 403 on Free.
 */
export async function readNeonUsage(opts: {
  apiKey: string;
  projectIds: readonly string[];
  fetch?: typeof fetch;
}): Promise<NeonUsage> {
  const neon = createNeonClient({
    apiKey: opts.apiKey,
    throwOnError: true,
    ...(opts.fetch && { fetch: opts.fetch }),
  });
  const projects = await Promise.all(
    opts.projectIds.map(async (projectId) => {
      const [project, branches] = await Promise.all([
        neon.projects.get({ projectId }),
        neon.branches.list({ projectId }).all(),
      ]);
      return toNeonUsage(project, branches);
    }),
  );
  return NeonUsageSchema.parse({ projects });
}
