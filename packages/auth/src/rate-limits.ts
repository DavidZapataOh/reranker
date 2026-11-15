/** Per IP and path, counted in auth.rate_limits; they take precedence over the plugins' own limits. */
export const AUTH_RATE_RULES = {
  "/email-otp/send-verification-otp": { window: 600, max: 3 },
  "/sign-in/email-otp": { window: 60, max: 5 },
  "/sign-in/social": { window: 60, max: 10 },
  "/delete-user": { window: 3600, max: 3 },
} satisfies Record<string, { window: number; max: number }>;
