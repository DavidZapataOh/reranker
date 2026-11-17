import { BlockList, isIP, SocketAddress } from "node:net";
import { withSystem } from "@reranker/db";
import { sql } from "drizzle-orm";
import { InvalidInputError } from "./errors";
import { NETWORK_EXCLUSIONS } from "./network-exclusions";

export type NetworkKind = "hosting" | "vpn";

/** Raised when the lists could not be refreshed; the payload has no personal data. */
export interface NetworkRangesAlert {
  kind: "network-ranges-stale";
  payload: Record<string, string | number | boolean>;
}

export interface NetworkRangesRefresh {
  applied: boolean;
  rows: number;
  added: number;
  removed: number;
  changed: number;
  commit: string;
}

// X4BNet/lists_vpn (MIT), built from IPLocate's IP to ASN data (CC BY-SA 4.0). The datacenter
// lists already include VPN networks, so a prefix in both is a VPN.
const REPOSITORY = "X4BNet/lists_vpn";
const COMMIT_URL = `https://api.github.com/repos/${REPOSITORY}/commits/main`;
const SOURCES: readonly { path: string; kind: NetworkKind }[] = [
  { path: "datacenter/ipv4.txt", kind: "hosting" },
  { path: "datacenter/ipv6.txt", kind: "hosting" },
  { path: "vpn/ipv4.txt", kind: "vpn" },
  { path: "vpn/ipv6.txt", kind: "vpn" },
];

const REQUEST_TIMEOUT_MS = 115_000;
const MAX_CHANGE = 0.2;
const STALE_AFTER_HOURS = 48;
const BATCH_SIZE = 10_000;
const HOUR_MS = 3_600_000;

type Family = 4 | 6;
interface Prefix {
  family: Family;
  value: bigint;
  length: number;
}

const bitsOf = (family: Family) => (family === 4 ? 32 : 128);

function ipv4Value(address: string): bigint {
  return address.split(".").reduce((acc, octet) => (acc << 8n) | BigInt(octet), 0n);
}

