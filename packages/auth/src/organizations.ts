import type { DBFieldAttribute } from "better-auth";

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
