import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { requestTimestamp, TSAS } from "../src/anchors/rfc3161";

// Live TSAs, checked the way any verifier would: `openssl ts -verify` against the chain each
// provider publishes (DigiCert's cacerts.digicert.com, qtsa.eu's TSAChain.zip). qtsa.eu joins
// once its CI endpoint (QTSA_TSA_URL_CI, read with requireEnv) is bought.
const dir = mkdtempSync(join(tmpdir(), "tsa-contract-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const chain = (name: string) =>
  new URL(`./fixtures/tsa/${name}-chain.pem`, import.meta.url).pathname;

const tsas = [{ name: "digicert", url: TSAS.digicert.url() as string }];

test.for(tsas)("$name issues a token openssl verifies", async ({ name, url }) => {
  const digest = new Uint8Array(randomBytes(32));
  const file = join(dir, `${name}.tsr`);
  writeFileSync(file, await requestTimestamp(url, digest));
  const out = execFileSync(
    "openssl",
    [
      "ts",
      "-verify",
      "-digest",
      Buffer.from(digest).toString("hex"),
      "-in",
      file,
      "-CAfile",
      chain(name),
    ],
    { encoding: "utf8", stdio: "pipe" },
  );
  expect(out).toContain("Verification: OK");
});
