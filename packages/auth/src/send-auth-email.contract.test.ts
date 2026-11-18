import { randomInt } from "node:crypto";
import { requireEnv } from "@reranker/testing/env";
import { Resend } from "resend";
import { expect, test, vi } from "vitest";
import { sendAuthEmail } from "./send-auth-email";

// resend.dev addresses accept mail from any verified sender and report delivery without a real inbox.
test("delivers the sign-in code through Resend", async () => {
  const apiKey = requireEnv("RESEND_API_KEY");
  vi.stubEnv("APP_ENV", "development");
  // The idempotency key derives from recipient and code: a fixed code collides with an earlier
  // run's key inside Resend's 24-hour window, which answers 409 once the template has changed.
  const otp = randomInt(1_000_000).toString().padStart(6, "0");

  const { id } = await sendAuthEmail("sign-in-code", "delivered@resend.dev", { otp });
  expect(id).toMatch(/^[0-9a-f-]{36}$/);

  const resend = new Resend(apiKey);
  await vi.waitFor(
    async () => {
      const { data, error } = await resend.emails.get(id);
      expect(error).toBeNull();
      expect(["sent", "delivered"]).toContain(data?.last_event);
    },
    { timeout: 30_000, interval: 2_000 },
  );
});
