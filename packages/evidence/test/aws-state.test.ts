import { expect, test } from "vitest";
import {
  bucketPolicy,
  KEYS,
  type KeySpec,
  keyPolicy,
  ROLES,
  type RoleSpec,
  rolePolicy,
  samePolicy,
  trustPolicy,
} from "../scripts/aws-state";

const ACCOUNT = "123456789012";
const role = (name: string) => ROLES.find((r) => r.name === name) as RoleSpec;
const key = (alias: string) => KEYS.find((k) => k.alias === alias) as KeySpec;
const arn = (name: string) => `arn:aws:iam::${ACCOUNT}:role/${name}`;
const list = (value: unknown) => [value].flat().map(String);

interface Statement {
  Principal: { AWS: unknown };
  Action: unknown;
  Resource: unknown;
  Condition: Record<string, Record<string, unknown>>;
}
const statement = (policy: { Statement: { Sid?: string }[] }, sid: string) =>
  policy.Statement.find((s) => s.Sid === sid) as unknown as Statement;

test("only the production deployment role can sign with the production keys", () => {
  for (const alias of ["alias/rr-capture-2026", "alias/rr-log-2026"]) {
    const policy = keyPolicy(ACCOUNT, key(alias));
    const sign = statement(policy, "SignEvidence");
    expect(list(sign.Principal.AWS)).toEqual([arn("reranker-evidence-production")]);
    expect(sign.Condition).toEqual({
      StringEquals: { "kms:SigningAlgorithm": "ED25519_SHA_512", "kms:MessageType": "RAW" },
    });
    const deny = statement(policy, "DenySigningToEveryoneElse");
    expect(deny).toMatchObject({ Effect: "Deny", Action: "kms:Sign" });
    expect(list(deny.Condition.ArnNotEquals?.["aws:PrincipalArn"])).toEqual([
      arn("reranker-evidence-production"),
    ]);
    expect(JSON.stringify(policy)).not.toContain("preview");
  }
});

test("preview keys are signed by preview roles only, and the CI role reaches the capture key", () => {
  const capture = keyPolicy(ACCOUNT, key("alias/rr-capture-2026-preview"));
  expect(list(statement(capture, "SignEvidence").Principal.AWS).sort()).toEqual([
    arn("reranker-ci-kms-preview"),
    arn("reranker-evidence-preview"),
  ]);
  const log = keyPolicy(ACCOUNT, key("alias/rr-log-2026-preview"));
  expect(list(statement(log, "SignEvidence").Principal.AWS)).toEqual([
    arn("reranker-evidence-preview"),
  ]);
  for (const policy of [capture, log]) {
    expect(JSON.stringify(policy)).not.toContain("reranker-evidence-production");
  }
});

test("account administration never includes signing", () => {
  const admin = statement(keyPolicy(ACCOUNT, KEYS[0] as KeySpec), "KeyAdministration");
  expect(admin.Principal).toEqual({ AWS: `arn:aws:iam::${ACCOUNT}:root` });
  expect(list(admin.Action).some((a) => /^kms:(Sign|\*)/.test(a))).toBe(false);
});

test("each Vercel role trusts exactly its project environments under the team audience", () => {
  const host = "oidc.vercel.com/davidzapataohs-projects";
  const prod = trustPolicy(ACCOUNT, role("reranker-evidence-production")).Statement[0];
  expect(prod?.Principal.Federated).toBe(`arn:aws:iam::${ACCOUNT}:oidc-provider/${host}`);
  expect(prod?.Condition.StringEquals).toEqual({
    [`${host}:aud`]: "https://vercel.com/davidzapataohs-projects",
    [`${host}:sub`]: "owner:davidzapataohs-projects:project:reranker:environment:production",
  });
  const preview = trustPolicy(ACCOUNT, role("reranker-evidence-preview")).Statement[0];
  expect(preview?.Condition.StringEquals[`${host}:sub`]).toEqual([
    "owner:davidzapataohs-projects:project:reranker:environment:preview",
    "owner:davidzapataohs-projects:project:reranker:environment:development",
  ]);
  const ci = trustPolicy(ACCOUNT, role("reranker-ci-kms-preview")).Statement[0];
  expect(ci?.Condition.StringEquals).toEqual({
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub":
      "repo:DavidZapataOh@37819456/reranker@1446098352:ref:refs/heads/main",
  });
});

test("role policies name their own environment's key ARNs, and only production reads the trail", () => {
  const arns = new Map(
    KEYS.map((k) => [k.alias, `arn:aws:kms:us-east-1:${ACCOUNT}:key/${k.keyid}`]),
  );
  const prod = rolePolicy(ACCOUNT, role("reranker-evidence-production"), arns);
  expect(JSON.stringify(prod)).not.toContain("preview");
  expect(prod.Statement.map((s) => s.Action)).toEqual([
    "kms:Sign",
    "kms:GetPublicKey",
    "cloudtrail:GetTrailStatus",
    "s3:ListBucket",
  ]);
  const ci = rolePolicy(ACCOUNT, role("reranker-ci-kms-preview"), arns);
  expect(ci.Statement[0]?.Resource).toBe(arns.get("alias/rr-capture-2026-preview"));
  expect(ci.Statement).toHaveLength(2);
});

test("only this trail may write into the audit bucket, under the account prefix", () => {
  const policy = bucketPolicy(ACCOUNT);
  const write = statement(policy, "AWSCloudTrailWrite20150319");
  expect(write.Resource).toBe(`arn:aws:s3:::rr-cloudtrail-${ACCOUNT}/AWSLogs/${ACCOUNT}/*`);
  expect(write.Condition).toEqual({
    StringEquals: {
      "s3:x-amz-acl": "bucket-owner-full-control",
      "aws:SourceArn": `arn:aws:cloudtrail:us-east-1:${ACCOUNT}:trail/reranker-audit`,
    },
  });
});

test("policies compare equal regardless of key order, URL encoding and one-element arrays", () => {
  const wanted = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["s3:Get"] }] };
  const returned = encodeURIComponent(
    '{"Statement":{"Action":"s3:Get","Effect":"Allow"},"Version":"2012-10-17"}',
  );
  expect(samePolicy(returned, wanted)).toBe(true);
  expect(samePolicy(JSON.stringify({ ...wanted, Version: "2008-10-17" }), wanted)).toBe(false);
  expect(samePolicy(undefined, wanted)).toBe(false);
});
