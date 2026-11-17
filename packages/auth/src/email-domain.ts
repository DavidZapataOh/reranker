import { Resolver } from "node:dns/promises";
import { readFile } from "node:fs/promises";

export type EmailDomainResult = { ok: true } | { ok: false; reason: "disposable" | "no_mx" };

const DNS_TIMEOUT_MS = 1_500;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// A warm function sees far fewer domains than this; the cap only bounds memory under a flood.
const CACHE_MAX_ENTRIES = 10_000;
// Where most people's mail lives; a lookup would only add latency.
const KNOWN_PROVIDERS = new Set([
  "gmail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
]);
const NO_RECORDS = new Set(["ENODATA", "ENOTFOUND"]);

let disposable: Promise<Set<string>> | undefined;
const cache = new Map<string, { result: EmailDomainResult; expiresAt: number }>();

function disposableDomains(): Promise<Set<string>> {
  disposable ??= readFile(new URL("./disposable_email_blocklist.conf", import.meta.url), "utf8")
    .then(
      (text) =>
        new Set(
          text
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "" && !line.startsWith("#")),
        ),
    )
    .catch((error: unknown) => {
      disposable = undefined;
      throw error;
    });
  return disposable;
}

// The list holds registrable domains; their subdomains are the same service.
function isListed(domain: string, list: Set<string>): boolean {
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (list.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

/** Records found, none (the name has no such record), or undefined when DNS gave no answer. */
async function lookup<T>(query: () => Promise<T[]>): Promise<T[] | undefined> {
  try {
    return await query();
  } catch (error) {
    return NO_RECORDS.has((error as { code?: string }).code ?? "") ? [] : undefined;
  }
}

async function receivesMail(domain: string): Promise<boolean | undefined> {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolver.cancel();
      resolve(undefined);
    }, DNS_TIMEOUT_MS);
  });
  const resolve = async (): Promise<boolean | undefined> => {
    const mx = await lookup(() => resolver.resolveMx(domain));
    if (mx === undefined) return undefined;
    // A single MX with an empty host is a null MX (RFC 7505): the domain accepts no mail.
    if (mx.length > 0) return !mx.every((record) => record.exchange === "");
    // Without MX, mail goes to the domain's own address (RFC 5321 section 5.1).
    const a = await lookup(() => resolver.resolve4(domain));
    return a === undefined ? undefined : a.length > 0;
  };
  try {
    return await Promise.race([resolve(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function remember(domain: string, result: EmailDomainResult): EmailDomainResult {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(domain, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

/**
 * Refuses disposable domains and domains that cannot receive mail. A DNS that does not answer in
 * time accepts: a slow resolver must not lock people out.
 */
export async function checkEmailDomain(email: string): Promise<EmailDomainResult> {
  const address = email.trim().toLowerCase();
  const domain = address.slice(address.lastIndexOf("@") + 1);
  if (KNOWN_PROVIDERS.has(domain)) return { ok: true };
  if (isListed(domain, await disposableDomains())) return { ok: false, reason: "disposable" };

  const cached = cache.get(domain);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  cache.delete(domain);

  const mail = await receivesMail(domain);
  if (mail === undefined) return { ok: true };
  return remember(domain, mail ? { ok: true } : { ok: false, reason: "no_mx" });
}
