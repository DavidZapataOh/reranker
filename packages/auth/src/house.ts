import { asTenantId, type TenantId, withSystem } from "@reranker/db";
import { organizations, users } from "@reranker/db/schema/auth";
import { DEFAULT_COUNTRY_CODE } from "@reranker/i18n/countries";
import { AppError } from "@reranker/schema";
import { eq } from "drizzle-orm";
import { slugFor } from "./organizations";

const HOUSE_NAME = "Reranker";

async function findHouse(): Promise<TenantId | undefined> {
  const [row] = await withSystem("auth.house", (tx) =>
    tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.kind, "house"))
      .limit(1),
  );
  return row ? asTenantId(row.id) : undefined;
}

/**
 * Creates the house organization, which owns every report and lead made before sign-up, with the
 * given user as its owner. Idempotent: an existing house is returned as is, with `created: false`.
 */
export async function provisionHouseOrganization(input: {
  ownerEmail: string;
}): Promise<{ id: TenantId; created: boolean }> {
  const email = input.ownerEmail.trim().toLowerCase();
  const [owner] = await withSystem("auth.house", (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1),
  );
  if (!owner) throw new AppError("not_found", { detail: "the house owner has never signed in" });

  const existing = await findHouse();
  if (existing) return { id: existing, created: false };

  // Loaded here so readers of the house id never pull in the server and its environment.
  const { auth } = await import("./server");
  const created = await auth.api.createOrganization({
    body: {
      userId: owner.id,
      name: HOUSE_NAME,
      slug: slugFor(HOUSE_NAME),
      kind: "house",
      countryCode: DEFAULT_COUNTRY_CODE,
      keepCurrentActiveOrganization: true,
    },
  });
  return { id: asTenantId(created.id), created: true };
}

let house: Promise<TenantId> | undefined;

/** The house tenant id, read once per instance: the house never changes once provisioned. */
export function getHouseTenantId(): Promise<TenantId> {
  if (house) return house;
  const pending = findHouse().then((id) => {
    if (!id) throw new AppError("internal", { detail: "the house organization is missing" });
    return id;
  });
  house = pending;
  // A failed read is forgotten so the next call asks the database again.
  pending.catch(() => {
    if (house === pending) house = undefined;
  });
  return pending;
}
