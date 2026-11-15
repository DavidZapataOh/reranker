// Every route that can make Better Auth send an email. Only the first one sends in V0; the rest
// stay guarded so a later config change can never open an unthrottled path to the Resend quota.
export const EMAIL_SENDING_PATHS = [
  "/email-otp/send-verification-otp",
  "/email-otp/request-password-reset",
  "/forget-password/email-otp",
  "/email-otp/request-email-change",
  "/send-verification-email",
];

const EMAIL_SEND_RULE = { window: 600, max: 3 };

/** Per IP and path, counted in auth.rate_limits; they take precedence over the plugins' own limits. */
export const AUTH_RATE_RULES = {
  ...Object.fromEntries(EMAIL_SENDING_PATHS.map((path) => [path, EMAIL_SEND_RULE])),
  "/sign-in/email-otp": { window: 60, max: 5 },
  "/sign-in/social": { window: 60, max: 10 },
  "/delete-user": { window: 3600, max: 3 },
} satisfies Record<string, { window: number; max: number }>;
