import { createHash } from "node:crypto";
import { defineEnv } from "@reranker/env";
import { AppError } from "@reranker/schema";
import { captureServerEvent } from "@reranker/telemetry";
import { createElement } from "react";
import { render } from "react-email";
import { Resend } from "resend";
import { SignInCodeEmail, signInCodeCopy } from "./emails/sign-in-code";
import { authEnv } from "./env";

const FROM = "Reranker <codigos@mail.reranker.co>";

const sendEnv = authEnv.pick({ RESEND_API_KEY: true });

const templates = {
  "sign-in-code": {
    subject: ({ otp }: { otp: string }) => signInCodeCopy.subject(otp),
    element: ({ otp }: { otp: string }) => createElement(SignInCodeEmail, { otp }),
  },
};

export type AuthEmailTemplate = keyof typeof templates;

// Created on first send so importing the module never needs the key.
let client: Resend | undefined;

function resend(): Resend {
  client ??= new Resend(defineEnv([sendEnv]).RESEND_API_KEY);
  return client;
}

/** Same recipient and code within Resend's 24-hour window is one email, so an SDK retry never double-sends. */
export function idempotencyKey(template: AuthEmailTemplate, to: string, otp: string): string {
  return `${template}/${createHash("sha256")
    .update(to + otp)
    .digest("hex")}`;
}

export async function sendAuthEmail(
  template: "sign-in-code",
  to: string,
  data: { otp: string },
): Promise<{ id: string }> {
  const { subject, element } = templates[template];
  const node = element(data);
  const [html, text] = await Promise.all([render(node), render(node, { plainText: true })]);
  const { data: sent, error } = await resend().emails.send(
    { from: FROM, to, subject: subject(data), html, text },
    { idempotencyKey: idempotencyKey(template, to, data.otp) },
  );
  if (error) {
    // No props: the address and the code never leave this function.
    captureServerEvent({ name: "auth_email_failed", props: {} }, { subject: { system: true } });
    throw new AppError("service_unavailable", { cause: error });
  }
  return { id: sent.id };
}
