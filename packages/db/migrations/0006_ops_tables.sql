-- The counters here are bounded far below 2^31 (slots in flight, calls per ten seconds, emails per
-- day, list rows), and node-postgres reads int4 as a number but int8 as a string.
-- squawk-ignore-file prefer-bigint-over-int
CREATE TABLE "ops"."breaker_state" (
	"provider" text NOT NULL,
	"account" text NOT NULL,
	"open_until" timestamp with time zone,
	"probe_until" timestamp with time zone,
	"opened_at" timestamp with time zone,
	CONSTRAINT "breaker_state_provider_account_pk" PRIMARY KEY("provider","account")
);
--> statement-breakpoint
CREATE TABLE "ops"."breaker_windows" (
	"provider" text NOT NULL,
	"account" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "breaker_windows_provider_account_bucket_start_pk" PRIMARY KEY("provider","account","bucket_start")
);
--> statement-breakpoint
CREATE TABLE "ops"."concurrency_leases" (
	"lease_id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."guard_modes" (
	"name" text PRIMARY KEY NOT NULL,
	"active_until" timestamp with time zone,
	"tripped_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ops"."lease_pools" (
	"key" text PRIMARY KEY NOT NULL,
	"max_in_flight" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."network_ranges" (
	"prefix" "cidr" PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "network_ranges_kind_check" CHECK ("ops"."network_ranges"."kind" in ('hosting', 'vpn'))
);
--> statement-breakpoint
CREATE TABLE "ops"."network_ranges_meta" (
	"source_commit" text PRIMARY KEY NOT NULL,
	"rows" integer NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."opportunistic_runs" (
	"name" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."quota_counters" (
	"day" date NOT NULL,
	"name" text NOT NULL,
	"priority" text NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "quota_counters_day_name_priority_pk" PRIMARY KEY("day","name","priority"),
	CONSTRAINT "quota_counters_priority_check" CHECK ("ops"."quota_counters"."priority" in ('critical', 'high', 'normal', 'low'))
);
--> statement-breakpoint
CREATE TABLE "ops"."rate_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."spend_counters" (
	"day" date NOT NULL,
	"scope" text NOT NULL,
	"cap_amount_micros" "app"."amount_micros" NOT NULL,
	"cap_currency" "app"."currency_code" NOT NULL,
	"used_amount_micros" "app"."amount_micros" NOT NULL,
	"used_currency" "app"."currency_code" NOT NULL,
	CONSTRAINT "spend_counters_day_scope_pk" PRIMARY KEY("day","scope")
);
--> statement-breakpoint
CREATE TABLE "ops"."spend_ledger" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"day" date NOT NULL,
	"provider" text NOT NULL,
	"channel" text,
	"engine" text,
	"purpose" text NOT NULL,
	"pool" text,
	"scopes" text[] NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text NOT NULL,
	"reserved_amount_micros" "app"."amount_micros" NOT NULL,
	"reserved_currency" "app"."currency_code" NOT NULL,
	"actual_amount_micros" "app"."amount_micros" DEFAULT 0 NOT NULL,
	"actual_currency" "app"."currency_code" NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "spend_ledger_status_check" CHECK ("ops"."spend_ledger"."status" in ('reserved', 'settled', 'released'))
);
--> statement-breakpoint
CREATE TABLE "ops"."velocity_baselines" (
	"key" text PRIMARY KEY NOT NULL,
	"computed_on" date NOT NULL,
	"p95_count_10m" integer NOT NULL,
	"p95_spend_10m_amount_micros" "app"."amount_micros" NOT NULL,
	"p95_spend_10m_currency" "app"."currency_code" NOT NULL,
	"p95_spend_60m_amount_micros" "app"."amount_micros" NOT NULL,
	"p95_spend_60m_currency" "app"."currency_code" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ops"."velocity_buckets" (
	"key" text NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"flagged" integer DEFAULT 0 NOT NULL,
	"spend_amount_micros" "app"."amount_micros" NOT NULL,
	"spend_currency" "app"."currency_code" NOT NULL,
	CONSTRAINT "velocity_buckets_key_bucket_start_pk" PRIMARY KEY("key","bucket_start")
);
--> statement-breakpoint
CREATE TABLE "ops"."workflow_starts" (
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"run_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_starts_kind_key_pk" PRIMARY KEY("kind","key"),
	CONSTRAINT "workflow_starts_status_check" CHECK ("ops"."workflow_starts"."status" in ('pending', 'started'))
);
--> statement-breakpoint
CREATE INDEX "concurrency_leases_key_expires_at_idx" ON "ops"."concurrency_leases" USING btree ("key","expires_at");--> statement-breakpoint
CREATE INDEX "network_ranges_prefix_gist_idx" ON "ops"."network_ranges" USING gist ("prefix" inet_ops);--> statement-breakpoint
CREATE INDEX "spend_ledger_ref_type_ref_id_idx" ON "ops"."spend_ledger" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "spend_ledger_day_provider_idx" ON "ops"."spend_ledger" USING btree ("day","provider");--> statement-breakpoint
CREATE INDEX "spend_ledger_reserved_day_created_at_idx" ON "ops"."spend_ledger" USING btree ("day","created_at") WHERE "ops"."spend_ledger"."status" = 'reserved';