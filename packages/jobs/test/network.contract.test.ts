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

async function timed(n: number, fn: (i: number) => Promise<unknown>): Promise<number[]> {
  for (let i = 0; i < 10; i++) await fn(i);
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const startedAt = performance.now();
    await fn(i);
    samples.push(performance.now() - startedAt);
  }
  return samples;
}

// The runner is far from the database, so the bare system transaction around the query (four
// round trips) is measured too and the budget applies to what the lookup adds on top of it.
// Next to the database (production, preview) the transaction itself costs about a millisecond.
test("p95 under 10 ms over 1,000 lookups", async () => {
  const addresses = ["52.95.110.1", "181.62.29.10", "2600:1f00::1", "185.159.157.9"];
  const lookups = p95(await timed(1000, (i) => classifyNetwork(addresses[i % 4] as string)));
  const transaction = p95(
    await timed(1000, () => withSystem("jobs.network", (tx) => tx.execute(sql`select 1`))),
  );
  console.info(
    `classifyNetwork p95 ${lookups.toFixed(2)} ms, bare system transaction p95 ${transaction.toFixed(2)} ms`,
  );
  expect(lookups - transaction).toBeLessThan(10);
});
