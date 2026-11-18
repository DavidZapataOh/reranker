import { endPools, withSystem } from "@reranker/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { InvalidInputError } from "../src/errors";
import {
  classifyNetwork,
  type NetworkKind,
  type NetworkRangesAlert,
  refreshNetworkRanges,
} from "../src/network";

// ops.network_ranges is one shared list, and only this file writes it; every test starts empty
// and the file leaves it empty.
async function clear() {
  await withSystem("test.network", async (tx) => {
    await tx.execute(sql`delete from ops.network_ranges`);
    await tx.execute(sql`delete from ops.network_ranges_meta`);
  });
}
beforeEach(clear);
afterAll(async () => {
  await clear();
  await endPools();
});

async function load(rows: { prefix: string; kind: NetworkKind }[]) {
  await withSystem("test.network", (tx) =>
    tx.execute(
      sql`insert into ops.network_ranges (prefix, kind) select * from unnest(${sql.param(rows.map((r) => r.prefix))}::cidr[], ${sql.param(rows.map((r) => r.kind))}::text[])`,
    ),
  );
}

async function rowCount(): Promise<number> {
  const { rows } = await withSystem("test.network", (tx) =>
    tx.execute<{ n: number }>(sql`select count(*)::int as n from ops.network_ranges`),
  );
  return rows[0]?.n ?? 0;
}

async function meta() {
  const { rows } = await withSystem("test.network", (tx) =>
    tx.execute<{ source_commit: string; rows: number }>(
      sql`select source_commit, rows from ops.network_ranges_meta order by refreshed_at desc`,
    ),
  );
  return rows;
}

type Lists = Record<
  "datacenter/ipv4.txt" | "datacenter/ipv6.txt" | "vpn/ipv4.txt" | "vpn/ipv6.txt",
  string
>;

// `n` hosting prefixes, the first `vpn` of them also listed as VPN.
function lists(n: number, { vpn = 0, offset = 0 } = {}): Lists {
  const prefixes = Array.from({ length: n }, (_, i) => {
    const k = i + offset;
    return `100.${k >> 8}.${k & 255}.0/24`;
  });
  return {
    "datacenter/ipv4.txt": prefixes.join("\n"),
    "datacenter/ipv6.txt": "2600:1f00::/24\n",
    "vpn/ipv4.txt": prefixes.slice(0, vpn).join("\n"),
    "vpn/ipv6.txt": "",
  };
}

let commits = 0;
const alerts: NetworkRangesAlert[] = [];

const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;

// Each refresh sees a new upstream commit, as GitHub serves it.
async function refreshWith(body: Lists) {
  const sha = (++commits).toString(16).padStart(40, "0");
  const refs = `${pkt("# service=git-upload-pack\n")}0000${pkt(`${sha} refs/heads/main\n`)}0000`;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/info/refs?service=git-upload-pack")) {
      return new Response(refs, {
        headers: { "content-type": "application/x-git-upload-pack-advertisement" },
      });
    }
    const path = url.split(`/${sha}/output/`)[1] as keyof Lists | undefined;
    return path && path in body ? new Response(body[path]) : new Response("", { status: 404 });
  }) as typeof fetch;
  return refreshNetworkRanges(fetchImpl, { onAlert: (alert) => alerts.push(alert) });
}

beforeEach(() => {
  alerts.length = 0;
});

describe("classifyNetwork", () => {
  test("classifies by containment, including ipv4-mapped ipv6", async () => {
    await load([
      { prefix: "52.95.110.0/24", kind: "hosting" },
      { prefix: "185.159.156.0/22", kind: "vpn" },
    ]);
    expect(await classifyNetwork("52.95.110.1")).toBe("hosting");
    expect(await classifyNetwork("::ffff:52.95.110.1")).toBe("hosting");
    expect(await classifyNetwork("185.159.157.9")).toBe("vpn");
    expect(await classifyNetwork("181.49.10.2")).toBeNull();
  });

  test("the most specific prefix decides", async () => {
    await load([
      { prefix: "185.0.0.0/8", kind: "hosting" },
      { prefix: "185.159.156.0/22", kind: "vpn" },
      { prefix: "2a00::/16", kind: "vpn" },
      { prefix: "2a00:1450::/32", kind: "hosting" },
    ]);
    expect(await classifyNetwork("185.159.157.9")).toBe("vpn");
    expect(await classifyNetwork("185.1.1.1")).toBe("hosting");
    expect(await classifyNetwork("2a00:1450:4001::1")).toBe("hosting");
    expect(await classifyNetwork("2a00:9999::1")).toBe("vpn");
  });

  test.each(["", " 1.2.3.4", "1.2.3", "abc", "1.2.3.4/24", "fe80::1%eth0"])("rejects %j", (ip) =>
    expect(classifyNetwork(ip)).rejects.toBeInstanceOf(InvalidInputError),
  );
});

