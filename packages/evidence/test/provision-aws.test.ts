import { KeySpec } from "@aws-sdk/client-kms";
import { ed25519 } from "@noble/curves/ed25519.js";
import { expect, test } from "vitest";
import { KEYS } from "../scripts/aws-state";
import { type Clients, provision, report } from "../scripts/provision-aws";

const ACCOUNT = "123456789012";
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const missing = (name: string) => Object.assign(new Error(name), { name });

/** An in-memory AWS account that answers the commands the reconciler sends, as AWS does. */
function fakeAws(opts: { account?: string; invisibleRoles?: number } = {}) {
  let invisible = opts.invisibleRoles ?? 0;
  const writes: string[] = [];
  const providers = new Map<string, string[]>();
  const roles = new Map<string, { trust: string; policies: Map<string, string> }>();
  const keys = new Map<string, { policy: string; publicKey: Uint8Array; created: Date }>();
  const aliases = new Map<string, string>();

  const meta = (id: string) => ({
    KeyId: id,
    Arn: `arn:aws:kms:us-east-1:${ACCOUNT}:key/${id}`,
    KeySpec: KeySpec.ECC_NIST_EDWARDS25519,
    KeyUsage: "SIGN_VERIFY",
    KeyState: "Enabled",
    CreationDate: keys.get(id)?.created,
  });
  const role = (name: string) =>
    roles.get(name) ?? Promise.reject(missing("NoSuchEntityException"));

  // biome-ignore lint/suspicious/noExplicitAny: each AWS command takes an input of its own shape.
  const handlers = new Map<string, (input: any) => unknown>([
    ["GetCallerIdentityCommand", () => ({ Account: opts.account ?? ACCOUNT })],
    [
      "GetOpenIDConnectProviderCommand",
      ({ OpenIDConnectProviderArn: arn }) =>
        providers.has(arn)
          ? { ClientIDList: providers.get(arn) }
          : Promise.reject(missing("NoSuchEntityException")),
    ],
    [
      "CreateOpenIDConnectProviderCommand",
      ({ Url, ClientIDList }) =>
        providers.set(`arn:aws:iam::${ACCOUNT}:oidc-provider/${Url.slice(8)}`, ClientIDList),
    ],
    [
      "GetRoleCommand",
      async ({ RoleName }) => ({
        Role: { AssumeRolePolicyDocument: encodeURIComponent((await role(RoleName)).trust) },
      }),
    ],
    [
      "CreateRoleCommand",
      ({ RoleName, AssumeRolePolicyDocument }) =>
        roles.set(RoleName, { trust: AssumeRolePolicyDocument, policies: new Map() }),
    ],
    [
      "GetRolePolicyCommand",
      async ({ RoleName, PolicyName }) => {
        const doc = (await role(RoleName)).policies.get(PolicyName);
        return doc
          ? { PolicyDocument: encodeURIComponent(doc) }
          : Promise.reject(missing("NoSuchEntityException"));
      },
    ],
    [
      "PutRolePolicyCommand",
      async ({ RoleName, PolicyName, PolicyDocument }) =>
        (await role(RoleName)).policies.set(PolicyName, PolicyDocument),
    ],
    [
      "DescribeKeyCommand",
      ({ KeyId }) => {
        const id = aliases.get(KeyId) ?? KeyId;
        return keys.has(id)
          ? { KeyMetadata: meta(id) }
          : Promise.reject(missing("NotFoundException"));
      },
    ],
    [
      "CreateKeyCommand",
      ({ Policy }) => {
        if (invisible-- > 0) return Promise.reject(missing("MalformedPolicyDocumentException"));
        const id = `key-${keys.size + 1}`;
        const publicKey = ed25519.getPublicKey(ed25519.utils.randomSecretKey());
        keys.set(id, { policy: Policy, publicKey, created: new Date("2026-11-20T00:00:00Z") });
        return { KeyMetadata: meta(id) };
      },
    ],
    ["CreateAliasCommand", ({ AliasName, TargetKeyId }) => aliases.set(AliasName, TargetKeyId)],
    ["GetKeyPolicyCommand", ({ KeyId }) => ({ Policy: keys.get(KeyId)?.policy })],
    [
      "GetPublicKeyCommand",
      ({ KeyId }) => ({
        PublicKey: Buffer.concat([SPKI_PREFIX, keys.get(KeyId)?.publicKey ?? new Uint8Array()]),
      }),
    ],
  ]);

  const client = {
    async send(command: { input: unknown }) {
      const name = command.constructor.name;
      const handler = handlers.get(name);
      if (!handler) throw new Error(`unexpected ${name}`);
      if (!/^(Get|Describe|Head)/.test(name)) writes.push(name);
      return handler(command.input);
    },
  };
  const aws = {
    sts: client,
    iam: client,
    kms: client,
  } as unknown as Clients;
  return { aws, writes, keys, roles };
}

const noWait = async () => {};

test("an empty account converges in one run, and a second run changes nothing", async () => {
  const fake = fakeAws();
  const first = await provision(fake.aws, { account: ACCOUNT, wait: noWait });
  expect(first.changes).toContain("create role reranker-evidence-production");
  expect(first.keys.map((k) => k.alias)).toEqual(KEYS.map((k) => k.alias));
  for (const k of first.keys) expect(Buffer.from(k.publicKey, "base64")).toHaveLength(32);
  expect(fake.roles.get("reranker-evidence-preview")?.policies.has("evidence-kms")).toBe(true);

  const second = await provision(fake.aws, { account: ACCOUNT, wait: noWait });
  expect(second.changes).toEqual([]);
  expect(second.keys).toEqual(first.keys);
});

test("a dry run reports every change and writes nothing", async () => {
  const fake = fakeAws();
  const { changes, keys } = await provision(fake.aws, { account: ACCOUNT, dryRun: true });
  expect(fake.writes).toEqual([]);
  expect(keys).toEqual([]);
  expect(changes).toContain("would create key alias/rr-capture-2026");
  expect(changes).toContain("would create OIDC provider oidc.vercel.com/davidzapataohs-projects");
});

test("a role not yet visible to KMS is retried instead of failing the run", async () => {
  const fake = fakeAws({ invisibleRoles: 2 });
  const { keys } = await provision(fake.aws, { account: ACCOUNT, wait: noWait });
  expect(keys).toHaveLength(KEYS.length);
});

test("credentials of another account are refused before anything is read", async () => {
  const fake = fakeAws({ account: "999999999999" });
  await expect(provision(fake.aws, { account: ACCOUNT })).rejects.toThrow(/another account/);
  expect(fake.writes).toEqual([]);
});

test("the report lists registry entries ready to pin and no secrets", async () => {
  const fake = fakeAws();
  const outcome = await provision(fake.aws, { account: ACCOUNT, wait: noWait });
  const markdown = report(ACCOUNT, outcome);
  const entry = JSON.parse(markdown.split("\n").find((l) => l.includes('"rr-log-2026-1"')) ?? "");
  expect(entry).toMatchObject({
    purpose: "log",
    env: "production",
    custody: "aws-kms-hsm",
    validTo: null,
  });
  expect(markdown).toContain(`arn:aws:iam::${ACCOUNT}:role/reranker-evidence-production`);
});
