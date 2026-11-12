import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const REDACTED = "[redacted]";

/**
 * Rewrites every file under `dir` that contains `secret`. Lighthouse copies its settings,
 * request headers included, into each JSON and HTML report, and reports become artifacts.
 */
export async function redactSecret(dir: string, secret: string): Promise<string[]> {
  if (!secret) throw new Error("Refusing to redact an empty secret");
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const changed: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry);
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EISDIR") continue;
      throw error;
    }
    if (!content.includes(secret)) continue;
    await writeFile(path, content.toString("utf8").replaceAll(secret, REDACTED));
    changed.push(path);
  }
  return changed;
}
