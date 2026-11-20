export interface DnsRecord {
  type: "CNAME" | "TXT";
  name: string;
  content: string;
  /** Vercel only issues a certificate for a hostname Cloudflare does not proxy. */
  proxied: false;
}

const KEYS_NAME = "_rr-keys.reranker.co";
// One quoted character-string per record, as Cloudflare stores TXT content.
const keyRecord = (keyid: string, publicKey: string): DnsRecord => ({
  type: "TXT",
  name: KEYS_NAME,
  content: `"${keyid}=${publicKey}"`,
  proxied: false,
});

// The production signing keys pinned in @reranker/verify, published so a verifier can compare the
// registry, the JWKS and DNS. A test keeps this list equal to TRUSTED_KEYS.
export const KEY_RECORDS: readonly DnsRecord[] = [
  keyRecord("rr-capture-2026-1-ed25519", "VzQD8iJrsOuZiQx6CR0FTQVg9PsVS4gKgkv/5jgBrjI="),
  keyRecord("rr-log-2026-1", "0FtErI6+DHMnnvQmyylWOUiWwLLBeO7XT5MZpXw2e8A="),
];

// Hostnames of reranker.co served by the web project besides the apex and www. The target is the
// project's own CNAME, the one Vercel ranks first for its domains (`/v6/domains/{name}/config`).
export const RECORDS: readonly DnsRecord[] = [
  {
    type: "CNAME",
    name: "tienda-ejemplo.reranker.co",
    content: "e859a30f0d01fbc4.vercel-dns-017.com",
    proxied: false,
  },
  ...KEY_RECORDS,
];

const API = "https://api.cloudflare.com/client/v4";

interface Envelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}

interface ExistingRecord extends DnsRecord {
  id: string;
}

export type Call = <T>(method: string, path: string, body?: unknown) => Promise<T>;

/** A client for one zone's DNS records; paths are relative to /zones/{id}/dns_records. */
export function cloudflare(token: string, zoneId: string, fetcher: typeof fetch = fetch): Call {
  const base = `${API}/zones/${zoneId}/dns_records`;
  return async <T>(method: string, path: string, body?: unknown) => {
    const response = await fetcher(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const envelope = (await response.json().catch(() => undefined)) as Envelope<T> | undefined;
    if (!response.ok || envelope?.success !== true) {
      const detail = envelope?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ?? "";
      throw new Error(`${method} dns_records${path}: HTTP ${response.status} ${detail}`.trim());
    }
    return envelope.result;
  };
}

const recordsNamed = (call: Call, name: string) =>
  call<ExistingRecord[]>("GET", `?${new URLSearchParams({ name })}`);

/**
 * A TXT name that holds only declared values: missing ones are added and undeclared ones removed,
 * so a retired signing key stops being published with the next run.
 */
async function provisionTxtSet(
  call: Call,
  name: string,
  declared: readonly DnsRecord[],
  dryRun: boolean,
): Promise<string[]> {
  const existing = await recordsNamed(call, name);
  const foreign = existing.filter((r) => r.type !== "TXT");
  if (foreign.length > 0) throw new Error(`${name} also holds ${foreign[0]?.type} records`);
  const prefix = dryRun ? "would " : "";
  const report: string[] = [];
  for (const record of declared.filter((d) => !existing.some((e) => e.content === d.content))) {
    if (!dryRun) await call("POST", "", record);
    report.push(`${name}: ${prefix}create TXT ${record.content}`);
  }
  for (const stray of existing.filter((e) => !declared.some((d) => d.content === e.content))) {
    if (!dryRun) await call("DELETE", `/${stray.id}`);
    report.push(`${name}: ${prefix}remove TXT ${stray.content}`);
  }
  return report.length > 0 ? report : [`${name}: unchanged`];
}

/** Brings each declared record to its state and returns what changed, one line per record. */
export async function provision(
  call: Call,
  records: readonly DnsRecord[] = RECORDS,
  dryRun = false,
): Promise<string[]> {
  const report: string[] = [];
  const txtNames = new Set(records.filter((r) => r.type === "TXT").map((r) => r.name));
  for (const name of txtNames) {
    const declared = records.filter((r) => r.type === "TXT" && r.name === name);
    report.push(...(await provisionTxtSet(call, name, declared, dryRun)));
  }
  for (const record of records.filter((r) => r.type === "CNAME")) {
    const [existing, ...extra] = await recordsNamed(call, record.name);
    // A CNAME cannot share its name with any other record, so a second one is a conflict.
    if (extra.length > 0) throw new Error(`${record.name} has ${extra.length + 1} records`);
    const prefix = dryRun ? "would " : "";
    if (!existing) {
      if (!dryRun) await call("POST", "", record);
      report.push(`${record.name}: ${prefix}create ${record.type} ${record.content}`);
    } else if (
      existing.type !== record.type ||
      existing.content !== record.content ||
      existing.proxied !== record.proxied
    ) {
      if (!dryRun) await call("PATCH", `/${existing.id}`, record);
      report.push(`${record.name}: ${prefix}update to ${record.type} ${record.content}`);
    } else {
      report.push(`${record.name}: unchanged`);
    }
  }
  return report;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

if (import.meta.main) {
  const call = cloudflare(requireEnv("CLOUDFLARE_API_TOKEN"), requireEnv("CLOUDFLARE_ZONE_ID"));
  provision(call, RECORDS, process.argv.includes("--dry-run"))
    .then((lines) => {
      for (const line of lines) console.log(line);
    })
    .catch((error: unknown) => {
      console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
