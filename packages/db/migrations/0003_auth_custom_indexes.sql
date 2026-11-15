-- Custom SQL migration file, put your code below! --
-- Both tables are created empty by 0002_auth and drizzle applies pending files in one transaction,
-- where CONCURRENTLY is not allowed.
-- squawk-ignore require-concurrent-index-creation
create unique index organizations_single_house_idx on auth.organizations (kind) where kind = 'house';
--> statement-breakpoint
-- squawk-ignore require-concurrent-index-creation
create index members_user_id_organization_id_idx on auth.members (user_id, organization_id);
