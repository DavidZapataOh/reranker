// Writes the shared report vectors. A published vector is a contract with the V2 service: an
// output may only change under a new methodology version, and only with --force.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { methodology } from "../src/methodology";
import { buildVectors, type Vector } from "./vectors";

const dir = fileURLToPath(new URL("../test-vectors/reports/", import.meta.url));
const force = process.argv.includes("--force");
const errors: string[] = [];

function readPublished(path: string): Vector | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

mkdirSync(dir, { recursive: true });
for (const [name, vector] of buildVectors()) {
  const path = `${dir}${name}.json`;
  const published = readPublished(path);
  if (published !== null) {
    // Compared as values, so reformatting a file never counts as a change.
    if (JSON.stringify(published) === JSON.stringify(vector)) {
      console.log(`${name}: unchanged`);
      continue;
    }
    if (!force) {
      errors.push(`${name}: differs from the published vector; rerun with --force`);
      continue;
    }
    if (published.methodologyVersion === methodology.version) {
      errors.push(
        `${name}: differs under methodology ${methodology.version}; a change needs a new version`,
      );
      continue;
    }
  }
  // A new vector is created exclusively, so one written meanwhile is never overwritten unread.
  writeFileSync(path, `${JSON.stringify(vector, null, 2)}\n`, {
    flag: published === null ? "wx" : "w",
  });
  console.log(`${name}: written`);
}

if (errors.length > 0) {
  for (const e of errors) console.error(e);
  process.exitCode = 1;
}
