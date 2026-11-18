import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  bitcoinAttestations,
  type OtsTimestamp,
  parseDetachedOts,
  replay,
  serializeDetachedOts,
  serializeOtsTimestamp,
} from "@reranker/verify/format";
import { describe, expect, test } from "vitest";
import { OTS_CALENDARS, submitDigest, upgradeTimestamp } from "../src/anchors/ots";
import { TimestampUnavailableError } from "../src/errors";

const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const bytesToHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const hexToBytes = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

const fixtureBytes = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/ots/${name}`, import.meta.url)));
const fixture = (name: string) => JSON.parse(new TextDecoder().decode(fixtureBytes(name)));

describe("python-opentimestamps examples", () => {
  test.each([
    "hello-world.txt.ots",
    "merkle1.txt.ots",
    "two-calendars.txt.ots",
    "incomplete.txt.ots",
  ])("round-trips %s byte for byte", (f) => {
    const bytes = fixtureBytes(f);
    const { digest, timestamp } = parseDetachedOts(bytes);
    expect(serializeDetachedOts(digest, timestamp)).toEqual(bytes);
  });

  test("hello-world reaches the same Bitcoin attestation as the reference client", () => {
    // Pinned from `ots info hello-world.txt.ots` (opentimestamps-client 0.8.0).
    expect(
      bitcoinAttestations(parseDetachedOts(fixtureBytes("hello-world.txt.ots")).timestamp),
    ).toEqual(fixture("hello-world.expected.json"));
  });

  test.each([
    "invalid/bad-major-version.ots",
    "invalid/exceeds-max-msg-length.ots",
    "invalid/invalid-file-digest-type.ots",
  ])("rejects %s", (f) => expect(() => parseDetachedOts(fixtureBytes(f))).toThrow());
});

type Reply = { status: number; body?: Uint8Array } | Error;

function recordingFetch(reply: (url: string, init: RequestInit) => Reply) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const r = reply(url, init);
    if (r instanceof Error) throw r;
    return new Response(r.body ?? null, { status: r.status });
  }) as typeof fetch;
  return Object.assign(f, { calls });
}

const digest = sha256(new TextEncoder().encode("checkpoint"));
const calendarOf = (url: string) => OTS_CALENDARS.find((c) => url.startsWith(c)) as string;

/** What a calendar answers: its own nonce and a pending attestation pointing back at itself. */
function calendarProof(msg: Uint8Array, calendar: string): OtsTimestamp {
  const nonce = sha256(new TextEncoder().encode(calendar)).slice(0, 16);
  const appended = new Uint8Array([...msg, ...nonce]);
  return {
    msg,
    attestations: [],
    ops: [
      {
        op: { op: "append", arg: nonce },
        next: {
          msg: appended,
          attestations: [],
          ops: [
            {
              op: { op: "sha256" },
              next: {
                msg: sha256(appended),
                attestations: [{ kind: "pending", uri: calendar }],
                ops: [],
              },
            },
          ],
        },
      },
    ],
  };
}

const answer = (url: string): Reply => ({
  status: 200,
  body: serializeOtsTimestamp(calendarProof(digest, calendarOf(url))),
});

describe("submitDigest", () => {
  test("posts the digest to every calendar with the official headers and merges their proofs", async () => {
    const f = recordingFetch(answer);
    const { timestamp, calendars } = await submitDigest(digest, { fetch: f });

    expect(f.calls.map((c) => c.url).sort()).toEqual(
      OTS_CALENDARS.map((c) => `${c}/digest`).sort(),
    );
    for (const { init } of f.calls) {
      expect(init.method).toBe("POST");
      expect(init.body).toEqual(digest);
      expect(init.headers).toMatchObject({ Accept: "application/vnd.opentimestamps.v1" });
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(calendars).toEqual([...OTS_CALENDARS]);
    expect(timestamp.msg).toEqual(digest);
    const attestations = replay(timestamp).map(({ attestation }) => attestation);
    expect(attestations).toHaveLength(OTS_CALENDARS.length);
    expect(attestations).toEqual(
      expect.arrayContaining(OTS_CALENDARS.map((uri) => ({ kind: "pending", uri }))),
    );
  });

  test("a calendar answering over 10,000 bytes is dropped like the reference client drops it", async () => {
    const [big] = OTS_CALENDARS;
    const f = recordingFetch((url) =>
      url.startsWith(big) ? { status: 200, body: new Uint8Array(10_001) } : answer(url),
    );
    const { calendars } = await submitDigest(digest, { fetch: f });
    expect(calendars).toEqual(OTS_CALENDARS.filter((c) => c !== big));
  });

  test("one calendar down still produces a proof from the other two; two down is an error", async () => {
    const [down, alsoDown] = OTS_CALENDARS;
    const one = recordingFetch((url) =>
      url.startsWith(down) ? new TypeError("fetch failed") : answer(url),
    );
    expect((await submitDigest(digest, { fetch: one })).calendars).toHaveLength(2);

    const two = recordingFetch((url) =>
      url.startsWith(down)
        ? { status: 503 }
        : url.startsWith(alsoDown)
          ? { status: 200, body: new Uint8Array([0xf0]) }
          : answer(url),
    );
    await expect(submitDigest(digest, { fetch: two })).rejects.toBeInstanceOf(
      TimestampUnavailableError,
    );
  });

  test("a calendar that never answers is abandoned when the caller's signal aborts", async () => {
    const hanging = Object.assign(
      ((_: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        )) as typeof fetch,
      {},
    );
    const controller = new AbortController();
    const pending = submitDigest(digest, { fetch: hanging, signal: controller.signal });
    controller.abort(new Error("deadline"));
    await expect(pending).rejects.toBeInstanceOf(TimestampUnavailableError);
  });
});

describe("upgradeTimestamp", () => {
  const calendar = OTS_CALENDARS[0];
  const pendingTip = (t: OtsTimestamp) => t.ops[0]?.next.ops[0]?.next as OtsTimestamp;

  /** The calendar's answer once its Bitcoin transaction confirmed: one more hash, then the block. */
  function confirmed(commitment: Uint8Array, height: number): Uint8Array {
    return serializeOtsTimestamp({
      msg: commitment,
      attestations: [],
      ops: [
        {
          op: { op: "sha256" },
          next: { msg: sha256(commitment), attestations: [{ kind: "bitcoin", height }], ops: [] },
        },
      ],
    });
  }

  test("asks the pending calendar for the commitment and merges the Bitcoin attestation", async () => {
    const t = calendarProof(digest, calendar);
    const commitment = pendingTip(t).msg;
    const f = recordingFetch(() => ({ status: 200, body: confirmed(commitment, 870_001) }));

    expect(await upgradeTimestamp(t, { fetch: f })).toEqual({
      upgraded: true,
      bitcoin: { height: 870_001 },
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(`${calendar}/timestamp/${bytesToHex(commitment)}`);
    expect(f.calls[0]?.init.headers).toMatchObject({ Accept: "application/vnd.opentimestamps.v1" });
    expect(bitcoinAttestations(t)).toEqual([
      { height: 870_001, commitment: bytesToHex(sha256(commitment).reverse()) },
    ]);
    // The pending attestation stays, as `ots upgrade` keeps it.
    expect(replay(t).map(({ attestation }) => attestation.kind)).toEqual(["pending", "bitcoin"]);
  });

  test("a commitment the calendar has not confirmed yet leaves the proof unchanged", async () => {
    const t = calendarProof(digest, calendar);
    const before = serializeOtsTimestamp(t);
    const f = recordingFetch(() => ({
      status: 404,
      body: new TextEncoder().encode("Pending confirmation"),
    }));
    expect(await upgradeTimestamp(t, { fetch: f })).toEqual({ upgraded: false, bitcoin: null });
    expect(serializeOtsTimestamp(t)).toEqual(before);
  });

  test("an already confirmed proof reports its lowest block without asking again", async () => {
    const t = calendarProof(digest, calendar);
    const tip = pendingTip(t);
    tip.ops.push({
      op: { op: "sha256" },
      next: {
        msg: sha256(tip.msg),
        attestations: [
          { kind: "bitcoin", height: 900_000 },
          { kind: "bitcoin", height: 870_001 },
        ],
        ops: [],
      },
    });
    const f = recordingFetch(() => ({ status: 404 }));
    expect(await upgradeTimestamp(t, { fetch: f })).toEqual({
      upgraded: false,
      bitcoin: { height: 870_001 },
    });
  });

  test("pending URIs outside the calendar whitelist are never fetched", async () => {
    const t = calendarProof(digest, calendar);
    const tip = pendingTip(t);
    tip.attestations = [
      { kind: "pending", uri: "https://169.254.169.254/latest" },
      { kind: "pending", uri: "https://alice.btc.calendar.opentimestamps.org:8443" },
      { kind: "pending", uri: "http://alice.btc.calendar.opentimestamps.org" },
      { kind: "pending", uri: "https://evil.example/x.calendar.opentimestamps.org" },
      { kind: "pending", uri: "not a url" },
    ];
    const f = recordingFetch(() => ({ status: 200, body: confirmed(tip.msg, 1) }));
    expect(await upgradeTimestamp(t, { fetch: f })).toEqual({ upgraded: false, bitcoin: null });
    expect(f.calls).toEqual([]);
  });

  test("a calendar error or a malformed answer is skipped, never thrown", async () => {
    const t = calendarProof(digest, calendar);
    const unreachable = recordingFetch(() => new TypeError("fetch failed"));
    expect(await upgradeTimestamp(t, { fetch: unreachable })).toEqual({
      upgraded: false,
      bitcoin: null,
    });
    const garbage = recordingFetch(() => ({ status: 200, body: hexToBytes("f0") }));
    expect(await upgradeTimestamp(t, { fetch: garbage })).toEqual({
      upgraded: false,
      bitcoin: null,
    });
  });
});
