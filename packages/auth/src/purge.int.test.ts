import { endPools, withSystem } from "@reranker/db";
import {
  invitations,
  organizations,
  rateLimits,
  sessions,
  users,
  verifications,
} from "@reranker/db/schema/auth";
import { DEFAULT_COUNTRY_CODE } from "@reranker/i18n/countries";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "vitest";
import { purgeExpiredAuthRecords } from "./purge";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);

const userIds: string[] = [];
const organizationIds: string[] = [];

async function createUser(): Promise<string> {
  const id = crypto.randomUUID();
  await withSystem("test.seed", (tx) =>
    tx.insert(users).values({ id, name: "Purge", email: `purge+${id}@resend.dev` }),
  );
  userIds.push(id);
  return id;
}

async function createOrganization(): Promise<string> {
  const id = crypto.randomUUID();
  await withSystem("test.seed", (tx) =>
    tx.insert(organizations).values({
      id,
      name: "Purge",
      slug: `purge-${id}`,
      kind: "client",
      countryCode: DEFAULT_COUNTRY_CODE,
      createdAt: new Date(),
    }),
  );
  organizationIds.push(id);
  return id;
}

async function seedSession(userId: string, expiresAt: Date): Promise<string> {
  const id = crypto.randomUUID();
  await withSystem("test.seed", (tx) =>
    tx.insert(sessions).values({ id, userId, expiresAt, token: id, updatedAt: new Date() }),
  );
  return id;
}

async function seedVerification(expiresAt: Date): Promise<string> {
  const id = crypto.randomUUID();
  await withSystem("test.seed", (tx) =>
    tx.insert(verifications).values({ id, identifier: `purge-${id}`, value: "x", expiresAt }),
  );
  return id;
}

async function seedRateLimit(lastRequest: Date): Promise<string> {
  const id = crypto.randomUUID();
  await withSystem("test.seed", (tx) =>
    tx
      .insert(rateLimits)
      .values({ id, key: `purge-${id}`, count: 1, lastRequest: lastRequest.getTime() }),
  );
  return id;
}

async function seedInvitation(
  organizationId: string,
  inviterId: string,
  status: string,
  expiresAt: Date,
): Promise<string> {
  const id = crypto.randomUUID();
  await withSystem("test.seed", (tx) =>
    tx.insert(invitations).values({
      id,
      organizationId,
      inviterId,
      email: `invitee+${id}@resend.dev`,
      role: "member",
      status,
      expiresAt,
    }),
  );
  return id;
}

async function remaining(
  table: typeof sessions | typeof verifications | typeof rateLimits | typeof invitations,
  ids: string[],
): Promise<string[]> {
  const rows = await withSystem("test.read", (tx) =>
    tx.select({ id: table.id }).from(table).where(inArray(table.id, ids)),
  );
  return rows.map((row) => row.id).sort();
}

beforeAll(async () => {
  // The branch may inherit expired rows from its parent; they must not count against this run.
  await purgeExpiredAuthRecords();
});

afterAll(async () => {
  await withSystem("test.cleanup", async (tx) => {
    await tx.delete(users).where(inArray(users.id, userIds));
    await tx.delete(organizations).where(inArray(organizations.id, organizationIds));
  });
  await endPools();
});

test("removes only records past their retention and is idempotent", async () => {
  const userId = await createUser();
  const organizationId = await createOrganization();

  const oldSession = await seedSession(userId, ago(31 * DAY));
  const recentSession = await seedSession(userId, ago(29 * DAY));
  const oldVerification = await seedVerification(ago(25 * HOUR));
  const recentVerification = await seedVerification(ago(23 * HOUR));
  const oldRateLimit = await seedRateLimit(ago(25 * HOUR));
  const recentRateLimit = await seedRateLimit(ago(HOUR));
  const oldInvitation = await seedInvitation(organizationId, userId, "accepted", ago(91 * DAY));
  const recentInvitation = await seedInvitation(organizationId, userId, "canceled", ago(89 * DAY));
  const openInvitation = await seedInvitation(
    organizationId,
    userId,
    "pending",
    new Date(Date.now() + DAY),
  );

  expect(await purgeExpiredAuthRecords()).toEqual({
    sessions: 1,
    verifications: 1,
    rateLimits: 1,
  });

  expect(await remaining(sessions, [oldSession, recentSession])).toEqual([recentSession]);
  expect(await remaining(verifications, [oldVerification, recentVerification])).toEqual([
    recentVerification,
  ]);
  expect(await remaining(rateLimits, [oldRateLimit, recentRateLimit])).toEqual([recentRateLimit]);
  expect(await remaining(invitations, [oldInvitation, recentInvitation, openInvitation])).toEqual(
    [recentInvitation, openInvitation].sort(),
  );

  expect(await purgeExpiredAuthRecords()).toEqual({ sessions: 0, verifications: 0, rateLimits: 0 });
});

test("a backlog larger than one batch is removed in full", async () => {
  const seeded = await Promise.all([1, 2, 3].map(() => seedVerification(ago(2 * DAY))));

  expect(await purgeExpiredAuthRecords({ batchSize: 2 })).toMatchObject({ verifications: 3 });
  expect(await remaining(verifications, seeded)).toEqual([]);
});
