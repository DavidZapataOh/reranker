import {
  emailOTPClient,
  inferAdditionalFields,
  oneTapClient,
  organizationClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { ac, roles } from "./permissions";
import type { auth } from "./server";

// Same-origin: the browser calls /api/auth on whatever host served the page.
export const authClient = createAuthClient({
  plugins: [
    organizationClient({ ac, roles, teams: { enabled: true } }),
    emailOTPClient(),
    // authEnv makes the variable required, and Next inlines it into the browser bundle.
    oneTapClient({ clientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "" }),
    inferAdditionalFields<typeof auth>(),
  ],
});
