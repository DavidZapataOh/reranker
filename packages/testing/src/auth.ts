import { withSystem } from "@reranker/db";
import { verifications } from "@reranker/db/schema/auth";
import { symmetricDecrypt } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { requireEnv } from "./env.ts";

/** Better Auth stores an encrypted code as `<ciphertext>:<attempts>`. */
export async function decryptStoredCode(stored: string, key: string): Promise<string> {
  const separator = stored.lastIndexOf(":");
  if (separator === -1) throw new Error("stored sign-in code has no attempt counter");
  return symmetricDecrypt({ key, data: stored.slice(0, separator) });
}

/** The pending sign-in code for an address, read where Better Auth keeps it instead of from the inbox. */
export async function readSignInCode(email: string): Promise<string> {
  const identifier = `sign-in-otp-${email.toLowerCase()}`;
  const [row] = await withSystem("test.read-sign-in-code", (tx) =>
    tx
      .select({ value: verifications.value })
      .from(verifications)
      .where(eq(verifications.identifier, identifier))
      .limit(1),
  );
  if (!row) throw new Error(`no sign-in code pending for ${email}`);
  return decryptStoredCode(row.value, requireEnv("BETTER_AUTH_SECRET"));
}
