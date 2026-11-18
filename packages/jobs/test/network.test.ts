import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, test, vi } from "vitest";

const execute = vi.fn();
const withSystem = vi.fn(async (_reason: string, fn: (tx: unknown) => unknown, _opts?: unknown) =>
  fn({ execute }),
);
vi.mock("@reranker/db", () => ({ withSystem }));
vi.mock("../src/network-exclusions", () => ({ NETWORK_EXCLUSIONS: ["100.64.0.0/10"] }));

const { InvalidInputError, RateLimitedError } = await import("../src/errors");
const { advertisedRef, classifyNetwork, mergeLists, parseRangeList, refreshNetworkRanges } =
  await import("../src/network");

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OLDER = "f".repeat(40);

// Statement text with its parameters, so assertions read the query that reaches Postgres.
const dialect = new PgDialect();
function rendered(query: unknown): string {
  const { sql, params } = dialect.sqlToQuery(query as SQL);
  return `${sql} ${JSON.stringify(params)}`;
}
const statements = () => execute.mock.calls.map(([q]) => rendered(q));

const REFS_URL = "https://github.com/X4BNet/lists_vpn.git/info/refs?service=git-upload-pack";

const pkt = (line: string) =>
  `${(new TextEncoder().encode(line).length + 4).toString(16).padStart(4, "0")}${line}`;

// A smart HTTP ref advertisement as github.com sends it: HEAD first with the capabilities, then
// every branch in name order.
function advertisement(main: string) {
  return [
    pkt("# service=git-upload-pack\n"),
    "0000",
    pkt(
      `${main} HEAD\0multi_ack thin-pack side-band symref=HEAD:refs/heads/main agent=git/github\n`,
    ),
    pkt(`${OLDER} refs/heads/experiment/split-list\n`),
    pkt(`${main} refs/heads/main\n`),
    pkt(`${OLDER} refs/heads/main-ñ\n`),
    "0000",
  ].join("");
}
const ADVERTISEMENT_TYPE = { "content-type": "application/x-git-upload-pack-advertisement" };

// Serves the upstream refs and the four lists the way GitHub does.
function upstream(lists: Partial<Record<string, string>>, sha = SHA) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === REFS_URL) {
      return new Response(advertisement(sha), { headers: ADVERTISEMENT_TYPE });
    }
    const prefix = `https://raw.githubusercontent.com/X4BNet/lists_vpn/${sha}/output/`;
    const body = url.startsWith(prefix) ? lists[url.slice(prefix.length)] : undefined;
    return body === undefined ? new Response("", { status: 404 }) : new Response(body);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const LISTS = {
  "datacenter/ipv4.txt": "52.95.110.0/24\n185.159.156.0/22\n",
  "datacenter/ipv6.txt": "2600:1f00::/24\n",
  "vpn/ipv4.txt": "185.159.156.0/22\n",
  "vpn/ipv6.txt": "",
};

beforeEach(() => {
  execute.mockReset();
  withSystem.mockClear();
});

describe("parseRangeList", () => {
  test("parses and normalizes lists", () =>
    expect(parseRangeList("# c\n1.12.0.0/14\n\nnot-an-ip\n2001:db8::/32\n")).toEqual([
      "1.12.0.0/14",
      "2001:db8::/32",
    ]));

  test("clears host bits, writes IPv6 canonically and reads bare addresses as hosts", () =>
    expect(
      parseRangeList(
        "1.2.3.4/24  # trailing comment\r\n2001:0DB8:0:0:1::/48\n8.8.8.8\n::ffff:1.2.3.4/120\n",
      ),
    ).toEqual(["1.2.3.0/24", "2001:db8::/48", "8.8.8.8/32", "::ffff:1.2.3.0/120"]));

  test("drops malformed prefixes and duplicates", () =>
    expect(
      parseRangeList(
        "1.2.3.0/33\n1.2.3.0/\n1.2.3.0/-1\n1.2.3.0/2x\n::/129\nfe80::1%eth0/64\n1.2.3.0/24\n1.2.3.9/24\n::/0\n",
      ),
    ).toEqual(["1.2.3.0/24", "::/0"]));
});

