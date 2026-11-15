import { defineTenantFixture } from "../../src/testing";
import { isolationProbe } from "../probe/isolation-probe.schema";

export default defineTenantFixture(isolationProbe, (tenantId) => ({
  tenantId,
  label: `probe of ${tenantId}`,
}));
