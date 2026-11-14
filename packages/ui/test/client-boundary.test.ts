import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { clientModules, clientModulesReachableFrom } from "./client-graph.ts";

const serverOnly = [
  "data/ScoreNumber",
  "data/ScoreRule",
  "data/StepBars",
  "data/DotSample",
  "data/StatusBadge",
  "conversation/Bubble",
  "conversation/EngineMark",
  "conversation/Highlight",
  "evidence/EvidenceSeal",
  "feedback/Skeleton",
  "feedback/LoadingState",
  "feedback/EmptyState",
  "feedback/ErrorState",
  "feedback/Notice",
  "feedback/ExampleChip",
];

test("server-only components never reach a client module except the help sheet", async () => {
  expect(await clientModulesReachableFrom(serverOnly, { allow: ["help/Sheet"] })).toEqual([]);
});

test("the client islands are exactly the known list", async () => {
  expect(await clientModules()).toEqual(["forms/CodeField.tsx", "help/Sheet.tsx", "help/Term.tsx"]);
});

test("the guard follows extensionless imports, index re-exports and side-effect imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "client-graph-"));
  await mkdir(join(root, "lib"));
  await writeFile(join(root, "entry.tsx"), 'import "./lib";\nexport const a = 1;\n');
  await writeFile(join(root, "lib/index.ts"), 'export * from "./deep";\n');
  await writeFile(
    join(root, "lib/deep.ts"),
    '"use client";\nimport "../island";\nexport const d = 1;\n',
  );
  await writeFile(join(root, "island.ts"), '// header\n"use client";\nexport const i = 1;\n');
  expect(await clientModulesReachableFrom(["entry"], { root })).toEqual([
    "island.ts",
    "lib/deep.ts",
  ]);
  expect(await clientModulesReachableFrom(["entry"], { root, allow: ["lib/deep"] })).toEqual([]);
});
