import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { expect, test } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

async function bundle(entries: string[]): Promise<Uint8Array> {
  const { outputFiles } = await build({
    absWorkingDir: root,
    entryPoints: entries,
    bundle: true,
    write: false,
    format: "esm",
    minify: true,
    jsx: "automatic",
    external: ["react", "react-dom", "react/jsx-runtime"],
    outdir: "out",
    logLevel: "silent",
  });
  return Buffer.concat(outputFiles.map((file) => file.contents));
}

test("the client islands stay within 6 KiB gzipped", async () => {
  const bytes = gzipSync(await bundle(["src/help/Sheet.tsx", "src/help/Term.tsx"]), {
    level: 9,
  }).length;
  expect(bytes).toBeLessThanOrEqual(6 * 1024);
});
