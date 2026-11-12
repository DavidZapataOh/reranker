import { pgSchema } from "drizzle-orm/pg-core";

// Everything owned by a customer or by the house tenant; every table carries tenant_id under RLS.
export const appSchema = pgSchema("app");
// Better Auth tables; the runtime tenant role has no grant on it.
export const authSchema = pgSchema("auth");
// World data without owner or personal data; tenants may only read it.
export const publicPanelSchema = pgSchema("public_panel");
// Internal operation state; tenants have no grant on it.
export const opsSchema = pgSchema("ops");
