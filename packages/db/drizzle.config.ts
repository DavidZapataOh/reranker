import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL_MIGRATIONS;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  casing: "snake_case",
  entities: { roles: { provider: "neon" } },
  schemaFilter: ["app", "auth", "public_panel", "ops"],
  // generate and check work offline; only introspection needs the owner connection.
  ...(url === undefined ? {} : { dbCredentials: { url } }),
});
