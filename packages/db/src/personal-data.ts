export type PersonalDataEntry = {
  schema: "app" | "auth";
  table: string;
  column: string;
  category: "identifier" | "contact" | "network" | "content";
  purpose: string;
  retention: string;
  erasure: "cascade" | "anonymize" | "job";
};

const ACCOUNT_LIFETIME = "Lifetime of the account";

/** Every column that holds personal data (Ley 1581), with why it is kept and how it is erased. */
export const PERSONAL_DATA = [
  {
    schema: "auth",
    table: "users",
    column: "email",
    category: "contact",
    purpose: "Sign-in and account email",
    retention: ACCOUNT_LIFETIME,
    erasure: "cascade",
  },
  {
    schema: "auth",
    table: "users",
    column: "name",
    category: "identifier",
    purpose: "Name shown in the account",
    retention: ACCOUNT_LIFETIME,
    erasure: "cascade",
  },
  {
    schema: "auth",
    table: "users",
    column: "image",
    category: "identifier",
    purpose: "Profile picture from Google",
    retention: ACCOUNT_LIFETIME,
    erasure: "cascade",
  },
  {
    schema: "auth",
    table: "users",
    column: "data_policy_version",
    category: "content",
    purpose: "Proof of the data authorization the user accepted",
    retention: ACCOUNT_LIFETIME,
    erasure: "cascade",
  },
  {
    schema: "auth",
    table: "users",
    column: "data_policy_accepted_at",
    category: "content",
    purpose: "Proof of when the user accepted the data authorization",
    retention: ACCOUNT_LIFETIME,
    erasure: "cascade",
  },
  {
    schema: "auth",
    table: "organizations",
    column: "name",
    category: "identifier",
    purpose: "Business name, which can be the owner's own name",
    retention: "Lifetime of the organization",
    erasure: "cascade",
  },
  {
    schema: "auth",
    table: "sessions",
    column: "ip_address",
    category: "network",
    purpose: "Open sessions list and abuse detection",
    retention: "30 days after the session expires",
    erasure: "job",
  },
  {
    schema: "auth",
    table: "sessions",
    column: "user_agent",
    category: "network",
    purpose: "Device shown in the open sessions list",
    retention: "30 days after the session expires",
    erasure: "job",
  },
  {
    schema: "auth",
    table: "accounts",
    column: "access_token",
    category: "identifier",
    purpose: "Google sign-in (openid email profile only)",
    retention: ACCOUNT_LIFETIME,
    erasure: "cascade",
  },
  {
    schema: "auth",
    table: "accounts",
    column: "refresh_token",
    category: "identifier",
    purpose: "Google sign-in (openid email profile only)",
    retention: ACCOUNT_LIFETIME,
    erasure: "cascade",
  },
  {
    schema: "auth",
    table: "accounts",
    column: "id_token",
    category: "identifier",
    purpose: "Google sign-in (openid email profile only)",
    retention: ACCOUNT_LIFETIME,
    erasure: "cascade",
  },
  {
    schema: "auth",
    table: "verifications",
    column: "identifier",
    category: "contact",
    purpose: "Email the sign-in code was sent to",
    retention: "Until the code expires, plus 1 day",
    erasure: "job",
  },
  {
    schema: "auth",
    table: "verifications",
    column: "value",
    category: "content",
    purpose: "Encrypted sign-in code",
    retention: "Until the code expires, plus 1 day",
    erasure: "job",
  },
  {
    schema: "auth",
    table: "rate_limits",
    column: "key",
    category: "network",
    purpose: "Per-IP request counters that stop brute force",
    retention: "24 hours",
    erasure: "job",
  },
  {
    schema: "auth",
    table: "invitations",
    column: "email",
    category: "contact",
    purpose: "Email of an invited member",
    retention: "90 days after the invitation closes",
    erasure: "job",
  },
] as const satisfies readonly PersonalDataEntry[];
