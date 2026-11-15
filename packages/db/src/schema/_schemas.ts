import { pgSchema } from "drizzle-orm/pg-core";

// The Better Auth CLI declares the auth schema in the generated file; one object keeps drizzle-kit
// from emitting it twice.
export { authSchema } from "./auth";

export const appSchema = pgSchema("app");
export const publicPanelSchema = pgSchema("public_panel");
export const opsSchema = pgSchema("ops");
