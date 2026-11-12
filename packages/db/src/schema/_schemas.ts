import { pgSchema } from "drizzle-orm/pg-core";

/** Rows owned by a customer or the house tenant; every table has tenant_id and RLS. */
export const appSchema = pgSchema("app");
/** Better Auth tables; only the system role reaches them. */
export const authSchema = pgSchema("auth");
/** World data without an owner or personal data; tenants may only read it. */
export const publicPanelSchema = pgSchema("public_panel");
/** Internal operation state; only the system role reaches it. */
export const opsSchema = pgSchema("ops");
