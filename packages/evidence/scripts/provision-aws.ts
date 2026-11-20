import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  AddClientIDToOpenIDConnectProviderCommand,
  CreateOpenIDConnectProviderCommand,
  CreateRoleCommand,
  GetOpenIDConnectProviderCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  IAMClient,
  PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  CreateAliasCommand,
  CreateKeyCommand,
  DescribeKeyCommand,
  GetKeyPolicyCommand,
  GetPublicKeyCommand,
  type KeyMetadata,
  KMSClient,
  KeySpec as KmsKeySpec,
  PutKeyPolicyCommand,
} from "@aws-sdk/client-kms";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import {
  ISSUERS,
  KEYS,
  type KeySpec,
  keyPolicy,
  providerArn,
  REGION,
  ROLE_POLICY,
  ROLES,
  roleArn,
  rolePolicy,
  samePolicy,
  TAGS,
  trustPolicy,
} from "./aws-state.ts";

export interface Clients {
  sts: Pick<STSClient, "send">;
  iam: Pick<IAMClient, "send">;
  kms: Pick<KMSClient, "send">;
}

const MISSING = new Set(["NoSuchEntityException", "NotFoundException"]);

/** The resource, or undefined when AWS answers that it does not exist. */
async function find<T>(call: () => Promise<T>): Promise<T | undefined> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof Error && MISSING.has(error.name)) return undefined;
    throw error;
  }
}

export interface ObservedKey extends KeySpec {
  arn: string;
  /** Base64 of the raw 32-byte Ed25519 public key. */
  publicKey: string;
  validFrom: string;
}

export interface Outcome {
  changes: string[];
  keys: ObservedKey[];
}

const json = JSON.stringify;
const ED25519_PUBLIC_KEY_BYTES = 32;
const VISIBILITY_ATTEMPTS = 8;

interface Context {
  aws: Clients;
  account: string;
  apply(what: string, write: () => Promise<unknown>): Promise<void>;
  wait(ms: number): Promise<unknown>;
}

/** The Vercel and GitHub OIDC providers and the roles that trust them. */
async function identity({ aws, account, apply }: Context): Promise<void> {
  for (const { host, audience } of Object.values(ISSUERS)) {
    const arn = providerArn(account, host);
    const provider = await find(() =>
      aws.iam.send(new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: arn })),
    );
    if (!provider) {
      await apply(`create OIDC provider ${host}`, () =>
        aws.iam.send(
          new CreateOpenIDConnectProviderCommand({
            Url: `https://${host}`,
            ClientIDList: [audience],
            Tags: TAGS,
          }),
        ),
      );
    } else if (!provider.ClientIDList?.includes(audience)) {
      await apply(`add audience ${audience} to ${host}`, () =>
        aws.iam.send(
          new AddClientIDToOpenIDConnectProviderCommand({
            OpenIDConnectProviderArn: arn,
            ClientID: audience,
          }),
        ),
      );
    }
  }

  for (const role of ROLES) {
    const trust = trustPolicy(account, role);
    const current = await find(() => aws.iam.send(new GetRoleCommand({ RoleName: role.name })));
    if (!current) {
      await apply(`create role ${role.name}`, () =>
        aws.iam.send(
          new CreateRoleCommand({
            RoleName: role.name,
            Description: role.description,
            AssumeRolePolicyDocument: json(trust),
            Tags: TAGS,
          }),
        ),
      );
    } else if (!samePolicy(current.Role?.AssumeRolePolicyDocument, trust)) {
      await apply(`update the trust policy of ${role.name}`, () =>
        aws.iam.send(
          new UpdateAssumeRolePolicyCommand({ RoleName: role.name, PolicyDocument: json(trust) }),
        ),
      );
    }
  }
}