describe("mergeLists", () => {
  test("vpn wins over hosting for the same prefix and exclusions are removed", () => {
    const merged = mergeLists(
      [
        { kind: "hosting", prefixes: ["1.0.0.0/24", "2.0.1.0/24", "2001:db8::/48", "3.0.0.0/8"] },
        { kind: "vpn", prefixes: ["1.0.0.0/24", "2.0.0.0/16"] },
      ],
      ["2.0.0.0/16", "2001:db8::/32", "3.1.0.0/16"],
    );
    // A list prefix wider than an exclusion stays; lookups skip the excluded part.
    expect([...merged]).toEqual([
      ["1.0.0.0/24", "vpn"],
      ["3.0.0.0/8", "hosting"],
    ]);
  });

  test("uses the repository exclusions by default", () =>
    expect([
      ...mergeLists([{ kind: "hosting", prefixes: ["100.64.1.0/24", "5.0.0.0/8"] }]),
    ]).toEqual([["5.0.0.0/8", "hosting"]]));
});

describe("classifyNetwork", () => {
  test("asks for the longest containing prefix in one read-only system query", async () => {
    execute.mockResolvedValue({ rows: [{ kind: "hosting" }] });
    await expect(classifyNetwork("52.95.110.1")).resolves.toBe("hosting");
    expect(withSystem).toHaveBeenCalledTimes(1);
    expect(withSystem.mock.calls[0]?.[0]).toBe("jobs.network");
    expect(withSystem.mock.calls[0]?.[2]).toEqual({ readOnly: true });
  });

  test("is null when no prefix contains the address", async () => {
    execute.mockResolvedValue({ rows: [] });
    await expect(classifyNetwork("2800:e2::1")).resolves.toBeNull();
  });

  test.each(["::ffff:52.95.110.1", "::FFFF:52.95.110.1", "0:0:0:0:0:ffff:345f:6e01"])(
    "looks up %s as its IPv4 address",
    async (ip) => {
      execute.mockResolvedValue({ rows: [{ kind: "hosting" }] });
      await classifyNetwork(ip);
      expect(rendered(execute.mock.calls[0]?.[0])).toContain('"52.95.110.1"');
    },
  );

  test("never classifies an excluded network, even inside a listed one", async () => {
    await expect(classifyNetwork("100.64.0.1")).resolves.toBeNull();
    await expect(classifyNetwork("::ffff:100.64.0.1")).resolves.toBeNull();
    expect(withSystem).not.toHaveBeenCalled();
  });

  test.each([
    "",
    " 1.2.3.4",
    "1.2.3.4 ",
    "1.2.3",
    "abc",
    "1.2.3.4/24",
    "01.2.3.4",
    "fe80::1%eth0",
    undefined,
    17,
  ])("rejects %j before touching the database", async (ip) => {
    await expect(classifyNetwork(ip as string)).rejects.toBeInstanceOf(InvalidInputError);
    expect(withSystem).not.toHaveBeenCalled();
  });
});

describe("advertisedRef", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  test("finds the branch among the others, counting bytes, not characters", () => {
    expect(advertisedRef(bytes(advertisement(SHA)), "refs/heads/main")).toBe(SHA);
    expect(advertisedRef(bytes(advertisement(SHA)), "refs/heads/main-ñ")).toBe(OLDER);
  });

  test("the ref on the capabilities line is read without them", () =>
    expect(advertisedRef(bytes(advertisement(SHA)), "HEAD")).toBe(SHA));

  test.each([
    ["a missing ref", advertisement(SHA).replace("refs/heads/main\n", "refs/heads/trunk\n")],
    ["a dumb server listing", `${SHA}\trefs/heads/main\n`],
    ["no service line", pkt(`${SHA} refs/heads/main\n`)],
    ["a truncated pkt-line", advertisement(SHA).slice(0, -20)],
    ["an object id that is not one", advertisement("z".repeat(40))],
  ])("gives nothing for %s", (_, text) =>
    expect(advertisedRef(bytes(text), "refs/heads/main")).toBeUndefined(),
  );
});

