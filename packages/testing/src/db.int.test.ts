import pg from "pg";
import { expect, it } from "vitest";
import { expectNoSeqScanOn, explain, explainGeneric } from "./db.ts";
import { getTestDatabaseUrl } from "./neon.ts";

it("detects Seq Scan without an index and Index Scan with one", async () => {
  const client = new pg.Client(getTestDatabaseUrl("migrations"));
  await client.connect();
  try {
    await client.query(
      "create temp table explain_probe as select g as id, md5(g::text) as v from generate_series(1, 100000) g",
    );
    await client.query("analyze explain_probe");
    const seq = await explain(client, "select * from explain_probe where id = $1", [42]);
    expect(() => expectNoSeqScanOn(seq, "explain_probe")).toThrow();
    await client.query("create index on explain_probe (id)");
    await client.query("analyze explain_probe");
    expectNoSeqScanOn(
      await explain(client, "select * from explain_probe where id = $1", [42]),
      "explain_probe",
    );
  } finally {
    await client.end();
  }
});

it("reads the generic plan of a statement with placeholders", async () => {
  const client = new pg.Client(getTestDatabaseUrl("migrations"));
  await client.connect();
  try {
    await client.query(
      "create temp table generic_probe as select g as id from generate_series(1, 100000) g",
    );
    await client.query("analyze generic_probe");
    const query = "select * from generic_probe where id = $1::int";
    const seq = await explainGeneric(client, query);
    expect(() => expectNoSeqScanOn(seq, "generic_probe")).toThrow();
    await client.query("create index on generic_probe (id)");
    await client.query("analyze generic_probe");
    expectNoSeqScanOn(await explainGeneric(client, query), "generic_probe");
  } finally {
    await client.end();
  }
});
