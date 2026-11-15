import { randomBytes } from "node:crypto";
import { defineTenantFixture } from "../../src/testing";
import { isolationProbe, isolationProbeChildren } from "../probe/isolation-probe.schema";

// The composite foreign key needs a parent of the same tenant, so the fixture creates one.
export default defineTenantFixture(isolationProbeChildren, async (tenantId, tx) => {
  const [parent] = await tx
    .insert(isolationProbe)
    .values({ tenantId, label: "parent" })
    .returning({ id: isolationProbe.id });
  if (!parent) throw new Error("parent insert returned no row");
  return { tenantId, probeId: parent.id, secret: randomBytes(32) };
});
