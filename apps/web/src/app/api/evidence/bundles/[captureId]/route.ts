import { buildBundle, getSealSummaries } from "@reranker/evidence";
import { AppError } from "@reranker/schema";
import { BUNDLE_MEDIA_TYPE, isCaptureId } from "@reranker/verify/format";
import { problemResponse } from "../../../../../lib/problem";

// Integration runs at most once a minute, so a signed capture is worth asking for again then.
const UNLOGGED_RETRY_SECONDS = 60;
// The latest checkpoint moves every minute; once Bitcoin dates the bundle's own checkpoint, only
// that tail changes and it can be served longer.
const CACHE = "public, s-maxage=60, stale-while-revalidate=86400";
const CONFIRMED_CACHE = "public, s-maxage=3600, stale-while-revalidate=86400";

/** The public verification bundle of a capture, for anyone to check it offline. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ captureId: string }> },
): Promise<Response> {
  const { captureId } = await params;
  try {
    if (!isCaptureId(captureId)) throw new AppError("evidence_not_found");
    const bundle = await buildBundle(captureId);
    if (bundle === null) {
      const signed = (await getSealSummaries([captureId])).length > 0;
      const response = await problemResponse(new AppError("evidence_not_found"), req);
      if (signed) response.headers.set("Retry-After", String(UNLOGGED_RETRY_SECONDS));
      return response;
    }
    return new Response(JSON.stringify(bundle), {
      headers: {
        "Content-Type": BUNDLE_MEDIA_TYPE,
        "Cache-Control": bundle.anchors.ots?.status === "confirmed" ? CONFIRMED_CACHE : CACHE,
      },
    });
  } catch (error) {
    return problemResponse(error, req);
  }
}
