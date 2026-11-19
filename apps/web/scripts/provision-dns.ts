export interface DnsRecord {
  type: "CNAME";
  name: string;
  content: string;
  /** Vercel only issues a certificate for a hostname Cloudflare does not proxy. */
  proxied: false;
}

// Hostnames of reranker.co served by the web project besides the apex and www. The target is the
// project's own CNAME, the one Vercel ranks first for its domains (`/v6/domains/{name}/config`).
export const RECORDS: readonly DnsRecord[] = [
  {
    type: "CNAME",
    name: "tienda-ejemplo.reranker.co",
    content: "e859a30f0d01fbc4.vercel-dns-017.com",
    proxied: false,
  },
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

/** Brings each declared record to its state and returns what changed, one line per record. */
export async function provision(
  call: Call,
  records: readonly DnsRecord[] = RECORDS,
  dryRun = false,
): Promise<string[]> {
  const report: string[] = [];
  for (const record of records) {
    const query = new URLSearchParams({ name: record.name });
    const [existing, ...extra] = await call<ExistingRecord[]>("GET", `?${query}`);
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