/** The four signing keys, then each role's permission to use its environment's keys. */
async function signingKeys({ aws, account, apply, wait }: Context): Promise<ObservedKey[]> {
  // KMS rejects a role created moments ago as an invalid principal until IAM propagates it.
  const onceVisible = async <T>(write: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await write();
      } catch (error) {
        const propagating =
          error instanceof Error && error.name === "MalformedPolicyDocumentException";
        if (!propagating || attempt === VISIBILITY_ATTEMPTS) throw error;
        await wait(10_000);
      }
    }
  };
  const keyArns = new Map<string, string>();
  const keys: ObservedKey[] = [];
  for (const key of KEYS) {
    const wanted = keyPolicy(account, key);
    let meta: KeyMetadata | undefined = (
      await find(() => aws.kms.send(new DescribeKeyCommand({ KeyId: key.alias })))
    )?.KeyMetadata;
    if (!meta) {
      await apply(`create key ${key.alias}`, async () => {
        const created = await onceVisible(() =>
          aws.kms.send(
            new CreateKeyCommand({
              KeySpec: KmsKeySpec.ECC_NIST_EDWARDS25519,
              KeyUsage: "SIGN_VERIFY",
              Description: `Signs reranker ${key.purpose} evidence in ${key.env} as ${key.keyid}`,
              Policy: json(wanted),
              Tags: [
                { TagKey: "app", TagValue: "reranker" },
                { TagKey: "env", TagValue: key.env },
                { TagKey: "keyid", TagValue: key.keyid },
              ],
            }),
          ),
        );
        meta = created.KeyMetadata;
        await aws.kms.send(
          new CreateAliasCommand({ AliasName: key.alias, TargetKeyId: meta?.KeyId }),
        );
      });
    } else {
      const { KeySpec, KeyUsage, KeyState, KeyId } = meta;
      if (
        KeySpec !== KmsKeySpec.ECC_NIST_EDWARDS25519 ||
        KeyUsage !== "SIGN_VERIFY" ||
        KeyState !== "Enabled"
      ) {
        throw new Error(`${key.alias} is ${KeySpec} ${KeyUsage} ${KeyState}, not Ed25519 signing`);
      }
      const current = await aws.kms.send(new GetKeyPolicyCommand({ KeyId, PolicyName: "default" }));
      if (!samePolicy(current.Policy, wanted)) {
        await apply(`update the key policy of ${key.alias}`, () =>
          onceVisible(() =>
            aws.kms.send(
              new PutKeyPolicyCommand({ KeyId, PolicyName: "default", Policy: json(wanted) }),
            ),
          ),
        );
      }
    }
    if (!meta?.Arn || !meta.CreationDate) continue;
    keyArns.set(key.alias, meta.Arn);
    const { PublicKey } = await aws.kms.send(new GetPublicKeyCommand({ KeyId: meta.KeyId }));
    if (!PublicKey) throw new Error(`${key.alias} returned no public key`);
    // The DER SubjectPublicKeyInfo of an Ed25519 key ends with the raw key (RFC 8410).
    const raw = Buffer.from(PublicKey).subarray(-ED25519_PUBLIC_KEY_BYTES).toString("base64");
    keys.push({
      ...key,
      arn: meta.Arn,
      publicKey: raw,
      validFrom: meta.CreationDate.toISOString(),
    });
  }

  for (const role of ROLES) {
    const wanted = rolePolicy(account, role, keyArns);
    const current = await find(() =>
      aws.iam.send(new GetRolePolicyCommand({ RoleName: role.name, PolicyName: ROLE_POLICY })),
    );
    if (!samePolicy(current?.PolicyDocument, wanted)) {
      await apply(`put policy ${ROLE_POLICY} on ${role.name}`, () =>
        aws.iam.send(
          new PutRolePolicyCommand({
            RoleName: role.name,
            PolicyName: ROLE_POLICY,
            PolicyDocument: json(wanted),
          }),
        ),
      );
    }
  }
  return keys;
}

/**
 * Brings the AWS evidence infrastructure to the declared state and returns what changed with the
 * keys it observed. A dry run reads everything and writes nothing.
 */
export async function provision(
  aws: Clients,
  opts: { account: string; dryRun?: boolean; wait?: (ms: number) => Promise<unknown> },
): Promise<Outcome> {
  const { account, dryRun = false, wait = sleep } = opts;
  const changes: string[] = [];
  const apply = async (what: string, write: () => Promise<unknown>) => {
    changes.push(dryRun ? `would ${what}` : what);
    if (!dryRun) await write();
  };
  const caller = await aws.sts.send(new GetCallerIdentityCommand({}));
  if (caller.Account !== account) throw new Error("the credentials belong to another account");

  const context: Context = { aws, account, apply, wait };
  await identity(context);
  return { changes, keys: await signingKeys(context) };
}

/** The observed resources and the registry entries to pin, as Markdown for the job summary. */
export function report(account: string, outcome: Outcome): string {
  const entries = outcome.keys.map((k) =>
    json({
      keyid: k.keyid,
      purpose: k.purpose,
      env: k.env,
      alg: "Ed25519",
      publicKey: k.publicKey,
      custody: "aws-kms-hsm",
      validFrom: k.validFrom,
      validTo: null,
      compromisedAfter: null,
    }),
  );
  return [
    "## AWS evidence infrastructure",
    "",
    ...ROLES.map((r) => `- Role \`${roleArn(account, r.name)}\``),
    ...outcome.keys.map((k) => `- Key \`${k.alias}\`: \`${k.arn}\``),
    "",
    "Registry entries:",
    "",
    "```",
    ...entries,
    "```",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const account = process.env.AWS_ACCOUNT_ID ?? "";
  if (!/^\d{12}$/.test(account)) throw new Error("AWS_ACCOUNT_ID must be a 12-digit account id");
  const dryRun = process.argv.includes("--dry-run");
  const config = { region: REGION };
  const outcome = await provision(
    {
      sts: new STSClient(config),
      iam: new IAMClient(config),
      kms: new KMSClient(config),
    },
    { account, dryRun },
  );
  console.log(outcome.changes.length > 0 ? outcome.changes.join("\n") : "unchanged");
  const summary = report(account, outcome);
  console.log(`\n${summary}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
