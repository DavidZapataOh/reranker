import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "../src/index";

const outDir = fileURLToPath(new URL("../json-schema/", import.meta.url));
const idUri = (id: string) => `https://reranker.co/schemas/${id}.json`;

// Request-side contracts are validated on the way in; everything else describes what we emit.
const ioFor = (id: string) => (/(Request|Query|Header)$/.test(id) ? "input" : "output");

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

const byIo = {
  input: z.toJSONSchema(z.globalRegistry, {
    target: "draft-2020-12",
    io: "input",
    uri: idUri,
  }).schemas,
  output: z.toJSONSchema(z.globalRegistry, {
    target: "draft-2020-12",
    io: "output",
    uri: idUri,
  }).schemas,
};

// Stale files must not survive a rename or removal.
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) {
  if (f.endsWith(".json")) rmSync(`${outDir}${f}`);
}

for (const id of Object.keys(byIo.output).sort()) {
  const schema = byIo[ioFor(id)][id];
  const doc = sortKeys({ ...schema, $id: idUri(id) });
  writeFileSync(`${outDir}${id}.json`, `${JSON.stringify(doc, null, 2)}\n`);
}