// Input already passed isIP, so groups are well formed; an IPv4 tail becomes two groups.
function ipv6Value(address: string): bigint {
  let text = address;
  const tailAt = text.lastIndexOf(":") + 1;
  if (text.includes(".", tailAt)) {
    const v4 = ipv4Value(text.slice(tailAt));
    text = `${text.slice(0, tailAt)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const zeros = tail === undefined ? [] : Array(8 - left.length - right.length).fill("0");
  return [...left, ...zeros, ...right].reduce(
    (acc, group) => (acc << 16n) | BigInt(`0x${group}`),
    0n,
  );
}

function format({ family, value }: Prefix): string {
  if (family === 4) {
    return [24n, 16n, 8n, 0n].map((shift) => (value >> shift) & 0xffn).join(".");
  }
  const groups = Array.from({ length: 8 }, (_, i) =>
    ((value >> BigInt(112 - i * 16)) & 0xffffn).toString(16),
  );
  // Node's inet_ntop gives the RFC 5952 form Postgres also prints.
  return new SocketAddress({ address: groups.join(":"), family: "ipv6" }).address;
}

function parsePrefix(text: string): Prefix | undefined {
  const slash = text.indexOf("/");
  const address = slash === -1 ? text : text.slice(0, slash);
  const family = isIP(address);
  // Zone ids pass isIP but are no network.
  if (family === 0 || address.includes("%")) return undefined;
  const bits = bitsOf(family as Family);
  let length = bits;
  if (slash !== -1) {
    const raw = text.slice(slash + 1);
    if (!/^\d{1,3}$/.test(raw) || Number(raw) > bits) return undefined;
    length = Number(raw);
  }
  const full = family === 4 ? ipv4Value(address) : ipv6Value(address);
  const host = BigInt(bits - length);
  return { family: family as Family, value: (full >> host) << host, length };
}

/** CIDRs of a list, one per line: host bits cleared, comments, blanks, junk and repeats dropped. */
export function parseRangeList(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const entry = line.replace(/#.*/, "").trim();
    const prefix = entry ? parsePrefix(entry) : undefined;
    if (prefix) out.add(`${format(prefix)}/${prefix.length}`);
  }
  return [...out];
}

function contains(outer: Prefix, inner: Prefix): boolean {
  if (outer.family !== inner.family || inner.length < outer.length) return false;
  const host = BigInt(bitsOf(outer.family) - outer.length);
  return inner.value >> host === outer.value >> host;
}

/** One kind per prefix, VPN over hosting, without anything inside an exclusion. */
export function mergeLists(
  lists: readonly { kind: NetworkKind; prefixes: readonly string[] }[],
  exclusions: readonly string[] = NETWORK_EXCLUSIONS,
): Map<string, NetworkKind> {
  const excluded = exclusions.flatMap((e) => parsePrefix(e) ?? []);
  const merged = new Map<string, NetworkKind>();
  for (const { kind, prefixes } of lists) {
    for (const text of prefixes) {
      const prefix = parsePrefix(text);
      if (!prefix || excluded.some((e) => contains(e, prefix))) continue;
      if (merged.get(text) !== "vpn") merged.set(text, kind);
    }
  }
  return merged;
}

const excludedAddresses = new BlockList();
for (const text of NETWORK_EXCLUSIONS) {
  const prefix = parsePrefix(text);
  if (prefix) {
    excludedAddresses.addSubnet(
      format(prefix),
      prefix.length,
      prefix.family === 4 ? "ipv4" : "ipv6",
    );
  }
}

// An IPv4-mapped IPv6 address is the IPv4 client behind a dual-stack socket.
function lookupAddress(ip: unknown): string {
  if (typeof ip !== "string" || ip.includes("%") || isIP(ip) === 0) {
    throw new InvalidInputError("Expected a single IP address");
  }
  if (isIP(ip) === 4) return ip;
  const canonical = new SocketAddress({ address: ip, family: "ipv6" }).address;
  return /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(canonical)?.[1] ?? canonical;
}

/** Whether the address belongs to a datacenter or VPN network; the most specific prefix decides. */
export async function classifyNetwork(ip: string): Promise<NetworkKind | null> {
  const address = lookupAddress(ip);
  if (excludedAddresses.check(address, isIP(address) === 4 ? "ipv4" : "ipv6")) return null;
  const { rows } = await withSystem(
    "jobs.network",
    (tx) =>
      tx.execute<{ kind: NetworkKind }>(
        sql`select kind from ops.network_ranges where prefix >>= ${address}::inet order by masklen(prefix) desc limit 1`,
      ),
    { readOnly: true },
  );
  return rows[0]?.kind ?? null;
}

async function download(fetchImpl: typeof fetch, url: string, init: RequestInit = {}) {
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  return response.text();
}

// The commit is read once and every list is fetched at it, so the four files are one version.
async function latestCommit(fetchImpl: typeof fetch): Promise<string> {
  const sha = (
    await download(fetchImpl, COMMIT_URL, {
      headers: {
        Accept: "application/vnd.github.sha",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "reranker",
      },
    })
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Unexpected commit id from ${COMMIT_URL}`);
  return sha;
}

async function fetchLists(fetchImpl: typeof fetch, commit: string) {
  return mergeLists(
    await Promise.all(
      SOURCES.map(async ({ path, kind }) => ({
        kind,
        prefixes: parseRangeList(
          await download(
            fetchImpl,
            `https://raw.githubusercontent.com/${REPOSITORY}/${commit}/output/${path}`,
          ),
        ),
      })),
    ),
  );
}

type Meta = { source_commit: string; rows: number; refreshed_at: Date | string };

async function currentMeta(): Promise<Meta | undefined> {
  const { rows } = await withSystem("jobs.network.meta", (tx) =>
    tx.execute<Meta>(
      sql`select source_commit, rows, refreshed_at from ops.network_ranges_meta order by refreshed_at desc limit 1`,
    ),
  );
  return rows[0];
}

type Applied =
  | { status: "busy" }
  | { status: "rejected"; current: number }
  | { status: "applied"; added: number; removed: number; changed: number };

