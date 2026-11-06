import { describe, expect, it } from "vitest";
import { assertDeploymentUrl } from "./target.ts";

describe("assertDeploymentUrl", () => {
  it.each([
    "https://reranker-abc123-davidzapataohs-projects.vercel.app",
    "https://reranker-git-feat-x-davidzapataohs-projects.vercel.app",
  ])("accepts this project's generated URL %s", (u) => {
    expect(assertDeploymentUrl(u, { allowProduction: false }).host).toMatch(/\.vercel\.app$/);
  });

  it("accepts reranker.co only when production is allowed", () => {
    expect(() => assertDeploymentUrl("https://reranker.co", { allowProduction: false })).toThrow(
      "production target refused",
    );
    expect(assertDeploymentUrl("https://reranker.co", { allowProduction: true }).host).toBe(
      "reranker.co",
    );
  });

  it.each([
    "http://reranker-abc-davidzapataohs-projects.vercel.app",
    "https://evil-davidzapataohs-projects.vercel.app",
    "https://reranker-abc-davidzapataohs-projects.vercel.app.evil.com",
    "https://www.reranker.co",
    "not a url",
  ])("refuses untrusted target %s", (u) => {
    expect(() => assertDeploymentUrl(u, { allowProduction: true })).toThrow(
      "untrusted deployment URL",
    );
  });
});
