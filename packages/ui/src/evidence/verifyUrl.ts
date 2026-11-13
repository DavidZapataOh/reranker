const origin = "https://reranker.co";
const verifyPath = "/verificar/";
// The URL parser silently drops tab, CR and LF, so they could hide a path that only exists after parsing.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const controlCharacter = /[\u0000-\u001f\u007f]/;

// Validates the parsed form and returns it, so the rendered href is exactly what was checked.
export function assertVerifyUrl(url: string): string {
  const relative = url.startsWith(verifyPath);
  if (!controlCharacter.test(url) && (relative || /^https:\/\//i.test(url))) {
    const parsed = new URL(url, origin);
    const { pathname } = parsed;
    if (
      parsed.origin === origin &&
      pathname.startsWith(verifyPath) &&
      pathname.length > verifyPath.length &&
      !pathname.includes("//") &&
      !pathname.split("/").includes("..")
    ) {
      return relative ? pathname + parsed.search + parsed.hash : parsed.href;
    }
  }
  throw new TypeError(`Not a Reranker verification link: ${JSON.stringify(url)}`);
}
