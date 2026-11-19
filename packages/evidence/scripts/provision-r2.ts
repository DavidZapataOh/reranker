import { setTimeout as sleep } from "node:timers/promises";

export interface BucketSpec {
  name: string;
  /** Public custom domain; a bucket without one is never reachable outside the S3 API. */
  domain?: string;
}

export const BUCKETS: readonly BucketSpec[] = [
  { name: "rr-evidence-production", domain: "ev.reranker.co" },
  { name: "rr-log-production", domain: "log.reranker.co" },
  { name: "rr-internal-production" },
  { name: "rr-evidence-preview", domain: "ev-preview.reranker.co" },
  { name: "rr-log-preview", domain: "log-preview.reranker.co" },
  { name: "rr-internal-preview" },
];

export interface CorsRule {
  allowed: { origins: string[]; methods: string[]; headers?: string[] };
  exposeHeaders?: string[];
  maxAgeSeconds?: number;
}

// The verifier fetches artifacts and tiles from the browser, on reranker.co and on any page that
// checks a capture without us. The objects are public and the requests carry no credentials.
export const PUBLIC_CORS: readonly CorsRule[] = [
  { allowed: { origins: ["*"], methods: ["GET", "HEAD"] }, maxAgeSeconds: 86_400 },
];

export const MIN_TLS = "1.2";
// The functions that write the buckets run in iad1.
export const LOCATION_HINT = "enam";

const API = "https://api.cloudflare.com/client/v4";

interface Envelope {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: unknown;
}

export interface Reply {
  status: number;
  result: unknown;
}

export type Call = (method: string, path: string, body?: unknown) => Promise<Reply>;

export class CloudflareError extends Error {
  readonly status: number;
  constructor(method: string, path: string, status: number, envelope: Envelope | undefined) {
    const detail = envelope?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ?? "";
    super(`${method} ${path}: HTTP ${status}${detail ? ` (${detail})` : ""}`);
    this.status = status;
  }
}

