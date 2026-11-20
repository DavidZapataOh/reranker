import { LOG_ORIGIN } from "@reranker/verify/format";
import { noteVerifierKey, TRUSTED_KEYS } from "@reranker/verify/trust";

export const dynamic = "force-static";

/**
 * The c2sp.org/signed-note verifier keys of the production log, one per line, ready for
 * `golang.org/x/mod/sumdb/note` or any checkpoint client. The log signs under its origin, so the
 * origin is the key name.
 */
export function GET(): Response {
  const vkeys = TRUSTED_KEYS.filter((key) => key.purpose === "log").map((key) =>
    noteVerifierKey(LOG_ORIGIN, Uint8Array.from(Buffer.from(key.publicKey, "base64"))),
  );
  return new Response(vkeys.map((vkey) => `${vkey}\n`).join(""), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300, s-maxage=3600",
    },
  });
}
