const origin = "https://reranker.co";
const verifyPath = "/verificar/";

// The pattern pins the literal form; parsing then catches what browsers normalize (%2e%2e, backslashes, tabs).
export function assertVerifyUrl(url: string): string {
  const relative = /^\/verificar\/[^/\\]/.test(url);
  if (relative || /^https:\/\/reranker\.co\//.test(url)) {
    const parsed = new URL(url, origin);
    const staysOnPath =
      !relative ||
      (parsed.pathname.startsWith(verifyPath) && parsed.pathname.length > verifyPath.length);
    if (parsed.origin === origin && staysOnPath) return url;
  }
  throw new TypeError(`Not a Reranker verification link: ${JSON.stringify(url)}`);
}