/** A client for the account's R2 buckets; paths are relative to /accounts/{id}/r2/buckets. */
export function cloudflare(token: string, accountId: string, fetcher: typeof fetch = fetch): Call {
  const base = `${API}/accounts/${accountId}/r2/buckets`;
  return async (method, path, body) => {
    const response = await fetcher(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const envelope = (await response.json().catch(() => undefined)) as Envelope | undefined;
    // A read of something absent is an answer; a write to it is an error.
    if (response.status === 404 && method === "GET") return { status: 404, result: null };
    if (!response.ok || envelope?.success !== true) {
      throw new CloudflareError(method, path, response.status, envelope);
    }
    return { status: response.status, result: envelope.result };
  };
}

interface CustomDomain {
  domain: string;
  enabled: boolean;
  minTLS?: string;
  zoneId?: string;
  status?: { ownership: string; ssl: string };
}

function normalizeCors(rules: readonly CorsRule[]): string {
  const sorted = (list: readonly string[] | undefined) => [...(list ?? [])].sort();
  return JSON.stringify(
    rules.map((rule) => ({
      origins: sorted(rule.allowed.origins),
      methods: sorted(rule.allowed.methods),
      headers: sorted(rule.allowed.headers),
      exposeHeaders: sorted(rule.exposeHeaders),
      maxAgeSeconds: rule.maxAgeSeconds ?? null,
    })),
  );
}

async function readCors(call: Call, bucket: string): Promise<CorsRule[]> {
  // R2 answers 404 when a bucket has no CORS policy.
  const { status, result } = await call("GET", `/${bucket}/cors`);
  return status === 404 ? [] : ((result as { rules?: CorsRule[] }).rules ?? []);
}

async function readDomains(call: Call, bucket: string): Promise<CustomDomain[]> {
  const { result } = await call("GET", `/${bucket}/domains/custom`);
  return (result as { domains: CustomDomain[] }).domains;
}

export interface ProvisionOptions {
  zoneId: string;
  dryRun?: boolean;
}

/**
 * Brings one bucket to its declared state and returns what changed. Anything undeclared is
 * drift: a stray domain on a private bucket would publish customer data.
 */
async function reconcile(call: Call, spec: BucketSpec, options: ProvisionOptions) {
  const changes: string[] = [];
  const apply = async (change: string, run: () => Promise<unknown>) => {
    changes.push(options.dryRun ? `would ${change}` : change);
    if (!options.dryRun) await run();
  };
  const { name, domain } = spec;

  const bucket = await call("GET", `/${name}`);
  if (bucket.status === 404) {
    await apply(`create bucket in ${LOCATION_HINT}`, () =>
      call("POST", "", { name, locationHint: LOCATION_HINT }),
    );
    // Nothing else can be read from a bucket a dry run did not create.
    if (options.dryRun) {
      if (domain) changes.push(`would attach ${domain}`, "would set CORS");
      changes.push("would disable r2.dev");
      return changes;
    }
  }

  const managed = (await call("GET", `/${name}/domains/managed`)).result as { enabled: boolean };
  if (managed.enabled) {
    await apply("disable r2.dev", () =>
      call("PUT", `/${name}/domains/managed`, { enabled: false }),
    );
  }

  const domains = await readDomains(call, name);
  for (const stray of domains.filter((d) => d.domain !== domain)) {
    await apply(`remove undeclared domain ${stray.domain}`, () =>
      call("DELETE", `/${name}/domains/custom/${stray.domain}`),
    );
  }
  if (domain) {
    const current = domains.find((d) => d.domain === domain);
    if (!current) {
      await apply(`attach ${domain}`, () =>
        call("POST", `/${name}/domains/custom`, {
          domain,
          zoneId: options.zoneId,
          enabled: true,
          minTLS: MIN_TLS,
        }),
      );
    } else if (!current.enabled || current.minTLS !== MIN_TLS) {
      await apply(`enable ${domain} with TLS ${MIN_TLS}`, () =>
        call("PUT", `/${name}/domains/custom/${domain}`, { enabled: true, minTLS: MIN_TLS }),
      );
    }
  }

  const desired = domain ? PUBLIC_CORS : [];
  if (normalizeCors(await readCors(call, name)) !== normalizeCors(desired)) {
    await apply(desired.length > 0 ? "set CORS" : "remove CORS", () =>
      desired.length > 0
        ? call("PUT", `/${name}/cors`, { rules: desired })
        : call("DELETE", `/${name}/cors`),
    );
  }
  return changes;
}

export async function provision(
  call: Call,
  options: ProvisionOptions,
  buckets: readonly BucketSpec[] = BUCKETS,
): Promise<Map<string, string[]>> {
  const changes = await Promise.all(buckets.map((spec) => reconcile(call, spec, options)));
  return new Map(buckets.map((spec, i) => [spec.name, changes[i] ?? []]));
}

export interface BucketState {
  bucket: string;
  exists: boolean;
  location: string | null;
  r2dev: boolean;
  domains: { domain: string; enabled: boolean; minTLS: string; ownership: string; ssl: string }[];
  cors: string;
}

export async function observe(
  call: Call,
  buckets: readonly BucketSpec[] = BUCKETS,
): Promise<BucketState[]> {
  return Promise.all(
    buckets.map(async ({ name }): Promise<BucketState> => {
      const bucket = await call("GET", `/${name}`);
      if (bucket.status === 404) {
        return { bucket: name, exists: false, location: null, r2dev: false, domains: [], cors: "" };
      }
      const [managed, domains, cors] = await Promise.all([
        call("GET", `/${name}/domains/managed`),
        readDomains(call, name),
        readCors(call, name),
      ]);
      return {
        bucket: name,
        exists: true,
        location: (bucket.result as { location?: string } | null)?.location ?? null,
        r2dev: (managed.result as { enabled: boolean }).enabled,
        domains: domains.map((d) => ({
          domain: d.domain,
          enabled: d.enabled,
          minTLS: d.minTLS ?? "1.0",
          ownership: d.status?.ownership ?? "unknown",
          ssl: d.status?.ssl ?? "unknown",
        })),
        cors: cors
          .map((rule) => `${rule.allowed.methods.join(",")} from ${rule.allowed.origins.join(",")}`)
          .join("; "),
      };
    }),
  );
}

/** Lists every way the observed state differs from the declared one; empty means converged. */
export function mismatches(
  states: readonly BucketState[],
  buckets: readonly BucketSpec[] = BUCKETS,
): string[] {
  return buckets.flatMap(({ name, domain }) => {
    const state = states.find((s) => s.bucket === name);
    if (!state?.exists) return [`${name}: does not exist`];
    const problems: string[] = [];
    if (state.r2dev) problems.push(`${name}: r2.dev is enabled`);
    const expected = domain ? [domain] : [];
    const actual = state.domains.map((d) => d.domain);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(
        `${name}: domains ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
      );
    }
    for (const d of state.domains.filter((d) => d.domain === domain)) {
      if (!d.enabled) problems.push(`${name}: ${d.domain} is disabled`);
      if (d.minTLS !== MIN_TLS) problems.push(`${name}: ${d.domain} accepts TLS ${d.minTLS}`);
      if (d.ownership !== "active" || d.ssl !== "active") {
        problems.push(`${name}: ${d.domain} ownership ${d.ownership}, certificate ${d.ssl}`);
      }
    }
    if ((state.cors !== "") !== Boolean(domain)) {
      problems.push(`${name}: CORS "${state.cors}" ${domain ? "missing" : "on a private bucket"}`);
    }
    return problems;
  });
}

const SETTLING = new Set(["pending", "initializing"]);

/** A new custom domain needs its DNS record and certificate issued before it serves. */
export async function waitForDomains(
  call: Call,
  { timeoutMs = 10 * 60_000, intervalMs = 10_000 } = {},
  buckets: readonly BucketSpec[] = BUCKETS,
): Promise<BucketState[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const states = await observe(call, buckets);
    const settling = states.some((s) =>
      s.domains.some((d) => SETTLING.has(d.ownership) || SETTLING.has(d.ssl)),
    );
    if (!settling || Date.now() >= deadline) return states;
    await sleep(intervalMs);
  }
}

function table(states: readonly BucketState[]): string {
  const rows = states.map((s) => {
    const domains =
      s.domains
        .map((d) => `${d.domain} (${d.enabled ? "on" : "off"}, TLS ≥ ${d.minTLS}, ${d.ssl})`)
        .join(", ") || "none";
    return `| ${s.bucket} | ${s.location ?? "?"} | ${s.r2dev ? "on" : "off"} | ${domains} | ${s.cors || "none"} |`;
  });
  return [
    "| Bucket | Location | r2.dev | Custom domain | CORS |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const call = cloudflare(requireEnv("CLOUDFLARE_API_TOKEN"), requireEnv("CLOUDFLARE_ACCOUNT_ID"));
  const changes = await provision(call, { zoneId: requireEnv("CLOUDFLARE_ZONE_ID"), dryRun });
  for (const [bucket, list] of changes) {
    console.log(`${bucket}: ${list.length > 0 ? list.join(", ") : "unchanged"}`);
  }
  if (dryRun) return;

  const states = await waitForDomains(call);
  const report = table(states);
  console.log(`\n${report}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## R2 buckets\n\n${report}\n`);
  }
  const problems = mismatches(states);
  for (const problem of problems) console.log(`::error::${problem}`);
  if (problems.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
