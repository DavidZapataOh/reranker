ALTER TYPE "public_panel"."estimate_metric" ADD VALUE 'site_citation_rate' AFTER 'names_entities_rate';--> statement-breakpoint
ALTER TYPE "public_panel"."estimate_metric" ADD VALUE 'citation_rate' AFTER 'site_citation_rate';--> statement-breakpoint
ALTER TYPE "public_panel"."estimate_metric" ADD VALUE 'competitor_citation_rate' AFTER 'citation_rate';
