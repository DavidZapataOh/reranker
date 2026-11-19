import { getEvidenceEnv } from "../env";
import { readCapped } from "./ots";

// RFC 3161 Time-Stamp Protocol over HTTP (§3.4): the DER TimeStampReq is POSTed as
// application/timestamp-query and the TimeStampResp comes back whole; it is stored as is, so any
// verifier can run `openssl ts -verify` on it.

const TIMEOUT_MS = 10_000;
// A token carries the TSA certificate chain; the column holding it allows 10,240 bytes.
const MAX_RESPONSE_BYTES = 10_240;

// AlgorithmIdentifier { id-sha256 (2.16.840.1.101.3.4.2.1), NULL }.
const SHA256_ALGORITHM = [
  0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00,
];
const CERT_REQ_TRUE = [0x01, 0x01, 0xff];
const VERSION_1 = [0x02, 0x01, 0x01];

// The qtsa.eu endpoint is bought per environment, so only production stamps there.
export const TSAS: Record<"qtsa" | "digicert", { url: () => string | null }> = {
  qtsa: { url: () => getEvidenceEnv().QTSA_TSA_URL ?? null },
  // DigiCert publishes its TSA over plain HTTP only; the token is signed, so transport adds nothing.
  digicert: { url: () => "http://timestamp.digicert.com" },
};

export type TsaName = keyof typeof TSAS;

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return [0x80 | bytes.length, ...bytes];
}

const der = (tag: number, content: number[]) => [tag, ...derLength(content.length), ...content];

/** DER INTEGER of a positive value: minimal big-endian two's complement. */
export function derInteger(value: bigint): Uint8Array {
  if (value <= 0n) throw new RangeError("nonce must be positive");
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const content = [...Buffer.from(hex, "hex")];
  if ((content[0] ?? 0) & 0x80) content.unshift(0);
  return new Uint8Array(der(0x02, content));
}

/** The DER TimeStampReq of RFC 3161 §2.4.1 for a SHA-256 digest, asking for the TSA certificate. */
export function buildTimeStampReq(digest: Uint8Array, opts: { nonce?: bigint } = {}): Uint8Array {
  if (digest.length !== 32) throw new RangeError("a SHA-256 digest is 32 bytes");
  const imprint = der(0x30, [...SHA256_ALGORITHM, ...der(0x04, [...digest])]);
  const nonce = opts.nonce === undefined ? [] : [...derInteger(opts.nonce)];
  return new Uint8Array(der(0x30, [...VERSION_1, ...imprint, ...nonce, ...CERT_REQ_TRUE]));
}

function readTlv(bytes: Uint8Array, offset: number): { tag: number; start: number; end: number } {
  const tag = bytes[offset];
  const first = bytes[offset + 1];
  if (tag === undefined || first === undefined) throw new TypeError("truncated DER");
  let start = offset + 2;
  let length = first;
  if (first & 0x80) {
    const count = first & 0x7f;
    if (count === 0 || count > 4) throw new TypeError("unsupported DER length");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + (bytes[start + i] ?? Number.NaN);
    start += count;
  }
  const end = start + length;
  if (!Number.isSafeInteger(end) || end > bytes.length) throw new TypeError("truncated DER");
  return { tag, start, end };
}

/**
 * The PKIStatus of a TimeStampResp (§2.4.2). Granted means status 0 or 1 with a token attached;
 * anything else is a refusal whose bytes are no proof.
 */
export function parseTimeStampResp(bytes: Uint8Array): {
  status: 0 | 1 | 2 | 3 | 4 | 5;
  granted: boolean;
} {
  const resp = readTlv(bytes, 0);
  if (resp.tag !== 0x30 || resp.end !== bytes.length) throw new TypeError("not a TimeStampResp");
  const info = readTlv(bytes, resp.start);
  const status = readTlv(bytes, info.start);
  if (info.tag !== 0x30 || status.tag !== 0x02 || status.end - status.start !== 1) {
    throw new TypeError("malformed PKIStatusInfo");
  }
  const value = bytes[status.start] ?? -1;
  if (value < 0 || value > 5) throw new TypeError(`unknown PKIStatus ${value}`);
  const hasToken = info.end < resp.end && bytes[info.end] === 0x30;
  return { status: value as 0 | 1 | 2 | 3 | 4 | 5, granted: value <= 1 && hasToken };
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  return Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength).includes(needle);
}

/** Credentials in the URL travel as Basic auth: fetch refuses a URL that carries them. */
function endpoint(url: string): { href: string; headers: Record<string, string> } {
  const u = new URL(url);
  const headers: Record<string, string> = { "Content-Type": "application/timestamp-query" };
  if (u.username || u.password) {
    const user = decodeURIComponent(u.username);
    const pass = decodeURIComponent(u.password);
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
    u.username = "";
    u.password = "";
  }
  return { href: u.href, headers };
}

function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return BigInt(`0x${Buffer.from(bytes).toString("hex")}`) | 1n;
}

/**
 * Asks the TSA at `url` to stamp `digest` and returns its whole TimeStampResp. A refusal, a reply
 * for another digest or nonce, or a TSA silent for 10 s throws.
 */
export async function requestTimestamp(
  url: string,
  digest: Uint8Array,
  opts: { fetch?: typeof fetch; nonce?: bigint } = {},
): Promise<Uint8Array> {
  const nonce = opts.nonce ?? randomNonce();
  const { href, headers } = endpoint(url);
  const response = await (opts.fetch ?? fetch)(href, {
    method: "POST",
    headers,
    body: buildTimeStampReq(digest, { nonce }).slice(),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error(`TSA answered ${response.status}`);
  }
  const bytes = await readCapped(response, MAX_RESPONSE_BYTES);
  const { status, granted } = parseTimeStampResp(bytes);
  if (!granted) throw new Error(`TSA refused the request with PKIStatus ${status}`);
  // TSTInfo repeats the imprint and the nonce; a reply without them answers another request.
  const imprint = new Uint8Array([0x04, 0x20, ...digest]);
  if (!contains(bytes, imprint) || !contains(bytes, derInteger(nonce))) {
    throw new Error("TSA reply does not carry the requested digest and nonce");
  }
  return bytes;
}
