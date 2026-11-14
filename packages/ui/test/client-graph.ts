import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { readSources } from "./source.ts";

const defaultRoot = fileURLToPath(new URL("../src", import.meta.url));
const directive = /^(?:\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*["']use client["']/;

const hasDirective = async (file: string) => directive.test(await readFile(file, "utf8"));

export async function clientModules(): Promise<string[]> {
  const sources = await readSources(["src/**/*.{ts,tsx}"]);
  return sources
    .filter(({ text }) => directive.test(text))
    .map(({ path }) => path.replace(/^src\//, ""))
    .sort();
}

// Follows the real import graph (extensionless specifiers and index re-exports included) with esbuild;
// allowed modules are cut out of the graph so their own imports are never visited.
export async function clientModulesReachableFrom(
  entries: string[],
  { allow = [], root = defaultRoot }: { allow?: string[]; root?: string } = {},
): Promise<string[]> {
  const resolveEntry = (name: string) => `${root}/${name}`;
  const cutAllowed: Plugin = {
    name: "cut-allowed",
    setup(b) {
      b.onResolve({ filter: /^\.\.?\// }, async (args) => {
        if (args.pluginData === "cut-allowed") return undefined;
        const resolved = await b.resolve(args.path, {
          kind: args.kind,
          resolveDir: args.resolveDir,
          pluginData: "cut-allowed",
        });
        if (resolved.errors.length) return resolved;
        const isAllowed = allow.some(
          (name) => resolved.path.replace(/\.[jt]sx?$/, "") === resolveEntry(name),
        );
        if (!isAllowed) return resolved;
        return { path: resolved.path, external: true };
      });
    },
  };
  const { metafile } = await build({
    absWorkingDir: root,
    entryPoints: entries.map(resolveEntry),
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    jsx: "automatic",
    packages: "external",
    logLevel: "silent",
    outdir: "out",
    plugins: [cutAllowed],
    resolveExtensions: [".tsx", ".ts", ".js", ".jsx", ".json"],
  });
  const flagged: string[] = [];
  for (const input of Object.keys(metafile.inputs)) {
    if (await hasDirective(`${root}/${input}`)) flagged.push(input);
  }
  return flagged.sort();
}
