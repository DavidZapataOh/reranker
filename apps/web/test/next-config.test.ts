import { existsSync } from "node:fs";
import { PHASE_PRODUCTION_SERVER } from "next/constants";
import { describe, expect, test, vi } from "vitest";

vi.stubEnv("APP_ENV", "development");
const { default: exported } = await import("../next.config");
// The server phase resolves the config without running the workflow build.
const nextConfig =
  typeof exported === "function"
    ? await exported(PHASE_PRODUCTION_SERVER, { defaultConfig: {} })
    : exported;

describe("workflows", () => {
  test("the config is wrapped by withWorkflow", () => {
    expect(typeof exported).toBe("function");
    expect(nextConfig.serverExternalPackages).toEqual(expect.arrayContaining([expect.any(String)]));
  });
});

describe("next-intl", () => {
  test("resolves its request config to src/i18n/request.ts", () => {
    const alias = nextConfig.turbopack?.resolveAlias?.["next-intl/config"];
    expect(alias).toBe("./src/i18n/request.ts");
  });

  test("keeps the app's own Turbopack rules", () => {
    expect(nextConfig.turbopack?.rules?.["*.css"]).toEqual({
      loaders: ["@tailwindcss/turbopack"],
      as: "*.css",
    });
  });
});

describe("next config headers", () => {
  test("serves email assets as immutable", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const rule = rules.find((r) => r.source === "/email/:path*");
    expect(rule?.headers).toEqual([
      { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
    ]);
  });

  test("no other rule touches the email assets", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules.filter((r) => r.source.startsWith("/email"))).toHaveLength(1);
  });

  test("publishes the brand tile the sign-in email links to", () => {
    expect(existsSync(new URL("../public/email/reranker-symbol-96.png", import.meta.url))).toBe(
      true,
    );
  });
});
