import { pgRole } from "drizzle-orm/pg-core";

// Group roles created by the core migration; logins join them through provision-roles.
export const appTenant = pgRole("app_tenant").existing();
export const appSystem = pgRole("app_system").existing();
