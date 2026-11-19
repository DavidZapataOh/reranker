import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));

// Plain Node, without the test alias that empties `server-only`: the real module throws on
// import, so loading the root proves no server-only module is reached. The hook only adds the
// extension or index file that bundlers infer and records every module that loads.
const hooks = `
import { registerHooks } from "node:module";
globalThis.loaded = [];
registerHooks({
  resolve(specifier, context, next) {
    let result;
    try { result = next(specifier, context); }
    catch (error) {
      if (!specifier.startsWith(".")) throw error;
      try { result = next(specifier + ".ts", context); }
      catch { result = next(specifier + "/index.ts", context); }
    }
    globalThis.loaded.push(result.url);
    return result;
  },
});
`;

const script = `
await import("@reranker/stats");
process.stdout.write(JSON.stringify(globalThis.loaded));
`;

test("the package root loads in plain Node and reaches only schema and i18n", () => {
  const out = execFileSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(hooks)}`,
      "--input-type=module",
      "-e",
      script,
    ],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" },
  );
  const loaded: string[] = JSON.parse(out);
  expect(loaded.some((url) => url.includes("/packages/stats/src/observations.ts"))).toBe(true);
  expect(loaded.filter((url) => url.includes("server-only"))).toEqual([]);
  const workspace = new Set(
    loaded.flatMap((url) => /\/packages\/([^/]+)\/src\//.exec(url)?.[1] ?? []),
  );
  expect([...workspace].sort()).toEqual(["i18n", "schema", "stats"]);
  // A cold child Node that transpiles the package graph: ~1.3 s alone, up to 7.9 s measured with
  // two coverage runs of this suite in parallel, past Vitest's 5 s default.
}, 20_000);

type Manifest = {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function workspaceManifests(): Map<string, Manifest> {
  const manifests = new Map<string, Manifest>();
  for (const dir of ["apps", "packages", "tools"]) {
    let entries: string[];
    try {
      entries = readdirSync(`${root}/${dir}`);
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const m: Manifest = JSON.parse(
          readFileSync(`${root}/${dir}/${entry}/package.json`, "utf8"),
        );
        manifests.set(m.name, m);
      } catch {}
    }
  }
  return manifests;
}

// Turbo builds its graph from dependencies and devDependencies alike, so a package that stats
// declares must never lead back to stats, whatever its modules import.
test("no workspace package stats declares, directly or transitively, depends on stats", () => {
  const manifests = workspaceManifests();
  const edges = (m: Manifest) =>
    Object.keys({ ...m.dependencies, ...m.devDependencies }).filter((d) => manifests.has(d));
  const stats = manifests.get("@reranker/stats") as Manifest;
  expect(edges(stats)).not.toContain("@reranker/capture");
  expect(edges(stats)).not.toContain("@reranker/extraction");

  const reached = new Set<string>();
  const pending = edges(stats);
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (reached.has(name)) continue;
    reached.add(name);
    pending.push(...edges(manifests.get(name) as Manifest));
  }
  expect(reached.has("@reranker/stats")).toBe(false);
  expect(reached.has("@reranker/capture")).toBe(false);
  expect(reached.has("@reranker/catalog")).toBe(false);
});
