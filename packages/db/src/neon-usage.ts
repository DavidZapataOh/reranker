import { createNeonClient } from "@neon/sdk";
import { z } from "@reranker/schema";

type Rates = {
  cuHour: number;
  storageGbMonth: number;
  instantRestoreGbMonth: number;
  snapshotGbMonth: number;
  publicTransferGb: number;
  extraBranchMonth: number;
  /** Child branches each project includes, the root branch aside. */
  includedChildBranches: number;
  includedPublicTransferGb: number;
};

// https://neon.com/docs/introduction/usage-calculations (read 2026-11-17).
const RATES: Readonly<Record<string, Rates>> = {
  launch: {
    cuHour: 0.106,
    storageGbMonth: 0.35,
    instantRestoreGbMonth: 0.2,
    snapshotGbMonth: 0.09,
    publicTransferGb: 0.1,
    extraBranchMonth: 1.5,
    includedChildBranches: 9,
    includedPublicTransferGb: 500,
  },
  scale: {
    cuHour: 0.222,
    storageGbMonth: 0.35,
    instantRestoreGbMonth: 0.2,
    snapshotGbMonth: 0.09,
    publicTransferGb: 0.1,
    extraBranchMonth: 1.5,
    includedChildBranches: 24,
    includedPublicTransferGb: 500,
  },
};

const METRICS = [
  "compute_unit_seconds",
  "root_branch_bytes_month",
  "child_branch_bytes_month",
  "instant_restore_bytes_month",
  "snapshot_storage_bytes_month",
  "public_network_transfer_bytes",
  "extra_branches_month",
];

// Neon bills decimal gigabytes and a fixed 744-hour month.
const GB = 1e9;
const BILLING_MONTH_HOURS = 744;

export const NeonUsageSchema = z.object({
  projects: z.array(
    z.object({
      projectId: z.string(),
      computeHours: z.number().nonnegative(),
      storageGbMonths: z.number().nonnegative(),
      spendUsd: z.number().nonnegative(),
    }),
  ),
});

export type NeonUsage = z.infer<typeof NeonUsageSchema>;
export type ProjectSpend = NeonUsage["projects"][number];

type Consumption = {
  project_id: string;
  periods: {
    period_plan: string;
    consumption: {
      timeframe_start?: string;
      timeframe_end?: string;
      metrics?: { metric_name: string; value: number }[];
    }[];
  }[];
};

const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;

/** What a project's consumption history costs, per https://neon.com/docs/introduction/usage-calculations. */
export function toProjectSpend(project: Consumption): ProjectSpend {
  let computeHours = 0;
  let storageGbMonths = 0;
  let spendUsd = 0;
  let transferGb = 0;
  let transferRates: Rates | undefined;
  for (const period of project.periods) {
    const rates = RATES[period.period_plan];
    if (!rates) throw new Error(`No published Neon rates for plan ${period.period_plan}`);
    transferRates = rates;
    for (const bucket of period.consumption) {
      const m = new Map((bucket.metrics ?? []).map((x) => [x.metric_name, x.value]));
      const value = (name: string) => m.get(name) ?? 0;
      const hours =
        bucket.timeframe_start && bucket.timeframe_end
          ? (Date.parse(bucket.timeframe_end) - Date.parse(bucket.timeframe_start)) / 3_600_000
          : 24;
      const cuHours = value("compute_unit_seconds") / 3600;
      const storage = (value("root_branch_bytes_month") + value("child_branch_bytes_month")) / GB;
      const billableBranchHours = Math.max(
        0,
        value("extra_branches_month") - rates.includedChildBranches * hours,
      );
      computeHours += cuHours;
      storageGbMonths += storage;
      transferGb += value("public_network_transfer_bytes") / GB;
      spendUsd +=
        cuHours * rates.cuHour +
        storage * rates.storageGbMonth +
        (value("instant_restore_bytes_month") / GB) * rates.instantRestoreGbMonth +
        (value("snapshot_storage_bytes_month") / GB) * rates.snapshotGbMonth +
        (billableBranchHours / BILLING_MONTH_HOURS) * rates.extraBranchMonth;
    }
  }
  // The transfer allowance is per project and month, so it applies to the period's total.
  if (transferRates) {
    spendUsd +=
      Math.max(0, transferGb - transferRates.includedPublicTransferGb) *
      transferRates.publicTransferGb;
  }
  return {
    projectId: project.project_id,
    computeHours: round(computeHours, 4),
    storageGbMonths: round(storageGbMonths, 4),
    spendUsd: round(spendUsd, 4),
  };
}

/**
 * Month-to-date usage and cost of each project between `from` and `to` (RFC 3339, whole days),
 * from the usage-based consumption endpoint. Reading it never wakes a compute
 * (https://neon.com/docs/guides/consumption-metrics).
 */
export async function readNeonUsage(opts: {
  apiKey: string;
  projectIds: readonly string[];
  from: string;
  to: string;
  fetch?: typeof fetch;
}): Promise<NeonUsage> {
  const neon = createNeonClient({
    apiKey: opts.apiKey,
    throwOnError: true,
    ...(opts.fetch && { fetch: opts.fetch }),
  });
  const first = opts.projectIds[0];
  if (!first) return { projects: [] };
  // Both projects live in the same organization, which the endpoint requires.
  const { org_id } = await neon.projects.get({ projectId: first });
  if (!org_id) throw new Error(`Neon project ${first} belongs to no organization`);
  const rows = await neon.consumption
    .perProjectV2({
      org_id,
      project_ids: [...opts.projectIds],
      from: opts.from,
      to: opts.to,
      granularity: "daily",
      metrics: METRICS,
    })
    .all();
  const byId = new Map(rows.map((row) => [row.project_id, row as Consumption]));
  const projects = opts.projectIds.map((projectId) =>
    toProjectSpend(byId.get(projectId) ?? { project_id: projectId, periods: [] }),
  );
  return NeonUsageSchema.parse({ projects });
}