describe("refreshNetworkRanges", () => {
  // The order of statements inside the apply transaction.
  function applyRows(current: number, written = { removed: 0, added: 3, changed: 0 }) {
    execute.mockImplementation(async (query: unknown) => {
      const text = rendered(query);
      if (text.includes("from ops.network_ranges_meta")) return { rows: [] };
      if (text.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }] };
      if (text.includes("count(*)::int as rows")) return { rows: [{ rows: current }] };
      if (text.includes("as removed")) return { rows: [{ removed: written.removed }] };
      if (text.includes("as added"))
        return { rows: [{ added: written.added, changed: written.changed }] };
      return { rows: [] };
    });
  }

  test("loads the pinned commit, vpn over hosting, in one transaction", async () => {
    applyRows(0);
    const fetchImpl = upstream(LISTS);
    await expect(refreshNetworkRanges(fetchImpl)).resolves.toEqual({
      applied: true,
      rows: 3,
      added: 3,
      removed: 0,
      changed: 0,
      commit: SHA,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    for (const [, init] of fetchImpl.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal);
    const apply = withSystem.mock.calls.find(([reason]) => reason === "jobs.network.refresh");
    expect(apply?.[2]).toEqual({ statementTimeoutMs: 60_000 });
    const staged = statements().find((q) => q.includes("insert into incoming_ranges"));
    expect(staged).toContain("185.159.156.0/22");
    expect(staged).toContain("vpn");
  });

  test("stages the rows in batches of 10,000", async () => {
    const big = Array.from({ length: 25_000 }, (_, i) => `10.${i >> 8}.${i & 255}.0/24`).join("\n");
    applyRows(0, { removed: 0, added: 25_000, changed: 0 });
    await refreshNetworkRanges(upstream({ ...LISTS, "datacenter/ipv4.txt": big }));
    const batches = statements().filter((q) => q.includes("insert into incoming_ranges"));
    expect(batches).toHaveLength(3);
  });

  test("a change above 20% keeps the current list and alerts", async () => {
    applyRows(10);
    const onAlert = vi.fn();
    await expect(refreshNetworkRanges(upstream(LISTS), { onAlert })).resolves.toMatchObject({
      applied: false,
      rows: 10,
      added: 0,
      removed: 0,
    });
    expect(onAlert).toHaveBeenCalledWith({
      kind: "network-ranges-stale",
      payload: { reason: "change_too_large", current: 10, incoming: 3, commit: SHA },
    });
    expect(statements().some((q) => q.includes("insert into incoming_ranges"))).toBe(false);
  });

  test("empty lists never replace the current ones", async () => {
    applyRows(0);
    const onAlert = vi.fn();
    const empty = {
      ...LISTS,
      "datacenter/ipv4.txt": "",
      "datacenter/ipv6.txt": "",
      "vpn/ipv4.txt": "",
    };
    await expect(refreshNetworkRanges(upstream(empty), { onAlert })).resolves.toMatchObject({
      applied: false,
    });
    expect(onAlert).toHaveBeenCalledWith({
      kind: "network-ranges-stale",
      payload: { reason: "empty_lists", commit: SHA },
    });
  });

  test("another refresh holding the lock makes this one a no-op", async () => {
    execute.mockImplementation(async (query: unknown) => {
      const text = rendered(query);
      if (text.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: false }] };
      return { rows: [] };
    });
    const onAlert = vi.fn();
    await expect(refreshNetworkRanges(upstream(LISTS), { onAlert })).resolves.toMatchObject({
      applied: false,
    });
    expect(onAlert).not.toHaveBeenCalled();
  });

  test("the commit already loaded only renews its date", async () => {
    execute.mockImplementation(async (query: unknown) => {
      const text = rendered(query);
      if (text.includes("order by refreshed_at desc"))
        return { rows: [{ source_commit: SHA, rows: 42, refreshed_at: new Date() }] };
      return { rows: [] };
    });
    const fetchImpl = upstream(LISTS);
    await expect(refreshNetworkRanges(fetchImpl)).resolves.toEqual({
      applied: true,
      rows: 42,
      added: 0,
      removed: 0,
      changed: 0,
      commit: SHA,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(statements().some((q) => q.includes("update ops.network_ranges_meta"))).toBe(true);
  });

  test.each([
    ["the commit lookup fails", upstream(LISTS, "not-a-sha")],
    [
      "github answers in another format",
      vi.fn(async () => new Response(advertisement(SHA))) as unknown as typeof fetch,
    ],
    ["a list is missing", upstream({ ...LISTS, "vpn/ipv6.txt": undefined })],
    [
      "the network is down",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    ],
  ])("throws when %s and alerts only once the data is 48 h old", async (_, fetchImpl) => {
    const onAlert = vi.fn();
    const meta = (hoursAgo: number) => ({
      rows: [
        {
          source_commit: OLDER,
          rows: 42,
          refreshed_at: new Date(Date.now() - hoursAgo * 3_600_000),
        },
      ],
    });

    execute.mockResolvedValue(meta(47));
    await expect(refreshNetworkRanges(fetchImpl, { onAlert })).rejects.toThrow();
    expect(onAlert).not.toHaveBeenCalled();

    execute.mockResolvedValue(meta(49));
    await expect(refreshNetworkRanges(fetchImpl, { onAlert })).rejects.toThrow();
    expect(onAlert).toHaveBeenCalledWith({
      kind: "network-ranges-stale",
      payload: { reason: "download_failed", hours: 49 },
    });
  });

  test("a failed first download alerts at once", async () => {
    execute.mockResolvedValue({ rows: [] });
    const onAlert = vi.fn();
    await expect(refreshNetworkRanges(upstream({}), { onAlert })).rejects.toThrow();
    expect(onAlert).toHaveBeenCalledWith({
      kind: "network-ranges-stale",
      payload: { reason: "never_loaded" },
    });
  });
});

