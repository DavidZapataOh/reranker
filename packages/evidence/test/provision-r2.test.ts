import { expect, test } from "vitest";
import {
  BUCKETS,
  type BucketSpec,
  type CorsRule,
  cloudflare,
  MIN_TLS,
  mismatches,
  observe,
  PUBLIC_CORS,
  provision,
  waitForDomains,
} from "../scripts/provision-r2";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ZONE = "fedcba9876543210fedcba9876543210";
const TOKEN = "unit-token";
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets`;

interface FakeDomain {
  domain: string;
  enabled: boolean;
  zoneId: string;
  minTLS?: string;
  status: { ownership: string; ssl: string };
}

interface FakeBucket {
  location: string;
  r2dev: boolean;
  domains: FakeDomain[];
  cors: CorsRule[] | null;
}

/** An in-memory R2 control plane that answers the routes the script uses, as Cloudflare does. */
function fakeCloudflare(seed: Record<string, Partial<FakeBucket>> = {}) {
  const buckets = new Map<string, FakeBucket>(
    Object.entries(seed).map(([name, b]) => [
      name,
      { location: "ENAM", r2dev: false, domains: [], cors: null, ...b },
    ]),
  );
  const writes: string[] = [];
  const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
  const missing = (code: number, message: string) =>
    Response.json({ success: false, errors: [{ code, message }], result: null }, { status: 404 });

  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const [name, ...rest] = url.slice(BASE.length).split("/").filter(Boolean);
    const route = rest.join("/");
    if (method !== "GET") writes.push(`${method} ${name ?? ""}/${route}`.replace(/\/$/, ""));

    if (!name && method === "POST") {
      buckets.set(body.name, {
        location: body.locationHint.toUpperCase(),
        r2dev: false,
        domains: [],
        cors: null,
      });
      return ok({ name: body.name });
    }
    const bucket = name ? buckets.get(name) : undefined;
    if (!bucket) return missing(10006, "The specified bucket does not exist.");

    if (route === "" && method === "GET") return ok({ name, location: bucket.location });
    if (route === "domains/managed") {
      if (method === "PUT") bucket.r2dev = body.enabled;
      return ok({ bucketId: "b", domain: `pub-b.r2.dev`, enabled: bucket.r2dev });
    }
    if (route === "domains/custom" && method === "GET") return ok({ domains: bucket.domains });
    if (route === "domains/custom" && method === "POST") {
      bucket.domains.push({ ...body, status: { ownership: "pending", ssl: "initializing" } });
      return ok(body);
    }
    if (route.startsWith("domains/custom/")) {
      const domain = route.slice("domains/custom/".length);
      const found = bucket.domains.find((d) => d.domain === domain);
      if (!found) return missing(10102, "Domain not found");
      if (method === "DELETE") bucket.domains = bucket.domains.filter((d) => d !== found);
      if (method === "PUT") Object.assign(found, body);
      return ok({ domain });
    }
    if (route === "cors") {
      if (method === "PUT") bucket.cors = body.rules;
      if (method === "DELETE") bucket.cors = null;
      if (method === "GET" && bucket.cors === null) {
        return missing(10059, "The CORS configuration does not exist.");
      }
      return ok(method === "GET" ? { rules: bucket.cors } : null);
    }
    throw new Error(`Unexpected ${method} ${url}`);
  }) as typeof fetch;

  const activate = () => {
    for (const bucket of buckets.values()) {
      for (const d of bucket.domains) d.status = { ownership: "active", ssl: "active" };
    }
  };
  return { buckets, writes, activate, call: cloudflare(TOKEN, ACCOUNT, fetcher) };
}

test("an empty account gets the six buckets, their domains and nothing public besides", async () => {
  const cf = fakeCloudflare();
  await provision(cf.call, { zoneId: ZONE });

  expect([...cf.buckets.keys()].sort()).toEqual(BUCKETS.map((b) => b.name).sort());
  for (const { name, domain } of BUCKETS) {
    const bucket = cf.buckets.get(name);
    expect(bucket?.location).toBe("ENAM");
    expect(bucket?.r2dev).toBe(false);
    expect(bucket?.domains.map(({ status: _, ...d }) => d)).toEqual(
      domain ? [{ domain, zoneId: ZONE, enabled: true, minTLS: MIN_TLS }] : [],
    );
    expect(bucket?.cors).toEqual(domain ? PUBLIC_CORS : null);
  }

  cf.activate();
  expect(mismatches(await observe(cf.call))).toEqual([]);
});

test("a second run changes nothing", async () => {
  const cf = fakeCloudflare();
  await provision(cf.call, { zoneId: ZONE });
  const before = cf.writes.length;

  const changes = await provision(cf.call, { zoneId: ZONE });

  expect(cf.writes.length).toBe(before);
  expect([...changes.values()].flat()).toEqual([]);
});

test("drift is corrected: r2.dev, weak TLS, a disabled domain, stray domains and CORS", async () => {
  const cors = [{ allowed: { origins: ["https://evil.example"], methods: ["GET"] } }];
  const domain = (name: string, extra: Partial<FakeDomain> = {}): FakeDomain => ({
    domain: name,
    enabled: true,
    zoneId: ZONE,
    minTLS: MIN_TLS,
    status: { ownership: "active", ssl: "active" },
    ...extra,
  });
  const cf = fakeCloudflare({
    "rr-evidence-production": {
      r2dev: true,
      domains: [domain("ev.reranker.co", { minTLS: "1.0" })],
      cors,
    },
    "rr-log-production": { domains: [domain("log.reranker.co", { enabled: false })] },
    "rr-internal-production": { domains: [domain("internal.reranker.co")], cors },
  });

  const changes = await provision(cf.call, { zoneId: ZONE });

  expect(changes.get("rr-evidence-production")).toEqual([
    "disable r2.dev",
    `enable ev.reranker.co with TLS ${MIN_TLS}`,
    "set CORS",
  ]);
  expect(changes.get("rr-log-production")).toEqual([
    `enable log.reranker.co with TLS ${MIN_TLS}`,
    "set CORS",
  ]);
  expect(changes.get("rr-internal-production")).toEqual([
    "remove undeclared domain internal.reranker.co",
    "remove CORS",
  ]);
  cf.activate();
  expect(mismatches(await observe(cf.call))).toEqual([]);
});

test("a dry run reports every change and writes nothing", async () => {
  const cf = fakeCloudflare({ "rr-evidence-preview": { r2dev: true } });

  const changes = await provision(cf.call, { zoneId: ZONE, dryRun: true });

  expect(cf.writes).toEqual([]);
  expect(changes.get("rr-evidence-preview")).toEqual([
    "would disable r2.dev",
    "would attach ev-preview.reranker.co",
    "would set CORS",
  ]);
  expect(changes.get("rr-internal-preview")).toEqual([
    "would create bucket in enam",
    "would disable r2.dev",
  ]);
});

test("a Cloudflare error stops the run with its code and message, never the token", async () => {
  const fetcher = (async () =>
    Response.json(
      { success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null },
      { status: 403 },
    )) as unknown as typeof fetch;
  const run = provision(cloudflare(TOKEN, ACCOUNT, fetcher), { zoneId: ZONE });

  await expect(run).rejects.toThrow(/HTTP 403 \(10000 Authentication error\)/);
  await expect(run).rejects.not.toThrow(new RegExp(TOKEN));
});

test("a write to something missing is an error, not an absence", async () => {
  const cf = fakeCloudflare();
  await expect(cf.call("PUT", "/rr-ghost/domains/managed", { enabled: false })).rejects.toThrow(
    /HTTP 404 \(10006/,
  );
});

test("the report names every declared state that does not hold", () => {
  const specs: BucketSpec[] = [
    { name: "public", domain: "pub.reranker.co" },
    { name: "private" },
    { name: "absent" },
  ];
  const problems = mismatches(
    [
      {
        bucket: "public",
        exists: true,
        location: "ENAM",
        r2dev: true,
        domains: [
          {
            domain: "pub.reranker.co",
            enabled: false,
            minTLS: "1.0",
            ownership: "active",
            ssl: "pending",
          },
        ],
        cors: "",
      },
      {
        bucket: "private",
        exists: true,
        location: "ENAM",
        r2dev: false,
        domains: [],
        cors: "GET from *",
      },
    ],
    specs,
  );
  expect(problems).toEqual([
    "public: r2.dev is enabled",
    "public: pub.reranker.co is disabled",
    "public: pub.reranker.co accepts TLS 1.0",
    "public: pub.reranker.co ownership active, certificate pending",
    'public: CORS "" missing',
    'private: CORS "GET from *" on a private bucket',
    "absent: does not exist",
  ]);
});

test("the run waits for new domains to get their certificate, and gives up at the deadline", async () => {
  const cf = fakeCloudflare();
  await provision(cf.call, { zoneId: ZONE });

  let polls = 0;
  const counting: typeof cf.call = async (method, path, body) => {
    if (path.endsWith("/domains/custom")) polls++;
    if (polls === 12) cf.activate();
    return cf.call(method, path, body);
  };
  const states = await waitForDomains(counting, { intervalMs: 1 });
  expect(mismatches(states)).toEqual([]);
  expect(polls).toBeGreaterThan(6);

  const stuck = fakeCloudflare();
  await provision(stuck.call, { zoneId: ZONE });
  const pending = await waitForDomains(stuck.call, { timeoutMs: 5, intervalMs: 1 });
  expect(mismatches(pending)).toContain(
    "rr-evidence-production: ev.reranker.co ownership pending, certificate initializing",
  );
});
