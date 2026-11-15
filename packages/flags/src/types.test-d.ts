// Checked by `tsc --noEmit`; never executed.
import { assertCaptureAllowed } from "./capture";
import { getVariant, isEnabled } from "./evaluate";

declare const country: string;

export async function typeChecks(): Promise<void> {
  await isEnabled("accounts", { kind: "house", country });
  await getVariant("control-canary", { kind: "tenant", tenantId: "t", plan: "pro", country });
  await assertCaptureAllowed({ channel: "ui-own", provider: "dataforseo" });

  // @ts-expect-error unregistered key must not compile
  await isEnabled("not-registered", { kind: "house" });
  // @ts-expect-error a tenant context needs its tenant id
  await isEnabled("accounts", { kind: "tenant" });
  // @ts-expect-error unknown capture provider
  await assertCaptureAllowed({ channel: "api", provider: "anthropic" });
}
