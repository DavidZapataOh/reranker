import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSteps, runSteps, runtimeBanner } from "./vercel-build.mjs";

const MIGRATE = { command: "pnpm", args: ["--filter", "@reranker/db", "db:migrate"] };
const BUILD = { command: "pnpm", args: ["exec", "turbo", "run", "build"] };

test("migrates before building in production and preview", () => {
  for (const appEnv of ["production", "preview"])
    assert.deepEqual(buildSteps({ appEnv, hasDatabasePackage: true }), [MIGRATE, BUILD]);
});

test("only builds in development, without APP_ENV, or without a database package", () => {
  assert.deepEqual(buildSteps({ appEnv: "development", hasDatabasePackage: true }), [BUILD]);
  assert.deepEqual(buildSteps({ appEnv: undefined, hasDatabasePackage: true }), [BUILD]);
  assert.deepEqual(buildSteps({ appEnv: "production", hasDatabasePackage: false }), [BUILD]);
});

test("rejects an unknown APP_ENV instead of skipping the migration", () => {
  for (const appEnv of ["prod", "staging", "Production", ""])
    assert.throws(() => buildSteps({ appEnv, hasDatabasePackage: true }), /Unknown APP_ENV/);
});

test("a failed migration stops the build and returns its exit code", () => {
  const calls = [];
  const code = runSteps([MIGRATE, BUILD], (_command, args) => {
    calls.push(args.at(-1));
    return args.includes("db:migrate") ? 3 : 0;
  });
  assert.equal(code, 3);
  assert.deepEqual(calls, ["db:migrate"]);
});

test("the banner names the node and pnpm versions the build runs on", () => {
  assert.equal(runtimeBanner("v26.13.0", "12.16.1"), "Build runtime: node v26.13.0, pnpm 12.16.1");
});