describe("refreshNetworkRanges", () => {
  test("loads every list and lets vpn win over hosting", async () => {
    const result = await refreshWith(lists(50, { vpn: 5 }));
    expect(result).toMatchObject({ applied: true, rows: 51, added: 51, removed: 0, changed: 0 });
    expect(await classifyNetwork("100.0.4.9")).toBe("vpn");
    expect(await classifyNetwork("100.0.5.9")).toBe("hosting");
    expect(await classifyNetwork("2600:1f00::1")).toBe("hosting");
    expect(await meta()).toEqual([{ source_commit: result.commit, rows: 51 }]);
  });

  test("a list 30% smaller keeps the current one and alerts", async () => {
    await refreshWith(lists(1000));
    const rejected = await refreshWith(lists(700));
    expect(rejected).toMatchObject({ applied: false, added: 0, removed: 0 });
    expect(await rowCount()).toBe(1001);
    expect(alerts).toContainEqual(
      expect.objectContaining({
        kind: "network-ranges-stale",
        payload: expect.objectContaining({
          reason: "change_too_large",
          current: 1001,
          incoming: 701,
        }),
      }),
    );
    expect(await meta()).toHaveLength(1);
  });

  test("only the difference is written in one transaction", async () => {
    await refreshWith(lists(1000, { vpn: 10 }));
    // 50 prefixes leave (the 10 vpn ones among them), 50 arrive and 30 switch from hosting to vpn.
    const result = await refreshWith(lists(1000, { offset: 50, vpn: 30 }));
    expect(result).toMatchObject({
      applied: true,
      rows: 1001,
      added: 50,
      removed: 50,
      changed: 30,
    });
    expect(await rowCount()).toBe(1001);
    expect(await classifyNetwork("100.0.10.1")).toBeNull();
    expect(await classifyNetwork("100.0.60.1")).toBe("vpn");
    expect(await classifyNetwork("100.0.79.1")).toBe("vpn");
    expect(await classifyNetwork("100.0.80.1")).toBe("hosting");
    expect(await classifyNetwork("100.4.25.1")).toBe("hosting");

    const again = await refreshWith(lists(1000, { offset: 50, vpn: 30 }));
    expect(again).toMatchObject({ applied: true, added: 0, removed: 0, changed: 0 });
    expect((await meta()).map((m) => m.source_commit)[0]).toBe(again.commit);
  });

  test("concurrent refreshes apply once and never mix", async () => {
    const results = await Promise.all([refreshWith(lists(400)), refreshWith(lists(400))]);
    expect(results.filter((r) => r.applied).length).toBeGreaterThanOrEqual(1);
    expect(await rowCount()).toBe(401);
  });

  test("fetch failure keeps the old data; meta older than 48 h alerts", async () => {
    await refreshWith(lists(100));
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const onAlert = (alert: NetworkRangesAlert) => alerts.push(alert);

    await expect(refreshNetworkRanges(down, { onAlert })).rejects.toThrow();
    expect(await rowCount()).toBe(101);
    expect(alerts).toEqual([]);

    await withSystem("test.network", (tx) =>
      tx.execute(
        sql`update ops.network_ranges_meta set refreshed_at = now() - interval '49 hours'`,
      ),
    );
    await expect(refreshNetworkRanges(down, { onAlert })).rejects.toThrow();
    expect(await rowCount()).toBe(101);
    expect(alerts).toEqual([
      { kind: "network-ranges-stale", payload: { reason: "download_failed", hours: 49 } },
    ]);
  });
});
