import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { expect, test } from "vitest";

const dir = fileURLToPath(new URL("../json-schema/", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
const read = (f: string) => JSON.parse(readFileSync(`${dir}${f}`, "utf8"));
const ajv = addFormats.default(new Ajv2020({ strict: true }));

test("artifacts exist for the V0 contracts", () => {
  expect(files).toEqual(
    expect.arrayContaining(["Money.json", "ProviderCost.json", "ProblemDetails.json"]),
  );
});

test.each(files)("%s metavalidates as 2020-12 with the public $id", (f) => {
  const s = read(f);
  expect(ajv.validateSchema(s)).toBe(true);
  expect(s.$id).toBe(`https://reranker.co/schemas/${f}`);
  expect(s.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
});

test("Money.json validates like MoneySchema", () => {
  for (const f of files) ajv.addSchema(read(f));
  const v = ajv.getSchema("https://reranker.co/schemas/Money.json");
  expect(v).toBeDefined();
  expect(v?.({ amount_minor: 1.5, currency: "COP" })).toBe(false);
  expect(v?.({ amount_minor: 14_900_000, currency: "COP" })).toBe(true);
});