describe("a throttled download", () => {
  const throttled = (url: string, status: number, headers: Record<string, string>) => {
    const serve = upstream(LISTS);
    return vi.fn(async (input: string | URL | Request) =>
      String(input).startsWith(url) ? new Response("", { status, headers }) : serve(input),
    ) as unknown as typeof fetch;
  };
  const waitOf = async (fetchImpl: typeof fetch, attempt = 1) => {
    const error = await refreshNetworkRanges(fetchImpl, { attempt }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    return (error as InstanceType<typeof RateLimitedError>).retryAfterMs;
  };

  beforeEach(() => execute.mockResolvedValue({ rows: [] }));

  test("waits the seconds of retry-after", async () =>
    expect(await waitOf(throttled(REFS_URL, 429, { "retry-after": "120" }))).toBeGreaterThan(
      119_000,
    ));

  test("waits for the reset of an exhausted window", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 1800);
    const wait = await waitOf(
      throttled("https://raw.githubusercontent.com/", 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": reset,
      }),
    );
    expect(wait).toBeGreaterThan(1_798_000);
    expect(wait).toBeLessThanOrEqual(1_800_000);
  });

  test("without a hint waits a minute, doubling with each attempt", async () => {
    const fetchImpl = throttled(REFS_URL, 403, {});
    expect(await waitOf(fetchImpl)).toBe(60_000);
    expect(await waitOf(fetchImpl, 3)).toBe(240_000);
  });

  test("names the host that throttled", async () => {
    const error = await refreshNetworkRanges(throttled(REFS_URL, 429, {})).catch((e) => e);
    expect((error as Error).message).toMatch(/^Rate limited by github.com, retry in/);
  });

  test("still alerts once the loaded list is 48 h old", async () => {
    execute.mockResolvedValue({
      rows: [
        { source_commit: OLDER, rows: 42, refreshed_at: new Date(Date.now() - 50 * 3_600_000) },
      ],
    });
    const onAlert = vi.fn();
    await expect(
      refreshNetworkRanges(throttled(REFS_URL, 429, {}), { onAlert }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    expect(onAlert).toHaveBeenCalledWith({
      kind: "network-ranges-stale",
      payload: { reason: "download_failed", hours: 50 },
    });
  });
});
