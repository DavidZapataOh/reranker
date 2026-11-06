const PRODUCTION_HOST = "reranker.co";
const PREVIEW_HOST = /^reranker-[a-z0-9-]+-davidzapataohs-projects\.vercel\.app$/;

export function assertDeploymentUrl(url: string, opts: { allowProduction: boolean }): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`untrusted deployment URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`untrusted deployment URL: ${url}`);
  }
  if (parsed.host === PRODUCTION_HOST) {
    if (!opts.allowProduction) throw new Error(`production target refused: ${url}`);
    return parsed;
  }
  if (!PREVIEW_HOST.test(parsed.host)) {
    throw new Error(`untrusted deployment URL: ${url}`);
  }
  return parsed;
}
