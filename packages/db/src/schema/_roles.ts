import { pgRole } from "drizzle-orm/pg-core";

// Created by the core migration before any table so grants and policies can name them.
export const appTenant = pgRole("app_tenant").existing();
export const appSystem = pgRole("app_system").existing();
