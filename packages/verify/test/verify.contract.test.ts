import { expect, test } from "vitest";
import { KEYS_BY_ENV } from "../src/trust/keys";
import { verifyCapture } from "../src/verdict";

// A missing value fails the run rather than skipping it, like every nightly contract test.
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// A capture sealed by a preview deployment, checked end to end against what that deployment
// published: its bundle route, the preview artifact domain and its log, with the pinned preview keys.
const ORIGIN = required("VERIFY_CONTRACT_ORIGIN");
const LOG = required("VERIFY_CONTRACT_LOG_ORIGIN");
const CAPTURE_ID = required("VERIFY_CONTRACT_CAPTURE_ID");
const BYPASS = required("VERCEL_AUTOMATION_BYPASS_SECRET");

// Vercel's protection bypass for automation, sent only to the deployment.
const viaPreview: typeof fetch = (input, init) =>
  String(input).startsWith(`${ORIGIN}/`)
    ? fetch(input, { ...init, headers: { "x-vercel-protection-bypass": BYPASS } })
    : fetch(input, init);

test("a capture sealed in preview verifies as intact", async () => {
  const report = await verifyCapture(CAPTURE_ID, {
    fetch: viaPreview,
    trustedKeys: KEYS_BY_ENV.preview,
    skipKeyConsistency: true,
    origins: { bundles: ORIGIN, artifacts: "https://ev-preview.reranker.co", log: LOG },
    signal: AbortSignal.timeout(30_000),
  });
  expect(report.checks).toMatchObject({
    signature: { status: "pass" },
    content: { raw: { status: "pass" } },
    log: { status: "pass" },
    consistency: { status: "pass" },
  });
  expect(["intact_dated", "intact_dating"]).toContain(report.verdict);
}, 40_000);
