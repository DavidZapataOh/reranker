import { pgSchema } from "drizzle-orm/pg-core";

export const appSchema = pgSchema("app");
export const authSchema = pgSchema("auth");
export const publicPanelSchema = pgSchema("public_panel");
export const opsSchema = pgSchema("ops");
