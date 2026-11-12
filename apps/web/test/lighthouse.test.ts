import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicRoutes } from "../e2e/routes.ts";
import { budgets, lighthouseConfig } from "../lighthouse.ts";

const PREVIEW = "https://reranker-abc123-davidzapataohs-projects.vercel.app";

type Assertions = Record<string, [string, Record<string, number>]>;

function configFor(env: Record<string, string>) {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return lighthouseConfig(process.env);
}

function matrixFor(config: ReturnType<typeof lighthouseConfig>, href: string): Assertions {
  const entries = config.ci.assert.assertMatrix.filter((e) =>
    new RegExp(e.matchingUrlPattern).test(href),
  );
  expect(entries).toHaveLength(1);
  return entries[0]?.assertions as Assertions;
}

afterEach(() => vi.unstubAllEnvs());

describe("lighthouseConfig", () => {
  it("audits every public route on the validated deployment origin, 3 runs each", () => {
    const config = configFor({
      CI: "",
      PLAYWRIGHT_BASE_URL: `${PREVIEW}/ignored?x=1`,
      APP_TARGET: "preview",
    });
    expect(config.ci.collect.url).toEqual(publicRoutes.map((r) => new URL(r.path, PREVIEW).href));
    expect(config.ci.collect.numberOfRuns).toBe(3);
    expect(config.ci.collect.startServerCommand).toBeUndefined();
    expect(config.ci.assert.aggregationMethod).toBe("median-run");
  });

  it("refuses a deployment URL that is not this project's before building headers", () => {
    expect(() =>
      configFor({
        CI: "true",
        VERCEL_AUTOMATION_BYPASS_SECRET: "s3cret",
        PLAYWRIGHT_BASE_URL: "https://evil.example",
      }),
    ).toThrow("untrusted deployment URL");
  });

  it("sends the bypass headers when the secret is set", () => {
    const config = configFor({
      CI: "true",
      VERCEL_AUTOMATION_BYPASS_SECRET: "s3cret",
      PLAYWRIGHT_BASE_URL: PREVIEW,
      APP_TARGET: "preview",
    });
    expect(JSON.parse(config.ci.collect.settings.extraHeaders ?? "{}")).toMatchObject({
      "x-vercel-protection-bypass": "s3cret",
    });
  });

  it("fails in CI without the bypass secret", () => {
    expect(() =>
      configFor({
        CI: "true",
        VERCEL_AUTOMATION_BYPASS_SECRET: "",
        PLAYWRIGHT_BASE_URL: PREVIEW,
        APP_TARGET: "preview",
      }),
    ).toThrow("Missing required environment variable VERCEL_AUTOMATION_BYPASS_SECRET");
  });

  it("starts the local production server when no deployment is given", () => {
    const config = configFor({
      CI: "",
      VERCEL_AUTOMATION_BYPASS_SECRET: "",
      PLAYWRIGHT_BASE_URL: "",
      PORT: "4100",
    });
    expect(config.ci.collect.url[0]).toBe("http://localhost:4100/");
    expect(config.ci.collect.startServerCommand).toBe("pnpm start");
    expect(config.ci.collect.settings.extraHeaders).toBeUndefined();
  });

  it("keeps third-party analytics out of the measurement", () => {
    const config = configFor({ CI: "", PLAYWRIGHT_BASE_URL: PREVIEW, APP_TARGET: "preview" });
    const blocked = config.ci.collect.settings.blockedUrlPatterns;
    for (const url of [
      "https://www.googletagmanager.com/gtag/js?id=G-1",
      "https://region1.google-analytics.com/g/collect",
      "https://www.clarity.ms/tag/abc",
    ]) {
      expect(
        blocked.some((p) =>
          new RegExp(`^${p.replaceAll(".", "\\.").replaceAll("*", ".*")}$`).test(url),
        ),
      ).toBe(true);
    }
  });

  it("asserts each route against its own budget, accessibility 1 and best practices 0.95", () => {
    const config = configFor({ CI: "", PLAYWRIGHT_BASE_URL: PREVIEW, APP_TARGET: "preview" });
    for (const route of publicRoutes) {
      const a = matrixFor(config, new URL(route.path, PREVIEW).href);
      const budget = budgets[route.budgetKey];
      expect(budget).toBeDefined();
      expect(a["categories:accessibility"]).toEqual(["error", { minScore: 1 }]);
      expect(a["categories:best-practices"]).toEqual(["error", { minScore: 0.95 }]);
      expect(a["resource-summary:script:size"]).toEqual([
        "error",
        { maxNumericValue: budget?.scriptBytes },
      ]);
      expect(a["resource-summary:total:size"]).toEqual([
        "error",
        { maxNumericValue: budget?.totalBytes },
      ]);
      expect(a["resource-summary:third-party:count"]).toEqual(["error", { maxNumericValue: 0 }]);
    }
  });

  it("matches route patterns exactly, so / never picks up /terminos", () => {
    const config = configFor({ CI: "", PLAYWRIGHT_BASE_URL: PREVIEW, APP_TARGET: "preview" });
    const home = config.ci.assert.assertMatrix.find((e) =>
      new RegExp(e.matchingUrlPattern).test(`${PREVIEW}/`),
    );
    expect(new RegExp(home?.matchingUrlPattern ?? "").test(`${PREVIEW}/terminos`)).toBe(false);
    expect(new RegExp(home?.matchingUrlPattern ?? "").test(`${PREVIEW}/?utm=1`)).toBe(false);
  });

  it("caps the landing at 345 KB of script", () => {
    expect(budgets.landing?.scriptBytes).toBe(345_000);
  });

  it("checks SEO only in production and skips is-crawlable elsewhere", () => {
    const preview = configFor({ CI: "", PLAYWRIGHT_BASE_URL: PREVIEW, APP_TARGET: "preview" });
    expect(preview.ci.collect.settings.skipAudits).toEqual(["is-crawlable"]);
    expect(matrixFor(preview, `${PREVIEW}/`)["categories:seo"]).toBeUndefined();

    const production = configFor({
      CI: "",
      PLAYWRIGHT_BASE_URL: "https://reranker.co",
      APP_TARGET: "production",
    });
    expect(production.ci.collect.settings.skipAudits).toEqual([]);
    expect(matrixFor(production, "https://reranker.co/")["categories:seo"]).toEqual([
      "error",
      { minScore: 0.95 },
    ]);
  });

  it("refuses a route without a budget", () => {
    publicRoutes.push({ path: "/nueva", name: "new", budgetKey: "missing", screen: "new" });
    try {
      expect(() =>
        configFor({ CI: "", PLAYWRIGHT_BASE_URL: PREVIEW, APP_TARGET: "preview" }),
      ).toThrow('No Lighthouse budget "missing" for /nueva');
    } finally {
      publicRoutes.pop();
    }
  });

  it("is what lighthouserc.cjs hands to LHCI when Node loads it", async () => {
    const rc = fileURLToPath(new URL("../lighthouserc.cjs", import.meta.url));
    const { stdout } = await promisify(execFile)(
      "node",
      ["-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(rc)})))`],
      {
        env: {
          ...process.env,
          CI: "true",
          VERCEL_AUTOMATION_BYPASS_SECRET: "s3cret",
          PLAYWRIGHT_BASE_URL: PREVIEW,
          APP_TARGET: "preview",
        },
      },
    );
    const loaded = JSON.parse(stdout);
    expect(loaded.budgets).toEqual(budgets);
    expect(loaded.ci.collect.url).toEqual(publicRoutes.map((r) => new URL(r.path, PREVIEW).href));
    expect(loaded.ci.assert.assertMatrix).toHaveLength(publicRoutes.length);
  });

  it("writes reports to the private filesystem target only", () => {
    const config = configFor({ CI: "", PLAYWRIGHT_BASE_URL: PREVIEW, APP_TARGET: "preview" });
    expect(config.ci.upload).toEqual({ target: "filesystem", outputDir: ".lighthouseci" });
  });
});
