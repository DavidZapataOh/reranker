import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resetAppEnv } from "@reranker/env";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("next/server", () => ({ connection: vi.fn(async () => {}) }));

const here = dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = /^(@reranker\/(db|flags|jobs)(\/|$)|resend$|posthog-)/;

beforeEach(() => {
  vi.stubEnv("APP_ENV", "preview");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc");
  resetAppEnv();
  globalThis.__envError = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetAppEnv();
  globalThis.__envError = undefined;
});

async function get() {
  return (await import("./route")).GET();
}

test("200 with version and env, never cached", async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ status: "ok", version: "abc", env: "preview" });
});

test("reports dev as the version outside Vercel", async () => {
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
  expect(await (await get()).json()).toMatchObject({ version: "dev" });
});

test("503 when env validation failed, without internals", async () => {
  globalThis.__envError = new Error("POSTHOG_FEATURE_FLAGS_KEY (missing)");
  const response = await get();
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ status: "env_invalid" });
});

test("503 when APP_ENV itself is unusable", async () => {
  vi.stubEnv("APP_ENV", "");
  resetAppEnv();
  const response = await get();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toMatch(/APP_ENV/);
});

const workspace = resolve(here, "../../../../../..");
const SPECIFIER = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

function resolveFile(base: string): string | undefined {
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`];
  return candidates.find((c) => /\.tsx?$/.test(c) && existsSync(c));
}

// Workspace packages map to their source through `exports`; anything else is a leaf.
function resolveSpecifier(specifier: string, from: string): string | undefined {
  if (specifier.startsWith(".")) return resolveFile(resolve(dirname(from), specifier));
  const match = /^@reranker\/([^/]+)(\/.*)?$/.exec(specifier);
  if (!match) return undefined;
  const dir = resolve(workspace, "packages", match[1] as string);
  const exports = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")).exports;
  const target = exports[`.${match[2] ?? ""}`];
  return typeof target === "string" ? resolve(dir, target) : undefined;
}

function importGraph(entry: string): Set<string> {
  const specifiers = new Set<string>();
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, specifier = ""] of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      specifiers.add(specifier);
      const resolved = resolveSpecifier(specifier, file);
      if (resolved) queue.push(resolved);
    }
  }
  return specifiers;
}

test("the import graph never reaches the database, flags, jobs or providers", () => {
  const graph = importGraph(resolve(here, "route.ts"));
  expect(graph).toContain("@reranker/env");
  expect(graph).toContain("@reranker/schema");
  expect([...graph].filter((s) => FORBIDDEN.test(s))).toEqual([]);
});

test("p95 stays under 100 ms over 200 calls", async () => {
  const { GET } = await import("./route");
  const times: number[] = [];
  for (let i = 0; i < 200; i++) {
    const start = performance.now();
    await GET();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(100);
});
