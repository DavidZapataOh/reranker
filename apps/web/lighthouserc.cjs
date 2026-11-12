const { requireEnv } = require("@reranker/testing/env");
const { assertDeploymentUrl } = require("@reranker/testing/target");
const { appTarget, publicRoutes } = require("./e2e/routes.ts");

// The bypass cookie is requested for this origin, so it must be ours.
const { origin } = assertDeploymentUrl(requireEnv("PLAYWRIGHT_BASE_URL"), {
  allowProduction: true,
});
const production = appTarget === "production";

// Transferred bytes on a cold cache are deterministic, so they fail hard. Each value is the
// production baseline plus 5 %, except landing scripts, which stay at the original target.
const budgets = {
  landing: { scriptBytes: 345_000, totalBytes: 773_751 },
  legal: { scriptBytes: 519_774, totalBytes: 765_374 },
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
        // The preview toolbar is not ours. Not a secret: Lighthouse sends it to every origin.
        // A JSON string: as an object, Lighthouse's CLI parsing hands Chrome a non-string value.
        extraHeaders: JSON.stringify({ "x-vercel-skip-toolbar": "1" }),
        // Previews answer with noindex on purpose.
        ...(production ? {} : { skipAudits: ["is-crawlable"] }),
      },
    },
    assert: {
      assertMatrix: routes.map(({ url, budget }) => ({
        matchingUrlPattern: `^${RegExp.escape(url)}$`,
        aggregationMethod: "median-run",
        assertions: {
          "categories:accessibility": ["error", { minScore: 1 }],
          "categories:best-practices": ["error", { minScore: 0.95 }],
          ...(production ? { "categories:seo": ["error", { minScore: 0.95 }] } : {}),
          "resource-summary:script:size": ["error", { maxNumericValue: budget.scriptBytes }],
          "resource-summary:total:size": ["error", { maxNumericValue: budget.totalBytes }],
        },
      })),
    },
    upload: { target: "filesystem", outputDir: ".lighthouseci" },
  },
};
module.exports.budgets = budgets;
