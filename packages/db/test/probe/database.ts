import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import config from "../../drizzle.config";
import * as schema from "../../src/schema";
import * as isolationProbe from "./isolation-probe.schema";

// The DDL drizzle-kit would emit for the probe tables on top of the production schema.
export async function probeStatements(
  probe: Record<string, unknown> = isolationProbe,
): Promise<string[]> {
  const filter = [config.schemaFilter ?? []].flat();
  const base = generateDrizzleJson({ ...schema }, undefined, filter, "snake_case");
  const withProbe = generateDrizzleJson({ ...schema, ...probe }, base.id, filter, "snake_case");
  return generateMigration(base, withProbe);
}

export function onDatabase(url: string, name: string): string {
  const target = new URL(url);
  target.pathname = `/${name}`;
  return target.toString();
}
