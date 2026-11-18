import { asTenantId, type TenantId } from "@reranker/db";
import { authDb } from "@reranker/db/auth-adapter";
import { members, organizations } from "@reranker/db/schema/auth";
import { type CountryCode, isMeasurable } from "@reranker/i18n/countries";
import { AppError, isErrorCode } from "@reranker/schema";
import type { DBFieldAttribute, GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth/api";
import type { Organization, OrganizationOptions, Team } from "better-auth/plugins";
import { and, eq } from "drizzle-orm";

export const ORG_FIELDS = {
  kind: { type: "string", required: true },
  // Set null so deleting an agency never deletes its clients' data.
  parentId: {
    type: "string",
    required: false,
    references: { model: "organization", field: "id", onDelete: "set null" },
    index: true,
  },
  countryCode: { type: "string", required: true },
} satisfies Record<string, DBFieldAttribute>;

export const MEMBER_FIELDS = {
  source: { type: "string", required: true, input: false, defaultValue: "direct" },
} satisfies Record<string, DBFieldAttribute>;

const KINDS = ["house", "agency", "client"] as const;
const IMMUTABLE_FIELDS = ["kind", "parentId", "countryCode"] as const;
const SLUG_BASE_LENGTH = 40;
const SLUG_SUFFIX_LENGTH = 4;
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const PRINCIPAL_TEAM = "Principal";
// A taken slug is drawn again; four draws make a repeated collision practically impossible.
const SLUG_ATTEMPTS = 4;

/** URL slug for an organization name: ASCII, dash-separated, with a random suffix. */
export function slugFor(name: string): string {
  const base =
    name
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, SLUG_BASE_LENGTH)
      .replace(/^-+|-+$/g, "") || "negocio";
  // 252 is the largest multiple of 36 below 256; redrawing bytes above it keeps the suffix uniform.
  const suffix: string[] = [];
  while (suffix.length < SLUG_SUFFIX_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(SLUG_SUFFIX_LENGTH))) {
      if (byte < 252 && suffix.length < SLUG_SUFFIX_LENGTH) {
        suffix.push(SLUG_ALPHABET.charAt(byte % 36));
      }
    }
  }
  return `${base}-${suffix.join("")}`;
}

const invalid = (reason: string) =>
  new APIError("BAD_REQUEST", { code: "validation_failed", message: reason });

async function houseExists(): Promise<boolean> {
  const rows = await authDb
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.kind, "house"))
    .limit(1);
  return rows.length > 0;
}

async function ownsClient(userId: string): Promise<boolean> {
  const rows = await authDb
    .select({ id: organizations.id })
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.organizationId))
    .where(
      and(eq(members.userId, userId), eq(members.role, "owner"), eq(organizations.kind, "client")),
    )
    .limit(1);
  return rows.length > 0;
}

type Hooks = NonNullable<OrganizationOptions["organizationHooks"]>;

// Agencies and parent links arrive in a later version without a schema change; until then the
// hierarchy is a single house and flat client organizations.
export const hierarchyHooks = {
  async beforeCreateOrganization({ organization, user }) {
    const { kind, parentId, countryCode } = organization;
    if (!(KINDS as readonly unknown[]).includes(kind)) throw invalid("invalid_kind");
    if (kind === "agency") throw invalid("agency_disabled");
    if (parentId != null) throw invalid("parent_not_allowed");
    if (typeof countryCode !== "string" || !isMeasurable(countryCode)) {
      throw invalid("country_not_measurable");
    }
    if (kind === "house" && (await houseExists())) throw invalid("second_house");
    if (kind === "client" && (await ownsClient(user.id))) {
      throw new APIError("CONFLICT", { code: "conflict", message: "client_limit" });
    }
  },
  async beforeUpdateOrganization({ organization }) {
    if (IMMUTABLE_FIELDS.some((field) => organization[field] !== undefined)) {
      throw invalid("immutable_field");
    }
  },
} satisfies Pick<Hooks, "beforeCreateOrganization" | "beforeUpdateOrganization">;

/** The single workspace every organization starts with. */
export async function createPrincipalTeam(
  organization: Organization,
  ctx?: GenericEndpointContext,
): Promise<Team> {
  if (!ctx) throw new Error("the default team is created inside an endpoint");
  return ctx.context.adapter.create<Omit<Team, "id">, Team>({
    model: "team",
    data: { name: PRINCIPAL_TEAM, organizationId: organization.id, createdAt: new Date() },
  });
}

function toAppError(error: unknown): AppError {
  if (error instanceof APIError) {
    const code = (error.body as { code?: unknown } | undefined)?.code;
    const detail = (error.body as { message?: string } | undefined)?.message;
    return new AppError(isErrorCode(code) ? code : "internal", {
      ...(detail ? { detail } : {}),
      cause: error,
    });
  }
  return new AppError("internal", { cause: error });
}

const slugTaken = (error: unknown) =>
  error instanceof APIError &&
  (error.body as { code?: unknown } | undefined)?.code === "ORGANIZATION_ALREADY_EXISTS";

/** Creates the client organization a user owns, with its Principal team. */
export async function createClientOrganization(input: {
  userId: string;
  name: string;
  countryCode: CountryCode;
}): Promise<{ id: TenantId; slug: string }> {
  // Loaded here so the hooks and slugFor never pull in the server and its environment.
  const { auth } = await import("./server");
  for (let attempt = 1; ; attempt++) {
    try {
      // Without headers: `userId` is only honoured on a server call with no session.
      const created = await auth.api.createOrganization({
        body: {
          userId: input.userId,
          name: input.name,
          slug: slugFor(input.name),
          kind: "client",
          countryCode: input.countryCode,
          keepCurrentActiveOrganization: true,
        },
      });
      return { id: asTenantId(created.id), slug: created.slug };
    } catch (error) {
      if (slugTaken(error) && attempt < SLUG_ATTEMPTS) continue;
      throw toAppError(error);
    }
  }
}
