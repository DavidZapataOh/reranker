import { bypassHeaders } from "@reranker/testing/bypass";
import { assertDeploymentUrl } from "@reranker/testing/target";
import type { Browser } from "puppeteer-core";
import { publicRoutes, readTarget } from "./e2e/routes.ts";

const PRODUCTION_ORIGIN = "https://reranker.co";

type Budget = { scriptBytes: number; totalBytes: number };
type Assertion = ["error", { minScore: number } | { maxNumericValue: number }];

// Transferred bytes, median of 3 mobile runs on reranker.co (2026-11-12) + 5 %.
// The landing script cap comes from the first measured state of the page.
export const budgets: Record<string, Budget> = {
  landing: { scriptBytes: 345_000, totalBytes: 581_710 },
  legal: { scriptBytes: 327_636, totalBytes: 574_113 },
};

// Previews never load the analytics tags and production never loads the Vercel toolbar,
// so blocking all of them lets one budget hold for every target.
const BLOCKED_THIRD_PARTIES = [
  "*googletagmanager.com*",
  "*google-analytics.com*",
  "*clarity.ms*",
  "*vercel.live*",
];

function exactUrlPattern(href: string): string {
  return `^${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
}

export function lighthouseConfig(env: NodeJS.ProcessEnv = process.env) {
  const target = readTarget(env.APP_TARGET);
  const deployment = env.PLAYWRIGHT_BASE_URL
    ? assertDeploymentUrl(env.PLAYWRIGHT_BASE_URL, { allowProduction: true }).origin
    : undefined;
  const base = deployment ?? `http://localhost:${env.PORT ?? 3000}`;
  const protectedDeployment = deployment !== undefined && Object.keys(bypassHeaders()).length > 0;
  const production = target === "production";
  const crawlable = production && deployment === PRODUCTION_ORIGIN;

  const assertMatrix = publicRoutes.map((route) => {
    const budget = budgets[route.budgetKey];
    if (!budget) throw new Error(`No Lighthouse budget "${route.budgetKey}" for ${route.path}`);
    const assertions: Record<string, Assertion> = {
      "categories:accessibility": ["error", { minScore: 1 }],
      "categories:best-practices": ["error", { minScore: 0.95 }],
      "resource-summary:script:size": ["error", { maxNumericValue: budget.scriptBytes }],
      "resource-summary:total:size": ["error", { maxNumericValue: budget.totalBytes }],
    };
    if (production) assertions["categories:seo"] = ["error", { minScore: 0.95 }];
    return {
      matchingUrlPattern: exactUrlPattern(new URL(route.path, base).href),
      aggregationMethod: "median-run",
      assertions,
    };
  });

  // A run that ends anywhere else (a redirect, a login page) would match no entry and pass
  // unasserted; this entry fails it instead.
  const expected = publicRoutes.map((route) => exactUrlPattern(new URL(route.path, base).href));
  assertMatrix.push({
    matchingUrlPattern: `^(?!(?:${expected.join("|")})).*$`,
    aggregationMethod: "median-run",
    assertions: { "resource-summary:total:size": ["error", { maxNumericValue: 0 }] },
  });

  return {
    ci: {
      collect: {
        url: publicRoutes.map((route) => new URL(route.path, base).href),
        numberOfRuns: 3,
        ...(deployment ? {} : { startServerCommand: "pnpm start" }),
        // Not settings.extraHeaders: Lighthouse sends those to every origin and copies them into each report.
        ...(protectedDeployment ? { puppeteerScript: "./lighthouse-bypass.cjs" } : {}),
        settings: {
          blockedUrlPatterns: BLOCKED_THIRD_PARTIES,
          // Vercel serves every generated deployment URL with X-Robots-Tag: noindex, production
          // included; only reranker.co is meant to be crawled.
          skipAudits: crawlable ? [] : ["is-crawlable"],
        },
      },
      assert: { assertMatrix },
      upload: { target: "filesystem", outputDir: ".lighthouseci" },
    },
  };
}

/**
 * Runs before Lighthouse in the same browser. Vercel answers the bypass header with a
 * host-only cookie, which Lighthouse keeps (it never clears cookies), so the secret is
 * sent once, to the deployment only, and never lands in a report.
 */
export async function setBypassCookie(browser: Browser, { url }: { url: string }): Promise<void> {
  const { origin } = assertDeploymentUrl(url, { allowProduction: true });
  const headers = { ...bypassHeaders(), "x-vercel-set-bypass-cookie": "true" };
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (new URL(request.url()).origin !== origin) return void request.abort();
      void request.continue({ headers: { ...request.headers(), ...headers } });
    });
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    if (!response?.ok()) {
      throw new Error(
        `Bypass cookie not set for ${origin} (${response?.status() ?? "no response"})`,
      );
    }
  } finally {
    await page.close();
  }
}
