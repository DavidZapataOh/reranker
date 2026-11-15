CREATE TABLE "ops"."alert_deliveries" (
	"kind" text NOT NULL,
	"bucket_hour" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_deliveries_kind_bucket_hour_pk" PRIMARY KEY("kind","bucket_hour")
);
