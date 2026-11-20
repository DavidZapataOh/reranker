import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  DeactivateMFADeviceCommand,
  DeleteAccessKeyCommand,
  DeleteLoginProfileCommand,
  DeleteRolePolicyCommand,
  DeleteServiceSpecificCredentialCommand,
  DeleteSigningCertificateCommand,
  DeleteSSHPublicKeyCommand,
  DeleteUserCommand,
  DeleteUserPolicyCommand,
  DeleteVirtualMFADeviceCommand,
  DetachUserPolicyCommand,
  GetUserCommand,
  IAMClient,
  ListAccessKeysCommand,
  ListAttachedUserPoliciesCommand,
  ListGroupsForUserCommand,
  ListMFADevicesCommand,
  ListServiceSpecificCredentialsCommand,
  ListSigningCertificatesCommand,
  ListSSHPublicKeysCommand,
  ListUserPoliciesCommand,
  PutRolePolicyCommand,
  RemoveUserFromGroupCommand,
} from "@aws-sdk/client-iam";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { REGION } from "./aws-state.ts";

// The setup user cannot delete itself: DeleteUser needs its policies detached first, which would
// leave it without the permission to finish. The nightly CI role, assumed through GitHub OIDC on
// main, gets a temporary policy that reaches only that user and its own removal, and deletes that
// policy as its last call, so nothing with standing access is left behind.
export const RETIRING_ROLE = "reranker-ci-kms-preview";
export const RETIRE_POLICY = "retire-setup-user";

export function retirePolicy(account: string, user: string) {
  const userArn = `arn:aws:iam::${account}:user/${user}`;
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "RemoveTheSetupUser",
        Effect: "Allow",
        Action: [
          "iam:GetUser",
          "iam:DeleteUser",
          "iam:ListAccessKeys",
          "iam:DeleteAccessKey",
          "iam:DeleteLoginProfile",
          "iam:ListAttachedUserPolicies",
          "iam:DetachUserPolicy",
          "iam:ListUserPolicies",
          "iam:DeleteUserPolicy",
          "iam:ListGroupsForUser",
          "iam:ListMFADevices",
          "iam:DeactivateMFADevice",
          "iam:ListSigningCertificates",
          "iam:DeleteSigningCertificate",
          "iam:ListSSHPublicKeys",
          "iam:DeleteSSHPublicKey",
          "iam:ListServiceSpecificCredentials",
          "iam:DeleteServiceSpecificCredential",
        ],
        Resource: userArn,
      },
      {
        Sid: "LeaveItsGroups",
        Effect: "Allow",
        Action: "iam:RemoveUserFromGroup",
        Resource: `arn:aws:iam::${account}:group/*`,
      },
      {
        Sid: "DeleteItsVirtualMfa",
        Effect: "Allow",
        Action: "iam:DeleteVirtualMFADevice",
        Resource: `arn:aws:iam::${account}:mfa/*`,
      },
      {
        Sid: "DropThisPolicy",
        Effect: "Allow",
        Action: "iam:DeleteRolePolicy",
        Resource: `arn:aws:iam::${account}:role/${RETIRING_ROLE}`,
      },
    ],
  };
}

type Iam = Pick<IAMClient, "send">;
type Sts = Pick<STSClient, "send">;

const gone = (error: unknown) => error instanceof Error && error.name === "NoSuchEntityException";

/** Run with the setup user's own credentials: returns its name after granting the CI role. */
export async function grant(iam: Iam, sts: Sts, account: string): Promise<string> {
  const { Arn } = await sts.send(new GetCallerIdentityCommand({}));
  const user = new RegExp(`^arn:aws:iam::${account}:user/([\\w+=,.@-]+)$`).exec(Arn ?? "")?.[1];
  if (!user) throw new Error("these credentials are not an IAM user of the account");
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: RETIRING_ROLE,
      PolicyName: RETIRE_POLICY,
      PolicyDocument: JSON.stringify(retirePolicy(account, user)),
    }),
  );
  return user;
}

/**
 * Run as the CI role: deletes every credential and attachment of the user, then the user, checks
 * that it is gone, and drops the temporary policy. Safe to rerun after a partial failure.
 */
