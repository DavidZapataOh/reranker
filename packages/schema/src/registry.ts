import { z } from "./z";

const ids = new Map<string, z.ZodType>();

export function registerSchema<T extends z.ZodType>(id: string, schema: T): T {
  if (!/^[A-Z][A-Za-z0-9]+$/.test(id)) {
    throw new Error(`Schema id must be PascalCase: ${id}`);
  }
  if (ids.has(id)) {
    throw new Error(`Duplicate schema id: ${id}`);
  }
  ids.set(id, schema);
  z.globalRegistry.add(schema, { id });
  return schema;
}
