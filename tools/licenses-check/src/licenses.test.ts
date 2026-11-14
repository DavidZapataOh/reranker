import assert from "node:assert/strict";
import { test } from "node:test";
import { ALLOWED_LICENSES, evaluateLicenses, isLicenseAllowed } from "./licenses.ts";

const pkg = (name: string, license: string) => ({ name, versions: ["1.0.0"], license });

test("allows a permitted license", () => {
  assert.deepEqual(evaluateLicenses({ MIT: [pkg("a", "MIT")] }), []);
});

test("rejects a forbidden license", () => {
  assert.deepEqual(evaluateLicenses({ "GPL-3.0-only": [pkg("x", "GPL-3.0-only")] }), [
    { name: "x", versions: ["1.0.0"], license: "GPL-3.0-only" },
  ]);
});

test("rejects a missing license", () => {
  assert.equal(evaluateLicenses({ Unknown: [pkg("y", "Unknown")] }).length, 1);
  assert.equal(evaluateLicenses({ "": [pkg("z", "")] }).length, 1);
});

test("OR needs one permitted operand, AND needs all", () => {
  assert.equal(isLicenseAllowed("(MPL-2.0 OR Apache-2.0)", "dompurify"), true);
  assert.equal(isLicenseAllowed("(MIT OR GPL-3.0-only)", "p"), true);
  assert.equal(isLicenseAllowed("(Apache-2.0 AND MIT)", "posthog-js"), true);
  assert.equal(isLicenseAllowed("(MIT AND GPL-3.0-only)", "p"), false);
});

test("LGPL libvips is allowed only for the sharp prebuilt binaries", () => {
  assert.equal(isLicenseAllowed("LGPL-3.0-or-later", "@img/sharp-libvips-linux-x64"), true);
  assert.equal(isLicenseAllowed("LGPL-3.0-or-later", "other-lib"), false);
});

test("allowlist matches the supply-chain policy exactly", () => {
  assert.deepEqual([...ALLOWED_LICENSES].sort(), [
    "0BSD",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "BlueOak-1.0.0",
    "CC-BY-4.0",
    "CC0-1.0",
    "ISC",
    "MIT",
    "MIT-0",
    "MPL-2.0",
    "Python-2.0",
    "Unlicense",
    "Zlib",
  ]);
});
