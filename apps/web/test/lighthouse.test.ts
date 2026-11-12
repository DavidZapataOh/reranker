import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Browser } from "puppeteer-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publicRoutes } from "../e2e/routes.ts";
import { budgets, lighthouseConfig, setBypassCookie } from "../lighthouse.ts";

const PREVIEW = "https://reranker-abc123-davidzapataohs-projects.vercel.app";
const PRODUCTION = "https://reranker.co";

type Config = ReturnType<typeof lighthouseConfig>;
type Assertions = Record<string, [string, Record<string, number>]>;
type AssertionResult = { auditId: string; auditProperty?: string; url: string; passed: boolean };

// LHCI's own assertion engine, so the config is checked the way `lhci assert` reads it.
const lhciRequire = createRequire(createRequire(import.meta.url).resolve("@lhci/cli/package.json"));
const { getAllAssertionResults } = lhciRequire("@lhci/utils/src/assertions.js") as {
  getAllAssertionResults: (options: unknown, lhrs: unknown[]) => AssertionResult[];
};

function configFor(env: Record<string, string>): Config {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  return lighthouseConfig(process.env);
}

function matrixFor(config: Config, href: string): Assertions {
  const entries = config.ci.assert.assertMatrix.filter((e) =>
    new RegExp(e.matchingUrlPattern).test(href),
  );
  expect(entries).toHaveLength(1);
  return entries[0]?.assertions as Assertions;
}

function lhr(href: string, bytes: { script: number; total: number }) {
  return {
    finalUrl: href,
    categories: {
      performance: { score: 0.9 },
      accessibility: { score: 1 },
      "best-practices": { score: 1 },
      seo: { score: 1 },
    },
    audits: {
      "resource-summary": {
        score: null,
        details: {
          items: [
            { resourceType: "script", transferSize: bytes.script, requestCount: 10 },
            { resourceType: "total", transferSize: bytes.total, requestCount: 30 },
          ],
        },
      },
    },
  };
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
  });

  it("refuses a deployment URL that is not this project's", () => {
    expect(() =>
      configFor({
        CI: "true",
        VERCEL_AUTOMATION_BYPASS_SECRET: "s3cret",
        PLAYWRIGHT_BASE_URL: "https://evil.example",
      }),
    ).toThrow("untrusted deployment URL");
  });

  it("passes protected deployments through the bypass cookie script, never extraHeaders", () => {
    const config = configFor({
      CI: "true",
      VERCEL_AUTOMATION_BYPASS_SECRET: "s3cret",
      PLAYWRIGHT_BASE_URL: PREVIEW,
      APP_TARGET: "preview",
    });
    expect(config.ci.collect.puppeteerScript).toBe("./lighthouse-bypass.cjs");
    expect(config.ci.collect.settings).not.toHaveProperty("extraHeaders");
    expect(JSON.stringify(config)).not.toContain("s3cret");
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
    expect(config.ci.collect.puppeteerScript).toBeUndefined();
  });

  it("keeps third-party analytics and the preview toolbar out of the measurement", () => {
    const config = configFor({ CI: "", PLAYWRIGHT_BASE_URL: PREVIEW, APP_TARGET: "preview" });
    const blocked = config.ci.collect.settings.blockedUrlPatterns.map(
      (p) => new RegExp(`^${p.replaceAll(".", "\\.").replaceAll("*", ".*")}$`),
    );
    for (const url of [
      "https://www.googletagmanager.com/gtag/js?id=G-1",
      "https://region1.google-analytics.com/g/collect",
      "https://www.clarity.ms/tag/abc",
      "https://vercel.live/_next-live/feedback/feedback.js",
    ]) {
      expect(blocked.some((p) => p.test(url))).toBe(true);
    }
    expect(blocked.some((p) => p.test(`${PREVIEW}/_next/static/chunk.js`))).toBe(false);
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
    }
  });

  it("matches route patterns exactly, so / never picks up /terminos", () => {
    const config = configFor({ CI: "", PLAYWRIGHT_BASE_URL: PREVIEW, APP_TARGET: "preview" });
    const home = new RegExp(matrixPattern(config, `${PREVIEW}/`));
    expect(home.test(`${PREVIEW}/terminos`)).toBe(false);
    expect(home.test(`${PREVIEW}/?utm=1`)).toBe(false);
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
      PLAYWRIGHT_BASE_URL: PRODUCTION,
      APP_TARGET: "production",
    });
    expect(production.ci.collect.settings.skipAudits).toEqual([]);
    expect(matrixFor(production, `${PRODUCTION}/`)["categories:seo"]).toEqual([
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

  it("writes reports to the private filesystem target only", () => {
    const config = configFor({ CI: "", PLAYWRIGHT_BASE_URL: PREVIEW, APP_TARGET: "preview" });
    expect(config.ci.upload).toEqual({ target: "filesystem", outputDir: ".lighthouseci" });
  });
});

