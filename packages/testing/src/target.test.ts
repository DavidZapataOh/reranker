import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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

  it("normalizes case and the default port to the same trusted origin", () => {
    expect(assertDeploymentUrl("https://RERANKER.CO:443/", { allowProduction: true }).origin).toBe(
      "https://reranker.co",
    );
    expect(
      assertDeploymentUrl("https://Reranker-ABC-davidzapataohs-projects.vercel.app", {
        allowProduction: false,
      }).origin,
    ).toBe("https://reranker-abc-davidzapataohs-projects.vercel.app");
  });

  it.each([
    "http://reranker-abc-davidzapataohs-projects.vercel.app",
    "https://evil-davidzapataohs-projects.vercel.app",
    "https://reranker-abc-davidzapataohs-projects.vercel.app.evil.com",
    "https://www.reranker.co",
    "https://reranker.co.",
    "https://reranker-abc-davidzapataohs-projects.vercel.app.",
    "https://reranker.co:8443",
    "https://reranker-abc-davidzapataohs-projects.vercel.app:8080",
    "https://user:pass@reranker.co",
    "https://token@reranker-abc-davidzapataohs-projects.vercel.app",
    "https://76.76.21.21",
    "https://[::1]",
    "not a url",
    "",
  ])("refuses untrusted target %j", (u) => {
    expect(() => assertDeploymentUrl(u, { allowProduction: true })).toThrow(
      "untrusted deployment URL",
    );
  });

  it("refuses www.reranker.co as untrusted even when production is not allowed", () => {
    expect(() =>
      assertDeploymentUrl("https://www.reranker.co", { allowProduction: false }),
    ).toThrow("untrusted deployment URL");
  });

  const refusal = (url: string) => {
    try {
      assertDeploymentUrl(url, { allowProduction: true });
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error(`accepted ${url}`);
  };

  it("quotes the rejected URL so control characters cannot reach the log", () => {
    const message = refusal("https://evil.com/\n::add-mask::x\r%0A");
    expect(message).toMatch(/^untrusted deployment URL: "/);
    expect(message).not.toMatch(/[\r\n]/);
    expect(message).toContain(String.raw`\n::add-mask::x\r`);
  });

  it("caps the quoted URL length", () => {
    expect(refusal(`https://evil.com/${"a".repeat(5000)}`).length).toBeLessThan(300);
  });
});

describe("assert-target CLI", () => {
  const cli = fileURLToPath(new URL("../bin/assert-target.ts", import.meta.url));
  const run = (...args: string[]) => promisify(execFile)(process.execPath, [cli, ...args]);

  it("prints only the validated origin on success", async () => {
    const { stdout } = await run("https://RERANKER.CO/terminos?x=1");
    expect(stdout).toBe("https://reranker.co\n");
  });

  it("exits 1 with a single sanitized error annotation", async () => {
    await expect(run("https://example.com/\n::set-env name=X::y")).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringMatching(/^::error::untrusted deployment URL: "[^\n]*"\n$/),
    });
  });

  it("refuses production with --preview-only", async () => {
    await expect(run("https://reranker.co", "--preview-only")).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("production target refused"),
    });
  });
});
