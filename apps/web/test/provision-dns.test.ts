import { TRUSTED_KEYS } from "@reranker/verify/trust";
import { expect, test, vi } from "vitest";
import {
  type Call,
  cloudflare,
  type DnsRecord,
  KEY_RECORDS,
  provision,
  RECORDS,
} from "../scripts/provision-dns";

const record: DnsRecord = {
  type: "CNAME",
  name: "tienda-ejemplo.reranker.co",
  content: "e859a30f0d01fbc4.vercel-dns-017.com",
  proxied: false,
};

function zone(existing: object[]) {
  const writes: [string, string, unknown][] = [];
  const call = (async (method: string, path: string, body?: unknown) => {
    if (method === "GET") return existing;
    writes.push([method, path, body]);
    return {};
  }) as Call;
  return { call, writes };
}

test("creates a missing record", async () => {
  const { call, writes } = zone([]);
  expect(await provision(call, [record])).toEqual([
    "tienda-ejemplo.reranker.co: create CNAME e859a30f0d01fbc4.vercel-dns-017.com",
  ]);
  expect(writes).toEqual([["POST", "", record]]);
});

test("updates a proxied or misdirected record in place", async () => {
  const { call, writes } = zone([{ ...record, id: "r1", proxied: true }]);
  await provision(call, [record]);
  expect(writes).toEqual([["PATCH", "/r1", record]]);
});

test("leaves a matching record alone, and a dry run writes nothing", async () => {
  const same = zone([{ ...record, id: "r1" }]);
  expect(await provision(same.call, [record])).toEqual(["tienda-ejemplo.reranker.co: unchanged"]);
  const missing = zone([]);
  expect(await provision(missing.call, [record], true)).toEqual([
    "tienda-ejemplo.reranker.co: would create CNAME e859a30f0d01fbc4.vercel-dns-017.com",
  ]);
  expect([...same.writes, ...missing.writes]).toEqual([]);
});

test("refuses a name that already holds several records", async () => {
  const { call } = zone([
    { ...record, id: "r1" },
    { ...record, id: "r2", type: "A" },
  ]);
  await expect(provision(call, [record])).rejects.toThrow("has 2 records");
});

test("the client sends the token and surfaces Cloudflare's errors without the token", async () => {
  const fetcher = vi.fn(async () =>
    Response.json(
      { success: false, errors: [{ code: 9109, message: "Invalid access token" }], result: null },
      { status: 403 },
    ),
  );
  const call = cloudflare("secret-token", "zone1", fetcher as unknown as typeof fetch);
  const failure = call("GET", "?name=a");
  await expect(failure).rejects.toThrow(
    "GET dns_records?name=a: HTTP 403 9109 Invalid access token",
  );
  await expect(failure).rejects.not.toThrow(/secret-token/);
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://api.cloudflare.com/client/v4/zones/zone1/dns_records?name=a");
  expect(init.headers).toMatchObject({ Authorization: "Bearer secret-token" });
});

const keys = [
  { type: "TXT", name: "_rr-keys.reranker.co", content: '"rr-capture-x=AAAA"', proxied: false },
  { type: "TXT", name: "_rr-keys.reranker.co", content: '"rr-log-x=BBBB"', proxied: false },
] satisfies DnsRecord[];

test("publishes every declared key TXT and removes one no longer declared", async () => {
  const { call, writes } = zone([
    { ...keys[0], id: "t1" },
    { ...keys[0], id: "t2", content: '"rr-capture-retired=CCCC"' },
  ]);
  expect(await provision(call, keys)).toEqual([
    '_rr-keys.reranker.co: create TXT "rr-log-x=BBBB"',
    '_rr-keys.reranker.co: remove TXT "rr-capture-retired=CCCC"',
  ]);
  expect(writes).toEqual([
    ["POST", "", keys[1]],
    ["DELETE", "/t2", undefined],
  ]);
});

test("a key TXT name already in the declared state is left alone", async () => {
  const { call, writes } = zone(keys.map((k, i) => ({ ...k, id: `t${i}` })));
  expect(await provision(call, keys)).toEqual(["_rr-keys.reranker.co: unchanged"]);
  expect(writes).toEqual([]);
});

test("refuses a key TXT name that also holds another record type", async () => {
  const { call } = zone([{ ...record, id: "c1", name: "_rr-keys.reranker.co" }]);
  await expect(provision(call, keys)).rejects.toThrow("also holds CNAME records");
});

test("the published key records are exactly the pinned production keys", () => {
  expect(TRUSTED_KEYS.length).toBeGreaterThan(0);
  expect(KEY_RECORDS.map((r) => r.content)).toEqual(
    TRUSTED_KEYS.map((k) => `"${k.keyid}=${k.publicKey}"`),
  );
  expect(RECORDS).toEqual(expect.arrayContaining([...KEY_RECORDS]));
});
