import { bypassHeaders } from "@reranker/testing/bypass";
import { assertDeploymentUrl } from "@reranker/testing/target";
import { publicRoutes, readTarget } from "./e2e/routes.ts";

type Budget = { scriptBytes: number; totalBytes: number };
type Assertion = ["error", { minScore: number } | { maxNumericValue: number }];

// Transferred bytes, median of 3 mobile runs on reranker.co (2026-11-12) + 5 %.
// The landing script cap comes from the first measured state of the page.
export const budgets: Record<string, Budget> = {
  landing: { scriptBytes: 345_000, totalBytes: 581_710 },
  legal: { scriptBytes: 327_636, totalBytes: 574_113 },
};

// Previews never load these, so blocking them lets one budget hold for every target.
// Lighthouse sends extraHeaders to every origin; blocked requests never leave the browser.
const BLOCKED_THIRD_PARTIES = ["*googletagmanager.com*", "*google-analytics.com*", "*clarity.ms*"];

function exactUrlPattern(href: string): string {
  return `^${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

export function lighthouseConfig(env: NodeJS.ProcessEnv = process.env) {
  const target = readTarget(env.APP_TARGET);
  const deployment = env.PLAYWRIGHT_BASE_URL
    ? assertDeploymentUrl(env.PLAYWRIGHT_BASE_URL, { allowProduction: true }).origin
    : undefined;
  const base = deployment ?? `http://localhost:${env.PORT ?? 3000}`;
  const headers = deployment ? bypassHeaders() : {};
  const production = target === "production";

  const assertMatrix = publicRoutes.map((route) => {
    const budget = budgets[route.budgetKey];
    if (!budget) throw new Error(`No Lighthouse budget "${route.budgetKey}" for ${route.path}`);
    const assertions: Record<string, Assertion> = {
      "categories:accessibility": ["error", { minScore: 1 }],
      "categories:best-practices": ["error", { minScore: 0.95 }],
      "resource-summary:script:size": ["error", { maxNumericValue: budget.scriptBytes }],
      "resource-summary:total:size": ["error", { maxNumericValue: budget.totalBytes }],
      // A new third party would receive the bypass header and escape the budget; block it above.
      "resource-summary:third-party:count": ["error", { maxNumericValue: 0 }],
    };
    if (production) assertions["categories:seo"] = ["error", { minScore: 0.95 }];
    return {
      matchingUrlPattern: exactUrlPattern(new URL(route.path, base).href),
      assertions,
    };
  });

  return {
    ci: {
      collect: {
        url: publicRoutes.map((route) => new URL(route.path, base).href),
        numberOfRuns: 3,
        ...(deployment ? {} : { startServerCommand: "pnpm start" }),
        settings: {
          ...(Object.keys(headers).length > 0 ? { extraHeaders: JSON.stringify(headers) } : {}),
          blockedUrlPatterns: BLOCKED_THIRD_PARTIES,
          // Every non-production deployment answers with X-Robots-Tag: noindex.
          skipAudits: production ? [] : ["is-crawlable"],
        },
      },
      assert: { aggregationMethod: "median-run", assertMatrix },
      upload: { target: "filesystem", outputDir: ".lighthouseci" },
    },
  };
}
