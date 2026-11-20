import { withSystem } from "@reranker/db";
import { evidenceEntries } from "@reranker/db/schema";
import { appEnv } from "@reranker/env";
import { KEYS_BY_ENV, type TrustedKey } from "@reranker/verify/trust";
import { and, eq, inArray } from "drizzle-orm";
import { putArtifact } from "./artifacts";
import { signEnvelope } from "./dsse";
import { SigningKeyMismatchError } from "./errors";
import { ENVELOPE_CONTENT_TYPE, requestLogInclusion } from "./seal";
import { loadSigner, type Signer } from "./signer";
import { buildKeyAnnouncementStatement } from "./statement";

const isCurrent = (key: TrustedKey) => key.validTo === null && key.compromisedAfter === null;

/** The latest earlier key of the same purpose, which hands over to `key`. */
function predecessor(key: TrustedKey, keys: readonly TrustedKey[]): TrustedKey | null {
  const earlier = keys
    .filter((k) => k.purpose === key.purpose && Date.parse(k.validFrom) < Date.parse(key.validFrom))
    .sort((a, b) => Date.parse(b.validFrom) - Date.parse(a.validFrom));
  return earlier[0] ?? null;
}

/**
 * Appends a `key-announcement/v1` statement to the transparency log for every current key of this
 * environment not announced yet. Each one is signed by the announced key, by its predecessor and
 * by the log key, as `verifyKeyAnnouncement` requires; the log entry's ref is the keyid.
 */
export async function announceKeys(): Promise<{ announced: string[] }> {
  const keys = KEYS_BY_ENV[appEnv() === "production" ? "production" : "preview"];
  const current = keys.filter(isCurrent);
  if (current.length === 0) return { announced: [] };

  const logged = await withSystem(
    "evidence.announce_keys",
    (tx) =>
      tx
        .select({ ref: evidenceEntries.ref })
        .from(evidenceEntries)
        .where(
          and(
            eq(evidenceEntries.kind, "key"),
            inArray(
              evidenceEntries.ref,
              current.map((k) => k.keyid),
            ),
          ),
        ),
    { readOnly: true },
  );
  const pending = current.filter((key) => !logged.some((row) => row.ref === key.keyid));
  if (pending.length === 0) return { announced: [] };

  const loaded = await Promise.all([loadSigner("capture"), loadSigner("log")]);
  const signers = new Map<string, Signer>(loaded.map((signer) => [signer.keyid, signer]));
  const [, logSigner] = loaded;

  const announced: string[] = [];
  for (const key of pending) {
    const previous = predecessor(key, keys);
    const keyids = new Set([key.keyid, previous?.keyid, logSigner.keyid]);
    const needed = [...keyids].flatMap((keyid) => (keyid === undefined ? [] : [keyid]));
    const missing = needed.find((keyid) => !signers.has(keyid));
    if (missing !== undefined) {
      // Only current keys have a signer here; a predecessor signs during the rotation itself.
      throw new SigningKeyMismatchError(missing, `cannot sign the announcement of ${key.keyid}`);
    }
    const statement = buildKeyAnnouncementStatement({ key, previous, signedAt: new Date() });
    const { bytes, sha256 } = await signEnvelope(
      new TextEncoder().encode(JSON.stringify(statement)),
      needed.map((keyid) => signers.get(keyid) as Signer),
    );
    await putArtifact("envelopes", bytes, { contentType: ENVELOPE_CONTENT_TYPE });
    await withSystem("evidence.announce_keys", (tx) =>
      requestLogInclusion({ ref: key.keyid, kind: "key", envelopeSha256: sha256 }, { tx }),
    );
    announced.push(key.keyid);
  }
  return { announced };
}
