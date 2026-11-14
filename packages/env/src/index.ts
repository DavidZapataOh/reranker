import { AppEnv, z } from "@reranker/schema";

export { AppEnv };

/** Any string map: Next.js types ProcessEnv with a required NODE_ENV that plain objects lack. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export type EnvIssue = { name: string; problem: "missing" | "invalid" | "forbidden" };

export class EnvValidationError extends Error {
  readonly issues: EnvIssue[];

  constructor(issues: EnvIssue[]) {
    // Names and problems only: values can be secrets and must never reach logs or the build output.
    super(`Invalid environment: ${issues.map((i) => `${i.name} (${i.problem})`).join(", ")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

// An empty value is how a dashboard stores "unset", so it counts as absent everywhere.
function present(source: EnvSource): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out;
}

function parseAppEnv(source: EnvSource): AppEnv {
  const parsed = AppEnv.safeParse(present(source).APP_ENV);
  if (parsed.success) return parsed.data;
  const problem = present(source).APP_ENV === undefined ? "missing" : "invalid";
  throw new EnvValidationError([{ name: "APP_ENV", problem }]);
}

let cached: AppEnv | undefined;

/** The only source of the runtime environment; the code never infers it from VERCEL_ENV or NODE_ENV. */
export function appEnv(source?: EnvSource): AppEnv {
  if (source) return parseAppEnv(source);
  cached ??= parseAppEnv(process.env);
  return cached;
}

/** Drops the cached process value so a test can change APP_ENV. */
export function resetAppEnv(): void {
  cached = undefined;
}

// requiredIn/forbiddenIn run inside defineEnv, which publishes the APP_ENV of its own source here
// so the rules never depend on process.env.
let scope: AppEnv | undefined;

type Metadata = { kind: "secret" | "config"; description?: string };

function annotate<T extends z.ZodType>(kind: Metadata["kind"], schema: T, description?: string): T {
  return schema.meta({ kind, ...(description ? { description } : {}) });
}

/** A value that must never be logged or exposed to the browser. */
export const secret = <T extends z.ZodType>(schema: T, description?: string): T =>
  annotate("secret", schema, description);

/** A non-sensitive setting. */
export const config = <T extends z.ZodType>(schema: T, description?: string): T =>
  annotate("config", schema, description);

function withMeta<W extends z.ZodType>(wrapper: W, from: z.ZodType): W {
  const meta = from.meta();
  return meta ? wrapper.meta(meta) : wrapper;
}

/** Mandatory only in the listed environments; elsewhere it may be absent but is still validated when present. */
export function requiredIn<T extends z.ZodType>(
  envs: readonly AppEnv[],
  schema: T,
): z.ZodOptional<T> {
  const required = z
    .unknown()
    .optional()
    .superRefine((value, ctx) => {
      if (value === undefined && scope !== undefined && envs.includes(scope)) {
        ctx.addIssue({ code: "custom", message: "missing" });
      }
    });
  return withMeta(required.pipe(schema.optional()) as unknown as z.ZodOptional<T>, schema);
}

/** Must be unset in the listed environments, so a test-only or foreign setting can never ship there. */
export function forbiddenIn<T extends z.ZodType>(
  envs: readonly AppEnv[],
  schema: T,
): z.ZodOptional<T> {
  const forbidden = z
    .unknown()
    .optional()
    .superRefine((value, ctx) => {
      if (value !== undefined && scope !== undefined && envs.includes(scope)) {
        ctx.addIssue({ code: "custom", message: "forbidden" });
      }
    });
  return withMeta(forbidden.pipe(schema.optional()) as unknown as z.ZodOptional<T>, schema);
}

type Fragment = z.ZodObject;
type Intersect<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void
  ? I
  : never;
type Flatten<T> = { [K in keyof T]: T[K] };
export type EnvOf<T extends readonly Fragment[]> = Flatten<
  { APP_ENV: AppEnv } & Intersect<z.output<T[number]>>
>;

/** Merges the fragments with APP_ENV and fails once, naming every variable that is missing, invalid or forbidden. */
export function defineEnv<const T extends readonly Fragment[]>(
  fragments: T,
  source: EnvSource = process.env,
): EnvOf<T> {
  const input = present(source);
  const shape = Object.assign({ APP_ENV: AppEnv }, ...fragments.map((f) => f.shape));
  const previous = scope;
  scope = AppEnv.safeParse(input.APP_ENV).data;
  try {
    // Zod skips a key that is absent from the input; an explicit undefined makes requiredIn run.
    const keyed = Object.fromEntries(Object.keys(shape).map((name) => [name, input[name]]));
    const parsed = z.object(shape).safeParse(keyed);
    if (parsed.success) return parsed.data as EnvOf<T>;
    const seen = new Set<string>();
    const issues: EnvIssue[] = [];
    for (const issue of parsed.error.issues) {
      const name = String(issue.path[0]);
      if (seen.has(name)) continue;
      seen.add(name);
      const problem =
        issue.code === "custom" && issue.message === "forbidden"
          ? "forbidden"
          : name in input && !(issue.code === "custom" && issue.message === "missing")
            ? "invalid"
            : "missing";
      issues.push({ name, problem });
    }
    throw new EnvValidationError(issues);
  } finally {
    scope = previous;
  }
}
