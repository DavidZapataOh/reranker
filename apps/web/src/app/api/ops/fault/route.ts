import { log, requestIdFrom, runAfter } from "@reranker/telemetry";
import { opsGuard } from "../../../../lib/ops-guard";

// Each kind exercises one capture path end to end: Next's onRequestError, work after the
// response, redaction of personal data, and the log pipeline.
export async function GET(req: Request): Promise<Response> {
  const denied = opsGuard(req);
  if (denied) return denied;

  const kind = new URL(req.url).searchParams.get("kind");
  switch (kind) {
    case "handler":
      throw new Error("ops fault: handler");
    case "pii":
      throw new Error("ops fault: ana.prueba@reranker.co +57 310 555 1234");
    case "after":
      runAfter(async () => {
        throw new Error("ops fault: after");
      });
      return new Response(null, { status: 202 });
    case "log":
      log.info("ops fault: log", { request_id: requestIdFrom(req.headers) });
      return new Response(null, { status: 200 });
    default:
      return Response.json({ error: "kind must be handler, after, pii or log" }, { status: 400 });
  }
}
