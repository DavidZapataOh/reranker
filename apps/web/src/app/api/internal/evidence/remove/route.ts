import { EvidenceStorageUnavailableError, removeArtifact } from "@reranker/evidence";
import { InvalidInputError } from "@reranker/jobs";
import { z } from "@reranker/schema";
import { hasCronBearer } from "../../../../../lib/ops-guard";

const Removal = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  kind: z.enum(["raw", "normalized", "extractions"]),
  reason: z.enum(["personal_data_request", "legal_order"]),
});

const empty = (status: number) => new Response(null, { status });

/**
 * Takes one evidence artifact down: `{ sha256, kind, reason }` in, `{ ..., created }` out, where
 * `created: false` means it was already removed. It runs here, where the R2 keys, the purge token
 * and the database credentials already live, so an operator never holds them; the
 * `evidence-removal` workflow calls it with the cron bearer.
 */
export async function POST(req: Request): Promise<Response> {
  if (!hasCronBearer(req)) return empty(401);
  const parsed = Removal.safeParse(await req.json().catch(() => undefined));
  if (!parsed.success) return empty(400);
  const { sha256, kind, reason } = parsed.data;

  try {
    const { created } = await removeArtifact(sha256, kind, reason);
    return Response.json(
      { sha256, kind, reason, created },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof InvalidInputError) return empty(400);
    if (error instanceof EvidenceStorageUnavailableError) return empty(503);
    throw error;
  }
}
