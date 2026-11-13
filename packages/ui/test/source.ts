import { glob, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

export async function readSources(globs: string[]): Promise<{ path: string; text: string }[]> {
  const paths: string[] = [];
  for await (const path of glob(globs, { cwd: root })) paths.push(path);
  return Promise.all(
    paths.sort().map(async (path) => ({ path, text: await readFile(`${root}${path}`, "utf8") })),
  );
}