// The table is rewritten by difference only, so readers never see it half loaded and only the
// rows that change are locked.
async function apply(ranges: Map<string, NetworkKind>, commit: string): Promise<Applied> {
  return withSystem(
    "jobs.network.refresh",
    async (tx): Promise<Applied> => {
      const lock = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtext('ops.network_ranges')) as locked`,
      );
      if (!lock.rows[0]?.locked) return { status: "busy" };
      const count = await tx.execute<{ rows: number }>(
        sql`select count(*)::int as rows from ops.network_ranges`,
      );
      const current = count.rows[0]?.rows ?? 0;
      if (current > 0 && Math.abs(ranges.size - current) / current > MAX_CHANGE) {
        return { status: "rejected", current };
      }

      await tx.execute(
        sql`create temp table incoming_ranges (prefix cidr primary key, kind text not null) on commit drop`,
      );
      const entries = [...ranges];
      for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        await tx.execute(
          sql`insert into incoming_ranges (prefix, kind) select * from unnest(${sql.param(batch.map(([p]) => p))}::cidr[], ${sql.param(batch.map(([, k]) => k))}::text[])`,
        );
      }
      await tx.execute(sql`analyze incoming_ranges`);

      const gone = await tx.execute<{ removed: number }>(sql`
        with gone as (
          delete from ops.network_ranges r
          where not exists (select 1 from incoming_ranges i where i.prefix = r.prefix)
          returning 1
        )
        select count(*)::int as removed from gone`);
      const written = await tx.execute<{ added: number; changed: number }>(sql`
        with written as (
          insert into ops.network_ranges (prefix, kind)
          select i.prefix, i.kind from incoming_ranges i
          left join ops.network_ranges r on r.prefix = i.prefix
          where r.prefix is null or r.kind <> i.kind
          on conflict (prefix) do update set kind = excluded.kind
          returning (xmax = 0) as inserted
        )
        select count(*) filter (where inserted)::int as added,
               count(*) filter (where not inserted)::int as changed
        from written`);
      await tx.execute(sql`
        insert into ops.network_ranges_meta (source_commit, rows) values (${commit}, ${ranges.size})
        on conflict (source_commit) do update set rows = excluded.rows, refreshed_at = now()`);
      return {
        status: "applied",
        removed: gone.rows[0]?.removed ?? 0,
        added: written.rows[0]?.added ?? 0,
        changed: written.rows[0]?.changed ?? 0,
      };
    },
    { statementTimeoutMs: 60_000 },
  );
}

/**
 * Daily refresh of the datacenter and VPN lists, pinned to the upstream commit read first. A list
 * that is empty or more than 20% away from the current one is not applied, and neither is a failed
 * download: the current list stays and `onAlert` hears about it (a failed download only once the
 * data is 48 h old). A failed download also throws, so the step retries.
 */
export async function refreshNetworkRanges(
  fetchImpl: typeof fetch = fetch,
  opts: { onAlert?: (alert: NetworkRangesAlert) => void } = {},
): Promise<NetworkRangesRefresh> {
  const alert = (payload: NetworkRangesAlert["payload"]) =>
    opts.onAlert?.({ kind: "network-ranges-stale", payload });

  let commit: string;
  let ranges: Map<string, NetworkKind>;
  let meta: Meta | undefined;
  try {
    commit = await latestCommit(fetchImpl);
    meta = await currentMeta();
    if (meta?.source_commit === commit) {
      await withSystem("jobs.network.meta", (tx) =>
        tx.execute(
          sql`update ops.network_ranges_meta set refreshed_at = now() where source_commit = ${commit}`,
        ),
      );
      return { applied: true, rows: meta.rows, added: 0, removed: 0, changed: 0, commit };
    }
    ranges = await fetchLists(fetchImpl, commit);
  } catch (error) {
    meta ??= await currentMeta();
    if (!meta) {
      alert({ reason: "never_loaded" });
    } else {
      const hours = Math.floor((Date.now() - new Date(meta.refreshed_at).getTime()) / HOUR_MS);
      if (hours >= STALE_AFTER_HOURS) alert({ reason: "download_failed", hours });
    }
    throw error;
  }

  const unchanged = { applied: false, added: 0, removed: 0, changed: 0, commit };
  if (ranges.size === 0) {
    alert({ reason: "empty_lists", commit });
    return { ...unchanged, rows: meta?.rows ?? 0 };
  }
  const result = await apply(ranges, commit);
  if (result.status === "busy") return { ...unchanged, rows: meta?.rows ?? 0 };
  if (result.status === "rejected") {
    alert({ reason: "change_too_large", current: result.current, incoming: ranges.size, commit });
    return { ...unchanged, rows: result.current };
  }
  const { status: _, ...diff } = result;
  return { applied: true, rows: ranges.size, ...diff, commit };
}
