import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// Plain Node, without the test alias that empties `server-only`: the real module throws on
// import, so loading the root proves no server-only module is reached. The hook only adds the
// `.ts` extension that bundlers infer and records every module that loads.
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

test("the package root loads in plain Node without server-only or the catalog", () => {
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
  expect(loaded.some((url) => url.includes("/packages/capture/src/slot.ts"))).toBe(true);
  expect(
    loaded.filter((url) => /server-only|\/packages\/(catalog|extraction)\//.test(url)),
  ).toEqual([]);
  expect(
    loaded.filter((url) => url.includes("/packages/capture/src/") && !url.endsWith("/slot.ts")),
  ).toEqual([]);
});
