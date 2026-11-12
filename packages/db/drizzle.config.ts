import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL_MIGRATIONS;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  casing: "snake_case",
  // Neon creates its own roles (neon_superuser, the owner); drizzle-kit must leave them alone.
  entities: { roles: { provider: "neon" } },
  schemaFilter: ["app", "auth", "public_panel", "ops"],
  // generate and check work offline; only introspection commands need the owner connection.
  ...(url ? { dbCredentials: { url } } : {}),
});
