CREATE TABLE "public_panel"."evidence_tree_hashes" (
	"stored_index" bigint NOT NULL,
	"origin" text NOT NULL,
	"hash" "bytea" NOT NULL,
	CONSTRAINT "evidence_tree_hashes_origin_stored_index_pk" PRIMARY KEY("origin","stored_index"),
	CONSTRAINT "evidence_tree_hashes_stored_index_check" CHECK ("public_panel"."evidence_tree_hashes"."stored_index" >= 0),
	CONSTRAINT "evidence_tree_hashes_hash_length" CHECK (octet_length("public_panel"."evidence_tree_hashes"."hash") = 32)
);
--> statement-breakpoint
-- Hashes of the append-only log: written once by integration, never rewritten or removed.
create trigger evidence_tree_hashes_guard
  before update or delete on public_panel.evidence_tree_hashes
  for each row execute function public_panel.evidence_append_only_guard();
