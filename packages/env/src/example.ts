import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AppEnv, z } from "@reranker/schema";

type Fragment = z.ZodObject;

const APP_ENV_DESCRIPTION = "Runtime environment: development, preview or production";

/** One commented line per variable, sorted by name, with no values: the file is what a new contributor copies. */
export function renderExample(fragments: readonly Fragment[]): string {
  const entries = new Map<string, { kind: string; description: string | undefined }>();
  entries.set("APP_ENV", { kind: "config", description: APP_ENV_DESCRIPTION });
  for (const fragment of fragments) {
    for (const [name, schema] of Object.entries(fragment.shape)) {
      if (entries.has(name)) continue;
      const meta = (schema as z.ZodType).meta() as
        | { kind?: string; description?: string }
        | undefined;
      entries.set(name, { kind: meta?.kind ?? "config", description: meta?.description });
    }
  }
  const blocks = [...entries]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, { kind, description }]) => {
      const label = kind === "secret" ? "Secret" : "Config";
      return `# ${description ? `${description} ` : ""}(${label})\n${name}=\n`;
    });
  return blocks.join("\n");
}

export function checkExample(path: string, fragments: readonly Fragment[]): boolean {
  return existsSync(path) && readFileSync(path, "utf8") === renderExample(fragments);
}

export type { AppEnv };

if (import.meta.main) {
  const root = new URL("../../../", import.meta.url);
  const target = fileURLToPath(new URL("apps/web/.env.example", root));
  const { fragments } = (await import(new URL("apps/web/src/env.ts", root).href)) as {
    fragments: readonly Fragment[];
  };
  if (process.argv.includes("--check")) {
    if (!checkExample(target, fragments)) {
      console.error("apps/web/.env.example is out of date: run `pnpm env:example` and commit it.");
      process.exit(1);
    }
  } else {
    writeFileSync(target, renderExample(fragments));
  }
}
