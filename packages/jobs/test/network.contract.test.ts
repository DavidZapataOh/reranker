import { endPools, withSystem } from "@reranker/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { classifyNetwork, refreshNetworkRanges } from "../src/network";

// One address per Colombian operator, inside an IPv4 block LACNIC delegated to it
// (delegated-lacnic-extended-latest, CO rows) and announced by its ASN in IPLocate's
// ip-to-asn database. Checked on 2026-11-16.
const COLOMBIAN_RESIDENTIAL_SAMPLES = [
  ["181.62.29.10", "Claro hogar, AS10620 Telmex Colombia, 181.56.0.0/13 (2012-10-16)"],
  ["181.253.10.20", "Claro móvil, AS26611 Comcel, 181.240.0.0/12 (2012-12-03)"],
  ["191.89.10.20", "Tigo, AS13489 UNE EPM / Colombia Móvil, 191.88.0.0/13 (2013-12-17)"],
  ["191.106.130.10", "Movistar, AS3816 Colombia Telecomunicaciones, 191.104.0.0/13 (2013-11-12)"],
  ["201.245.10.20", "ETB, AS19429 ETB, 201.245.0.0/16 (2004-08-06)"],
  ["179.18.130.10", "WOM, AS271773 Partners Telecom Colombia, 179.18.0.0/16 (2014-02-19)"],
] as const;

let rows = 0;
beforeAll(async () => {
  rows = (await refreshNetworkRanges()).rows;
}, 150_000);
afterAll(() => endPools());

// The first usable address of an IPv4 prefix.
function firstHost(prefix: string): string {
  const [address = ""] = prefix.split("/");
  const octets = address.split(".").map(Number);
  octets[3] = (octets[3] ?? 0) + 1;
  return octets.join(".");
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

test("real lists load at least 40,000 prefixes", () => expect(rows).toBeGreaterThanOrEqual(40_000));

test("an AWS address from ip-ranges.json is hosting", async () => {
  const aws = (await (
    await fetch("https://ip-ranges.amazonaws.com/ip-ranges.json", {
      signal: AbortSignal.timeout(115_000),
    })
  ).json()) as { prefixes: { ip_prefix: string; service: string }[] };
  const ec2 = aws.prefixes.find((p) => p.service === "EC2");
  expect(ec2).toBeDefined();
  expect(await classifyNetwork(firstHost(ec2?.ip_prefix ?? ""))).toBe("hosting");
});

// Only meaningful on a GitHub-hosted runner, whose egress is Azure.
test("the GitHub Actions runner egress ip is hosting", async () =>
  expect(
    await classifyNetwork(
      (
        await (
          await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(115_000) })
        ).text()
      ).trim(),
    ),
  ).toBe("hosting"));

test.each(COLOMBIAN_RESIDENTIAL_SAMPLES)("%s (%s, LACNIC) is not flagged", async (ip) =>
  expect(await classifyNetwork(ip)).toBeNull(),
);

// The statement classifyNetwork runs, sent through EXECUTE so it is parsed and planned on every
// call, as the driver's unnamed statements are.
const TIME_LOOKUPS = sql.raw(`
  create or replace function pg_temp.time_network_lookups(addresses inet[])
  returns table (kind text, ms double precision) language plpgsql as $$
  declare
    address inet;
    started timestamptz;
  begin
    foreach address in array addresses loop
      started := clock_timestamp();
      execute 'select kind from ops.network_ranges where prefix >>= $1 order by masklen(prefix) desc limit 1'
        into kind using address;
      ms := extract(epoch from clock_timestamp() - started) * 1000;
      return next;
    end loop;
  end $$`);

// Each lookup is timed inside Postgres, so the runner's distance to Neon stays out of the number.
// The transaction around it is timed from iad1, next to the database, by the preview probe
// (load/jobs/network.js), where the same budget holds end to end.
test("p95 under 10 ms over 1,000 lookups, timed in the database", async () => {
  const addresses = ["52.95.110.1", "181.62.29.10", "2600:1f00::1", "185.159.157.9"];
  const expected: (string | null)[] = [];
  for (const address of addresses) expected.push(await classifyNetwork(address));
  const lookups = Array.from({ length: 1000 }, (_, i) => addresses[i % addresses.length]);

  const { rows } = await withSystem(
    "jobs.network",
    async (tx) => {
      await tx.execute(TIME_LOOKUPS);
      const timed = await tx.execute<{ kind: string | null; ms: number }>(
        sql`select kind, ms from pg_temp.time_network_lookups(${sql.param(lookups)}::inet[])`,
      );
      // Pooled sessions outlive the transaction, and so would a temporary function.
      await tx.execute(sql`drop function pg_temp.time_network_lookups(inet[])`);
      return timed;
    },
    { statementTimeoutMs: 30_000 },
  );

  expect(rows).toHaveLength(1000);
  expect(rows.map((row) => row.kind)).toEqual(lookups.map((_, i) => expected[i % 4] ?? null));
  const samples = rows.map((row) => row.ms);
  const sorted = [...samples].sort((a, b) => a - b);
  console.info(
    `network lookup in the database: p50 ${sorted[499]?.toFixed(3)} ms, p95 ${p95(samples).toFixed(3)} ms`,
  );
  expect(p95(samples)).toBeLessThan(10);
});
