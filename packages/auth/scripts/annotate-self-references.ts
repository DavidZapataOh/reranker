import { readFileSync, writeFileSync } from "node:fs";

const PG_CORE_IMPORT = '} from "drizzle-orm/pg-core";\n';

/**
 * The Better Auth CLI emits `references(() => table.id)` inside that same table, which TypeScript
 * cannot type (TS7022). Drizzle's documented fix for a self-reference is an `AnyPgColumn` return
 * annotation, so this adds exactly that and changes nothing else.
 */
export function annotateSelfReferences(source: string): string {
  const declarations = [...source.matchAll(/^export const (\w+) = /gm)];
  let annotated = 0;
  const chunks = declarations.map((match, index) => {
    const name = match[1] as string;
    const end = declarations[index + 1]?.index ?? source.length;
    return source.slice(match.index, end).replaceAll(`references(() => ${name}.`, () => {
      annotated += 1;
      return `references((): AnyPgColumn => ${name}.`;
    });
  });
  if (annotated === 0) return source;
  const body = source.slice(0, declarations[0]?.index) + chunks.join("");
  return body.replace(
    PG_CORE_IMPORT,
    `${PG_CORE_IMPORT}import type { AnyPgColumn } from "drizzle-orm/pg-core";\n`,
  );
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) throw new Error("Usage: annotate-self-references <schema file>");
  writeFileSync(file, annotateSelfReferences(readFileSync(file, "utf8")));
}
