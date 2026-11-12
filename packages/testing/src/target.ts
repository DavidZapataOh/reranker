const PRODUCTION_HOST = "reranker.co";
const PREVIEW_HOST = /^reranker-[a-z0-9-]+-davidzapataohs-projects\.vercel\.app$/;

// The URL comes from a webhook payload or a manual input and ends up in CI logs,
// where a raw newline could forge a workflow command.
function quote(url: string): string {
  return JSON.stringify(url.length > 200 ? `${url.slice(0, 200)}…` : url);
}

export function assertDeploymentUrl(url: string, opts: { allowProduction: boolean }): URL {
  const untrusted = () => new Error(`untrusted deployment URL: ${quote(url)}`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw untrusted();
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw untrusted();
  if (parsed.host === PRODUCTION_HOST) {
    if (!opts.allowProduction) throw new Error(`production target refused: ${quote(url)}`);
    return parsed;
  }
  if (!PREVIEW_HOST.test(parsed.host)) throw untrusted();
  return parsed;
}
