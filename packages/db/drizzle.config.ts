import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  casing: "snake_case",
  entities: { roles: { provider: "neon" } },
  schemaFilter: ["app", "auth", "public_panel", "ops"],
  dbCredentials: { url: process.env.DATABASE_URL_MIGRATIONS ?? "" },
});
