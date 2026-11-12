import { pgSchema } from "drizzle-orm/pg-core";

// Customer and house-tenant data, isolated by tenant_id with row level security.
export const appSchema = pgSchema("app");
// Auth library tables; the runtime tenant role has no grant on it.
export const authSchema = pgSchema("auth");
// Shared world data without owner or personal data; tenants read it, only the system writes.
export const publicPanelSchema = pgSchema("public_panel");
// Internal operation state; tenants have no access.
export const opsSchema = pgSchema("ops");
