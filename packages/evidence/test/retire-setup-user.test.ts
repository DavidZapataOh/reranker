import { expect, test } from "vitest";
import { grant, RETIRE_POLICY, retire, retirePolicy } from "../scripts/retire-setup-user";

const ACCOUNT = "123456789012";
const USER_ARN = `arn:aws:iam::${ACCOUNT}:user/reranker-setup`;
const ROLE_SESSION = `arn:aws:sts::${ACCOUNT}:assumed-role/reranker-ci-kms-preview/GitHubActions`;
const failure = (name: string) => Object.assign(new Error(name), { name });

/** An IAM account holding the setup user, answering as IAM does, recording every call. */
function account(opts: { userExists?: boolean; deniedFor?: number } = {}) {
  let exists = opts.userExists ?? true;
  let denied = opts.deniedFor ?? 0;
  const calls: string[] = [];
  const lists: Record<string, object> = {
    ListAccessKeysCommand: { AccessKeyMetadata: [{ AccessKeyId: "AKIAEXAMPLE" }] },
    ListAttachedUserPoliciesCommand: {
      AttachedPolicies: [{ PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess" }],
    },
    ListUserPoliciesCommand: { PolicyNames: [] },
    ListGroupsForUserCommand: { Groups: [] },
    ListMFADevicesCommand: { MFADevices: [] },
    ListSigningCertificatesCommand: { Certificates: [] },
    ListSSHPublicKeysCommand: { SSHPublicKeys: [] },
    ListServiceSpecificCredentialsCommand: { ServiceSpecificCredentials: [] },
  };
  const iam = {
    async send(command: { input: unknown }) {
      const name = command.constructor.name;
      calls.push(name);
      if (denied-- > 0) throw failure("AccessDenied");
      if (name === "DeleteRolePolicyCommand" || name === "PutRolePolicyCommand") return {};
      if (!exists) throw failure("NoSuchEntityException");
      if (name === "DeleteLoginProfileCommand") throw failure("NoSuchEntityException");
      if (name === "DeleteUserCommand") exists = false;
      return lists[name] ?? {};
    },
  };
  const as = (Arn: string) => ({ send: async () => ({ Arn }) });
  return { iam, calls, as };
}

const noWait = async () => {};

test("the temporary policy reaches only the setup user and the CI role's own removal of it", () => {
  const policy = retirePolicy(ACCOUNT, "reranker-setup");
  const [user, groups, mfa, self] = policy.Statement;
  expect(user?.Resource).toBe(USER_ARN);
  expect(user?.Action).not.toContain("iam:CreateAccessKey");
  expect(groups?.Action).toBe("iam:RemoveUserFromGroup");
  expect(mfa?.Action).toBe("iam:DeleteVirtualMFADevice");
  expect(self).toMatchObject({
    Action: "iam:DeleteRolePolicy",
    Resource: `arn:aws:iam::${ACCOUNT}:role/reranker-ci-kms-preview`,
  });
});

test("grant names the setup user from its own credentials and refuses anything else", async () => {
  const a = account();
  await expect(grant(a.iam, a.as(USER_ARN), ACCOUNT)).resolves.toBe("reranker-setup");
  expect(a.calls).toEqual(["PutRolePolicyCommand"]);
  await expect(grant(a.iam, a.as(ROLE_SESSION), ACCOUNT)).rejects.toThrow(/not an IAM user/);
  await expect(grant(a.iam, a.as(`arn:aws:iam::${ACCOUNT}:root`), ACCOUNT)).rejects.toThrow();
});

test("retire deletes the keys, detaches the policies, deletes the user, then drops its policy", async () => {
  const a = account({ deniedFor: 2 });
  const done = await retire(a.iam, a.as(ROLE_SESSION), "reranker-setup", { wait: noWait });
  expect(done).toEqual([
    "deleted an access key",
    "detached arn:aws:iam::aws:policy/AdministratorAccess",
    "deleted user reranker-setup",
    `dropped ${RETIRE_POLICY} from reranker-ci-kms-preview`,
  ]);
  expect(a.calls.at(-1)).toBe("DeleteRolePolicyCommand");
  expect(a.calls.indexOf("DeleteUserCommand")).toBeGreaterThan(
    a.calls.lastIndexOf("DetachUserPolicyCommand"),
  );
});

test("a rerun after the user is gone only drops the leftover policy", async () => {
  const a = account({ userExists: false });
  expect(await retire(a.iam, a.as(ROLE_SESSION), "reranker-setup", { wait: noWait })).toEqual([
    "user reranker-setup was already gone",
    `dropped ${RETIRE_POLICY} from reranker-ci-kms-preview`,
  ]);
});

test("retire refuses to run as the user it deletes", async () => {
  const a = account();
  await expect(retire(a.iam, a.as(USER_ARN), "reranker-setup")).rejects.toThrow(/run this as/);
  expect(a.calls).toEqual([]);
});
