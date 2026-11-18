import { parseArgs } from "node:util";
import { endPools } from "@reranker/db";
import { provisionHouseOrganization } from "../src/house";

const { values } = parseArgs({ options: { "owner-email": { type: "string" } } });
const ownerEmail = values["owner-email"];
if (!ownerEmail) {
  console.error("Usage: provision:house --owner-email <email>");
  process.exit(1);
}

try {
  const { id } = await provisionHouseOrganization({ ownerEmail });
  console.log(id);
} finally {
  await endPools();
}
