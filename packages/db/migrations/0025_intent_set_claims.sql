CREATE TABLE "public_panel"."intent_set_claims" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"key" text NOT NULL,
	CONSTRAINT "intent_set_claims_key_key" UNIQUE("key")
);
