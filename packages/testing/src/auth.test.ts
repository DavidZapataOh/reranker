import { symmetricEncrypt } from "better-auth/crypto";
import { expect, test } from "vitest";
import { decryptStoredCode } from "./auth";

const key = "k".repeat(32);

test("decrypts the code stored with its attempt counter", async () => {
  const stored = await symmetricEncrypt({ key, data: "042719" });
  expect(await decryptStoredCode(`${stored}:3`, key)).toBe("042719");
});

test("rejects a value without the attempt counter", async () => {
  await expect(decryptStoredCode("abcdef", key)).rejects.toThrow(/attempt counter/);
});
