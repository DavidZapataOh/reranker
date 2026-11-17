import { defineEnv } from "@reranker/env";
import { z } from "@reranker/schema";
import { telemetryEnv } from "../env";
import { httpError, SourceError } from "./source-error";

// https://docs.github.com/en/rest/billing/usage#get-billing-usage-report-for-a-user
const API = "https://api.github.com";
const API_VERSION = "2026-03-10";
// Actions are billed to the repository owner, the account this product's repository lives in.
const ACCOUNT = "DavidZapataOh";
// GitHub Free includes US$12 of compute a month (about 2,000 Linux minutes); the amount, not a
// minute count, is what usage draws from.
// https://docs.github.com/en/billing/concepts/product-billing/github-actions
const INCLUDED_USD = 12;

const token = z.object({ GITHUB_BILLING_READ_TOKEN: telemetryEnv.shape.GITHUB_BILLING_READ_TOKEN });

const UsageReport = z.object({
  usageItems: z.array(
    z.object({
      product: z.string(),
      unitType: z.string(),
      quantity: z.number(),
      grossAmount: z.number(),
      netAmount: z.number(),
      repositoryName: z.string().nullish(),
    }),
  ),
});

export type ActionsUsage = {
  minutesUsed: number;
  /** Runner cost that draws from the included compute usage. */
  includedUsedUsd: number;
  includedUsd: number;
  /** What GitHub billed beyond the included usage. */
  billedUsd: number;
};

function client(bearer: string, signal: AbortSignal | undefined) {
  return (path: string) =>
    fetch(`${API}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${bearer}`,
        "X-GitHub-Api-Version": API_VERSION,
      },
      ...(signal && { signal }),
    });
}

/**
 * Standard runners in public repositories are free, yet the report lists them with their gross
 * cost discounted. Only repositories that are not public draw from the included usage; one the
 * token cannot see (404) is private or gone, and counts.
 */
async function isPublic(get: ReturnType<typeof client>, name: string): Promise<boolean> {
  const full = name.includes("/") ? name : `${ACCOUNT}/${name}`;
  const response = await get(`/repos/${full}`);
  if (response.status === 404) return false;
  if (!response.ok) throw httpError(response);
  const repo = z.object({ private: z.boolean() }).parse(await response.json());
  return !repo.private;
}

/** This month's Actions usage of the account, `month` as `YYYY-MM`. */
export async function githubActionsUsage(
  month: string,
  signal?: AbortSignal,
): Promise<ActionsUsage> {
  const env = defineEnv([token]);
  if (!env.GITHUB_BILLING_READ_TOKEN) throw new SourceError("falta GITHUB_BILLING_READ_TOKEN");
  const get = client(env.GITHUB_BILLING_READ_TOKEN, signal);
  const [year, monthNumber] = month.split("-").map(Number);
  const response = await get(
    `/users/${ACCOUNT}/settings/billing/usage?year=${year}&month=${monthNumber}`,
  );
  if (!response.ok) throw httpError(response);
  const runners = UsageReport.parse(await response.json()).usageItems.filter(
    (item) => item.product.toLowerCase() === "actions" && item.unitType.toLowerCase() === "minutes",
  );
  const repositories = [...new Set(runners.flatMap((item) => item.repositoryName ?? []))];
  const visibility = new Map(
    await Promise.all(repositories.map(async (name) => [name, await isPublic(get, name)] as const)),
  );
  let minutesUsed = 0;
  let includedUsedUsd = 0;
  let billedUsd = 0;
  for (const item of runners) {
    minutesUsed += item.quantity;
    billedUsd += item.netAmount;
    if (!(item.repositoryName && visibility.get(item.repositoryName))) {
      includedUsedUsd += item.grossAmount;
    }
  }
  return { minutesUsed, includedUsedUsd, includedUsd: INCLUDED_USD, billedUsd };
}