describe("assertions as LHCI evaluates them", () => {
  const config = () =>
    configFor({ CI: "", PLAYWRIGHT_BASE_URL: PRODUCTION, APP_TARGET: "production" });
  const runs = (href: string, bytes: { script: number; total: number }) => [
    lhr(href, bytes),
    lhr(href, bytes),
    lhr(href, bytes),
  ];
  const withinBudget = publicRoutes.flatMap((r) => {
    const b = budgets[r.budgetKey] as { scriptBytes: number; totalBytes: number };
    return runs(new URL(r.path, PRODUCTION).href, { script: b.scriptBytes, total: b.totalBytes });
  });

  // LHCI returns only failures, so passing at budget alone would not prove a route was matched.
  it("passes every route at its budget and fails each one a byte over", () => {
    expect(getAllAssertionResults(config().ci.assert, withinBudget)).toEqual([]);

    const over = publicRoutes.flatMap((r) => {
      const b = budgets[r.budgetKey] as { scriptBytes: number; totalBytes: number };
      return runs(new URL(r.path, PRODUCTION).href, {
        script: b.scriptBytes + 1,
        total: b.totalBytes + 1,
      });
    });
    const failed = getAllAssertionResults(config().ci.assert, over);
    expect(failed.map((r) => [r.url, r.auditProperty]).sort()).toEqual(
      publicRoutes
        .flatMap((r) => {
          const href = new URL(r.path, PRODUCTION).href;
          return [
            [href, "script.size"],
            [href, "total.size"],
          ];
        })
        .sort(),
    );
  });

  it("fails a route whose accessibility drops below 1", () => {
    const lhrs = withinBudget.map((l) => ({
      ...l,
      categories: { ...l.categories, accessibility: { score: 0.99 } },
    }));
    const failed = getAllAssertionResults(config().ci.assert, lhrs);
    expect(failed.filter((r) => r.auditProperty === "accessibility")).toHaveLength(
      publicRoutes.length,
    );
  });

  it("fails a run that ends on a URL no route expects, such as a redirect", () => {
    const stray = `${PRODUCTION}/login`;
    const lhrs = [...withinBudget, ...runs(stray, { script: 1, total: 1 })];
    const failed = getAllAssertionResults(config().ci.assert, lhrs).filter((r) => !r.passed);
    expect(failed.map((r) => r.url)).toEqual([stray]);
  });

  it("fails / on script size when a heavy dependency lands on the landing", () => {
    const home = `${PRODUCTION}/`;
    const lhrs = [
      ...withinBudget.filter((l) => l.finalUrl !== home),
      ...runs(home, { script: 345_001, total: 500_000 }),
    ];
    const failed = getAllAssertionResults(config().ci.assert, lhrs).filter((r) => !r.passed);
    expect(failed.map((r) => [r.url, r.auditProperty])).toEqual([[home, "script.size"]]);
  });
});

describe("lighthouserc.cjs", () => {
  it("hands LHCI the same config when Node loads it", async () => {
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
    expect(loaded.ci.assert.assertMatrix).toHaveLength(publicRoutes.length + 1);
  });

  it("exports the bypass cookie script for collect.puppeteerScript", async () => {
    const script = fileURLToPath(new URL("../lighthouse-bypass.cjs", import.meta.url));
    const { stdout } = await promisify(execFile)("node", [
      "-e",
      `process.stdout.write(typeof require(${JSON.stringify(script)}))`,
    ]);
    expect(stdout).toBe("function");
  });
});

describe("setBypassCookie", () => {
  type Handler = (request: FakeRequest) => void;
  type FakeRequest = {
    url: () => string;
    headers: () => Record<string, string>;
    abort: ReturnType<typeof vi.fn>;
    continue: ReturnType<typeof vi.fn>;
  };

  function fakeBrowser(status: number | null) {
    let onRequest: Handler = () => {};
    const page = {
      setRequestInterception: vi.fn(async () => {}),
      on: vi.fn((_event: string, handler: Handler) => {
        onRequest = handler;
      }),
      goto: vi.fn(async () =>
        status === null ? null : { ok: () => status < 400, status: () => status },
      ),
      close: vi.fn(async () => {}),
    };
    const browser = { newPage: vi.fn(async () => page) } as unknown as Browser;
    const request = (url: string): FakeRequest => {
      const r = {
        url: () => url,
        headers: () => ({ accept: "text/html" }),
        abort: vi.fn(),
        continue: vi.fn(),
      };
      onRequest(r);
      return r;
    };
    return { browser, page, request };
  }

  it("sends the bypass headers only to the deployment and blocks every other origin", async () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "s3cret");
    const { browser, page, request } = fakeBrowser(200);
    await setBypassCookie(browser, { url: `${PREVIEW}/terminos` });

    expect(page.setRequestInterception).toHaveBeenCalledWith(true);
    const own = request(`${PREVIEW}/_next/static/a.js`);
    expect(own.continue).toHaveBeenCalledWith({
      headers: {
        accept: "text/html",
        "x-vercel-protection-bypass": "s3cret",
        "x-vercel-skip-toolbar": "1",
        "x-vercel-set-bypass-cookie": "true",
      },
    });
    const foreign = request("https://www.googletagmanager.com/gtag/js");
    expect(foreign.abort).toHaveBeenCalled();
    expect(foreign.continue).not.toHaveBeenCalled();
    expect(page.close).toHaveBeenCalled();
  });

  it("fails loudly and closes the page when the deployment refuses the bypass", async () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "wrong");
    const { browser, page } = fakeBrowser(401);
    await expect(setBypassCookie(browser, { url: `${PREVIEW}/` })).rejects.toThrow(
      `Bypass cookie not set for ${PREVIEW} (401)`,
    );
    expect(page.close).toHaveBeenCalled();
  });

  it("reports a missing response", async () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "s3cret");
    const { browser } = fakeBrowser(null);
    await expect(setBypassCookie(browser, { url: `${PREVIEW}/` })).rejects.toThrow("(no response)");
  });

  it("never opens a page for a foreign URL", async () => {
    vi.stubEnv("CI", "true");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "s3cret");
    const { browser } = fakeBrowser(200);
    await expect(setBypassCookie(browser, { url: "https://evil.example/" })).rejects.toThrow(
      "untrusted deployment URL",
    );
    expect(browser.newPage).not.toHaveBeenCalled();
  });
});

function matrixPattern(config: Config, href: string): string {
  const entry = config.ci.assert.assertMatrix.find((e) =>
    new RegExp(e.matchingUrlPattern).test(href),
  );
  return entry?.matchingUrlPattern ?? "";
}
