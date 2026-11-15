import { expect, test } from "vitest";
import { annotateSelfReferences } from "./annotate-self-references.ts";

const generated = `import {
  pgSchema,
  uuid,
  index,
} from "drizzle-orm/pg-core";

export const users = authSchema.table("users", {
  id: uuid("id").primaryKey(),
});

export const organizations = authSchema.table(
  "organizations",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").references(() => users.id),
    parentId: uuid("parent_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
  },
);
`;

test("annotates only the references a table makes to itself", () => {
  const annotated = annotateSelfReferences(generated);
  expect(annotated).toContain(
    'parentId: uuid("parent_id").references((): AnyPgColumn => organizations.id, {',
  );
  expect(annotated).toContain('ownerId: uuid("owner_id").references(() => users.id),');
  expect(annotated).toContain('import type { AnyPgColumn } from "drizzle-orm/pg-core";\n');
});

test("leaves a schema without self-references untouched and is idempotent", () => {
  const plain = generated.replace("organizations.id, {", "users.id, {");
  expect(annotateSelfReferences(plain)).toBe(plain);
  const once = annotateSelfReferences(generated);
  expect(annotateSelfReferences(once)).toBe(once);
});
