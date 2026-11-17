const PROBE_ORIGIN = "https://x.invalid";

/**
 * The internal /app path to send someone back to after signing in, or the fallback for anything
 * that could leave the site. Encoded slashes and dot segments are resolved before the check, so
 * `/app%2F..%2F//evil.com` cannot turn into a protocol-relative URL.
 */
export function safeReturnPath(value: string | null | undefined, fallback = "/app"): string {
  if (!value) return fallback;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return fallback;
  }
  if (!/^\/(?![/\\])/.test(decoded)) return fallback;
  const url = new URL(decoded, PROBE_ORIGIN);
  if (url.origin !== PROBE_ORIGIN) return fallback;
  if (url.pathname !== "/app" && !url.pathname.startsWith("/app/")) return fallback;
  return url.pathname + url.search;
}