export async function retire(
  iam: Iam,
  sts: Sts,
  user: string,
  opts: { wait?: (ms: number) => Promise<unknown>; attempts?: number } = {},
): Promise<string[]> {
  const { wait = sleep, attempts = 12 } = opts;
  const { Arn } = await sts.send(new GetCallerIdentityCommand({}));
  if (!Arn?.includes(`:assumed-role/${RETIRING_ROLE}/`)) {
    throw new Error(`run this as ${RETIRING_ROLE}, not as the user it deletes`);
  }
  const done: string[] = [];
  // A policy put moments ago may not apply yet.
  const call = async <T>(request: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await request();
      } catch (error) {
        const denied =
          error instanceof Error &&
          (error.name === "AccessDenied" || error.name === "AccessDeniedException");
        if (!denied || attempt === attempts) throw error;
        await wait(5_000);
      }
    }
  };
  const UserName = user;
  try {
    await call(() => iam.send(new GetUserCommand({ UserName })));
    const keys = await call(() => iam.send(new ListAccessKeysCommand({ UserName })));
    for (const { AccessKeyId } of keys.AccessKeyMetadata ?? []) {
      await call(() => iam.send(new DeleteAccessKeyCommand({ UserName, AccessKeyId })));
      done.push("deleted an access key");
    }
    try {
      await call(() => iam.send(new DeleteLoginProfileCommand({ UserName })));
      done.push("deleted the console password");
    } catch (error) {
      if (!gone(error)) throw error;
    }
    const attached = await call(() => iam.send(new ListAttachedUserPoliciesCommand({ UserName })));
    for (const { PolicyArn } of attached.AttachedPolicies ?? []) {
      await call(() => iam.send(new DetachUserPolicyCommand({ UserName, PolicyArn })));
      done.push(`detached ${PolicyArn}`);
    }
    const inline = await call(() => iam.send(new ListUserPoliciesCommand({ UserName })));
    for (const PolicyName of inline.PolicyNames ?? []) {
      await call(() => iam.send(new DeleteUserPolicyCommand({ UserName, PolicyName })));
      done.push(`deleted inline policy ${PolicyName}`);
    }
    const groups = await call(() => iam.send(new ListGroupsForUserCommand({ UserName })));
    for (const { GroupName } of groups.Groups ?? []) {
      await call(() => iam.send(new RemoveUserFromGroupCommand({ UserName, GroupName })));
      done.push(`left group ${GroupName}`);
    }
    const mfa = await call(() => iam.send(new ListMFADevicesCommand({ UserName })));
    for (const { SerialNumber } of mfa.MFADevices ?? []) {
      await call(() => iam.send(new DeactivateMFADeviceCommand({ UserName, SerialNumber })));
      if (SerialNumber?.includes(":mfa/")) {
        await call(() => iam.send(new DeleteVirtualMFADeviceCommand({ SerialNumber })));
      }
      done.push("removed an MFA device");
    }
    const certs = await call(() => iam.send(new ListSigningCertificatesCommand({ UserName })));
    for (const { CertificateId } of certs.Certificates ?? []) {
      await call(() => iam.send(new DeleteSigningCertificateCommand({ UserName, CertificateId })));
      done.push("deleted a signing certificate");
    }
    const ssh = await call(() => iam.send(new ListSSHPublicKeysCommand({ UserName })));
    for (const { SSHPublicKeyId } of ssh.SSHPublicKeys ?? []) {
      await call(() => iam.send(new DeleteSSHPublicKeyCommand({ UserName, SSHPublicKeyId })));
      done.push("deleted an SSH key");
    }
    const service = await call(() =>
      iam.send(new ListServiceSpecificCredentialsCommand({ UserName })),
    );
    for (const { ServiceSpecificCredentialId } of service.ServiceSpecificCredentials ?? []) {
      await call(() =>
        iam.send(
          new DeleteServiceSpecificCredentialCommand({ UserName, ServiceSpecificCredentialId }),
        ),
      );
      done.push("deleted a service credential");
    }
    await call(() => iam.send(new DeleteUserCommand({ UserName })));
    done.push(`deleted user ${user}`);
  } catch (error) {
    if (!gone(error)) throw error;
    done.push(`user ${user} was already gone`);
  }
  // IAM is eventually consistent: a deleted user can still be read for a few seconds.
  for (let attempt = 1; ; attempt++) {
    try {
      await call(() => iam.send(new GetUserCommand({ UserName })));
    } catch (error) {
      if (gone(error)) break;
      throw error;
    }
    if (attempt === attempts) throw new Error(`user ${user} still exists`);
    await wait(5_000);
  }
  await call(() =>
    iam.send(new DeleteRolePolicyCommand({ RoleName: RETIRING_ROLE, PolicyName: RETIRE_POLICY })),
  );
  done.push(`dropped ${RETIRE_POLICY} from ${RETIRING_ROLE}`);
  return done;
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { user: { type: "string" } },
  });
  const account = process.env.AWS_ACCOUNT_ID ?? "";
  if (!/^\d{12}$/.test(account)) throw new Error("AWS_ACCOUNT_ID must be a 12-digit account id");
  const iam = new IAMClient({ region: REGION });
  const sts = new STSClient({ region: REGION });
  if (positionals[0] === "grant") {
    const user = await grant(iam, sts, account);
    console.log(`${RETIRING_ROLE} may now remove ${user}`);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `user=${user}\n`);
  } else if (positionals[0] === "retire" && values.user) {
    for (const line of await retire(iam, sts, values.user)) console.log(line);
  } else {
    throw new Error("usage: retire-setup-user.ts grant | retire --user <name>");
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
