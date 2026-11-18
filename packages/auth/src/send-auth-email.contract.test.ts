import { randomInt, randomUUID } from "node:crypto";
import { requireEnv } from "@reranker/testing/env";
import { Resend } from "resend";
import { expect, test, vi } from "vitest";
import { sendAuthEmail } from "./send-auth-email";

const randomCode = () => randomInt(1_000_000).toString().padStart(6, "0");

async function expectDelivered(resend: Resend, id: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const { data, error } = await resend.emails.get(id);
      expect(error).toBeNull();
      expect(["sent", "delivered"]).toContain(data?.last_event);
    },
    { timeout: 30_000, interval: 2_000 },
  );
}

// resend.dev addresses accept mail from any verified sender and report delivery without a real inbox.
test("delivers the sign-in code through Resend", async () => {
  const resend = new Resend(requireEnv("RESEND_API_KEY"));
  vi.stubEnv("APP_ENV", "development");

  const { id } = await sendAuthEmail(
    "sign-in-code",
    "delivered@resend.dev",
    { otp: randomCode() },
    { attempt: randomUUID() },
  );
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  await expectDelivered(resend, id);
});

test("a resend of the same code is delivered again; a retry of one attempt is not", async () => {
  const resend = new Resend(requireEnv("RESEND_API_KEY"));
  vi.stubEnv("APP_ENV", "development");
  const to = "delivered+resend@resend.dev";
  const data = { otp: randomCode() };
  const attempt = randomUUID();

  const first = await sendAuthEmail("sign-in-code", to, data, { attempt });
  const retry = await sendAuthEmail("sign-in-code", to, data, { attempt });
  const resent = await sendAuthEmail("sign-in-code", to, data, { attempt: randomUUID() });

  expect(retry.id).toBe(first.id);
  expect(resent.id).not.toBe(first.id);
  await Promise.all([expectDelivered(resend, first.id), expectDelivered(resend, resent.id)]);
});
