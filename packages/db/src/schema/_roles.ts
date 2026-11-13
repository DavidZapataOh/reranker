import { pgRole } from "drizzle-orm/pg-core";

// Created by the core migration; `existing` keeps drizzle-kit from managing them.
export const appTenant = pgRole("app_tenant").existing();
export const appSystem = pgRole("app_system").existing();
