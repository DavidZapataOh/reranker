/** Origin of the deployment under load, already validated by assert-target in CI. */
export function baseUrl() {
  const url = __ENV.TARGET_URL;
  if (!url) throw new Error("TARGET_URL is required");
  return url.replace(/\/+$/, "");
}

/**
 * Request params for the deployment under test. Redirects are not followed: k6 would
 * forward the bypass header to whatever host a redirect points at, and a redirect is
 * the deployment's own answer anyway.
 */
export function params() {
  const secret = __ENV.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!secret && __ENV.CI) throw new Error("VERCEL_AUTOMATION_BYPASS_SECRET is required in CI");
  return {
    headers: secret ? { "x-vercel-protection-bypass": secret } : {},
    redirects: 0,
  };
}
