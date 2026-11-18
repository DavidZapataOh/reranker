import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDetachedOts, serializeDetachedOts } from "@reranker/verify/format";
import { afterAll, expect, test } from "vitest";
import { submitDigest, upgradeTimestamp } from "../src/anchors/ots";

// The live calendars, checked against the reference client (`pipx install
// opentimestamps-client==0.8.0`, the `ots` command).
const dir = mkdtempSync(join(tmpdir(), "ots-contract-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ots = (...args: string[]) =>
  execFileSync("ots", ["--no-cache", ...args], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: 60_000,
  });

test("the reference client reads a proof merged from the live calendars", async () => {
  const digest = new Uint8Array(randomBytes(32));
  const { timestamp, calendars } = await submitDigest(digest);
  expect(calendars.length).toBeGreaterThanOrEqual(2);

  const file = join(dir, "submitted.ots");
  writeFileSync(file, serializeDetachedOts(digest, timestamp));
  const info = ots("info", file);
  expect(info).toContain(`File sha256 hash: ${Buffer.from(digest).toString("hex")}`);
  for (const calendar of calendars) expect(info).toContain(`PendingAttestation('${calendar}')`);

  // Bitcoin confirms a calendar's commitment hours later, so a fresh proof has nothing to add yet.
  expect(await upgradeTimestamp(timestamp)).toEqual({ upgraded: false, bitcoin: null });
});

test("upgrading a confirmed commitment yields the same bytes as `ots upgrade`", async () => {
  const fixture = new URL("./fixtures/ots/incomplete.txt.ots", import.meta.url);
  const theirs = join(dir, "incomplete.txt.ots");
  copyFileSync(fixture, theirs);
  ots("upgrade", theirs);

  const { digest, timestamp } = parseDetachedOts(new Uint8Array(readFileSync(fixture)));
  const result = await upgradeTimestamp(timestamp);
  expect(result.upgraded).toBe(true);
  expect(result.bitcoin?.height).toBe(428_648);
  expect(Buffer.from(serializeDetachedOts(digest, timestamp))).toEqual(readFileSync(theirs));
});
