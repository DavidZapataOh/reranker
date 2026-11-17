import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSteps, defaultRun, runSteps, runtimeBanner } from "./vercel-build.mjs";

const BUILD = { command: "pnpm", args: ["exec", "turbo", "run", "build"] };

test("never migrates, in any environment", () => {
  for (const appEnv of ["production", "preview", "development"])
    for (const isVercel of [true, false])
      assert.deepEqual(buildSteps({ appEnv, isVercel }), [BUILD]);
});

test("rejects an unknown APP_ENV", () => {
  for (const appEnv of ["prod", "staging", "Production", ""])
    assert.throws(() => buildSteps({ appEnv, isVercel: true }), /Unknown APP_ENV/);
});

test("fails the Vercel build when APP_ENV is unset", () => {
  assert.throws(
    () => buildSteps({ appEnv: undefined, isVercel: true }),
    /APP_ENV must be set on Vercel/,
  );
});

test("allows a local build without APP_ENV", () => {
  assert.deepEqual(buildSteps({ appEnv: undefined, isVercel: false }), [BUILD]);
});

test("reports why a step could not start", () => {
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(message);
  try {
    assert.equal(defaultRun("reranker-missing-binary", ["--flag"]), 1);
  } finally {
    console.error = original;
  }
  assert.match(
    errors[0],
    /Failed to start "reranker-missing-binary --flag": spawnSync reranker-missing-binary/,
  );
});

test("a failed step stops the build and returns its exit code", () => {
  const calls = [];
  const code = runSteps([BUILD, BUILD], (_command, args) => {
    calls.push(args.at(-1));
    return 3;
  });
  assert.equal(code, 3);
  assert.deepEqual(calls, ["build"]);
});

test("the banner names the node and pnpm versions the build runs on", () => {
  assert.equal(runtimeBanner("v26.13.0", "12.16.1"), "Build runtime: node v26.13.0, pnpm 12.16.1");
});
