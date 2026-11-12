const { requireEnv } = require("@reranker/testing/env");
const { assertDeploymentUrl } = require("@reranker/testing/target");
const { appTarget, publicRoutes } = require("./e2e/routes.ts");

// The bypass cookie is requested for this origin, so it must be ours.
const { origin } = assertDeploymentUrl(requireEnv("PLAYWRIGHT_BASE_URL"), {
  allowProduction: true,
});
const production = appTarget === "production";

// Transferred first-party bytes on a cold cache are deterministic, so they fail hard. Each value
// is the production baseline plus 5 %, except landing scripts, which keep the original target.
const budgets = {
  landing: { scriptBytes: 345_000, totalBytes: 581_369 },
  legal: { scriptBytes: 327_656, totalBytes: 573_530 },
};

const routes = publicRoutes.map((route) => ({
  url: new URL(route.path, origin).href,
  budget: budgets[route.budgetKey],
}));

module.exports = {
  ci: {
    collect: {
      url: routes.map((route) => route.url),
      numberOfRuns: 3,
      chromePath: process.env.CHROME_PATH,
      puppeteerScript: "./lighthouse-bypass-cookie.cjs",
      settings: {
        // Google's tag loads only in production and changes size with Google's releases: blocking
        // it keeps the gate on our bytes and makes previews measure what production ships.
        blockedUrlPatterns: ["*googletagmanager.com*", "*google-analytics.com*"],
        ...(production
          ? {}
          : {
              // The preview toolbar is not ours. Lighthouse sends this header to every origin;
              // it is not a secret. A JSON string, because as an object Lighthouse's CLI parsing
              // hands Chrome a non-string value.
              extraHeaders: JSON.stringify({ "x-vercel-skip-toolbar": "1" }),
              // Previews answer with noindex on purpose.
              skipAudits: ["is-crawlable"],
            }),
      },
    },
    assert: {
      assertMatrix: [
        ...routes.map(({ url, budget }) => ({
          matchingUrlPattern: `^${RegExp.escape(url)}$`,
          aggregationMethod: "median-run",
          assertions: {
            "categories:accessibility": ["error", { minScore: 1 }],
            "categories:best-practices": ["error", { minScore: 0.95 }],
            "categories:seo": ["error", { minScore: 0.95 }],
            "resource-summary:script:size": ["error", { maxNumericValue: budget.scriptBytes }],
            "resource-summary:total:size": ["error", { maxNumericValue: budget.totalBytes }],
          },
        })),
        // LHCI matches entries on the URL Chrome ended on and silently skips runs no entry
        // matches, so a redirect (or a login page) would pass unasserted. A missing audit always
        // fails, and the report names the stray URL.
        {
          matchingUrlPattern: `^(?!(?:${routes.map(({ url }) => RegExp.escape(url)).join("|")})$)`,
          assertions: { "unexpected-final-url": "error" },
        },
      ],
    },
    upload: { target: "filesystem", outputDir: ".lighthouseci" },
  },
};
module.exports.budgets = budgets;
