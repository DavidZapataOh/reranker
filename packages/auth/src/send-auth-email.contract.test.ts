import { requireEnv } from "@reranker/testing/env";
import { Resend } from "resend";
import { expect, test, vi } from "vitest";
import { sendAuthEmail } from "./send-auth-email";

// resend.dev addresses accept mail from any verified sender and report delivery without a real inbox.
test("delivers the sign-in code through Resend", async () => {
  const apiKey = requireEnv("RESEND_API_KEY");
  vi.stubEnv("APP_ENV", "development");

  const { id } = await sendAuthEmail("sign-in-code", "delivered@resend.dev", { otp: "123456" });
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
