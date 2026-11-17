import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const dns = vi.hoisted(() => ({
  resolveMx: vi.fn<(domain: string) => Promise<{ exchange: string; priority: number }[]>>(),
  resolve4: vi.fn<(domain: string) => Promise<string[]>>(),
  cancel: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
  Resolver: class {
    resolveMx = dns.resolveMx;
    resolve4 = dns.resolve4;
    cancel = dns.cancel;
  },
}));

let checkEmailDomain: typeof import("./email-domain").checkEmailDomain;

const dnsError = (code: string) => Object.assign(new Error(code), { code });

const listed = readFileSync(new URL("./disposable_email_blocklist.conf", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line !== "" && !line.startsWith("#"));

// A fresh module per test starts with an empty DNS cache.
beforeEach(async () => {
  vi.resetModules();
  ({ checkEmailDomain } = await import("./email-domain"));
  dns.resolveMx.mockResolvedValue([{ exchange: "mx.example.co", priority: 10 }]);
  dns.resolve4.mockRejectedValue(dnsError("ENODATA"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("checkEmailDomain", () => {
  const sample = Array.from({ length: 20 }, (_, i) => listed[Math.floor((i * listed.length) / 20)]);

  test.each(sample)("rejects the disposable domain %s without a DNS query", async (domain) => {
    await expect(checkEmailDomain(`ana@${domain}`)).resolves.toEqual({
      ok: false,
      reason: "disposable",
    });
    expect(dns.resolveMx).not.toHaveBeenCalled();
  });

  test("a subdomain of a disposable domain is disposable too", async () => {
    await expect(checkEmailDomain("ana@inbox.mailinator.com")).resolves.toEqual({
      ok: false,
      reason: "disposable",
    });
  });

  test("the domain is matched whatever its case", async () => {
    await expect(checkEmailDomain(" Ana@MAILINATOR.com ")).resolves.toEqual({
      ok: false,
      reason: "disposable",
    });
  });

  test("a domain with neither MX nor A records has no mail server", async () => {
    dns.resolveMx.mockRejectedValue(dnsError("ENOTFOUND"));
    dns.resolve4.mockRejectedValue(dnsError("ENOTFOUND"));
    await expect(checkEmailDomain("ana@no-mail.example")).resolves.toEqual({
      ok: false,
      reason: "no_mx",
    });
  });

  test("a null MX (RFC 7505) refuses mail even when the domain has an address", async () => {
    dns.resolveMx.mockResolvedValue([{ exchange: "", priority: 0 }]);
    dns.resolve4.mockResolvedValue(["192.0.2.1"]);
    await expect(checkEmailDomain("ana@null-mx.example")).resolves.toEqual({
      ok: false,
      reason: "no_mx",
    });
  });

  test("without MX, an A record still receives mail", async () => {
    dns.resolveMx.mockRejectedValue(dnsError("ENODATA"));
    dns.resolve4.mockResolvedValue(["192.0.2.1"]);
    await expect(checkEmailDomain("ana@a-only.example")).resolves.toEqual({ ok: true });
  });

  test("a domain with MX records is accepted", async () => {
    await expect(checkEmailDomain("ana@empresa.co")).resolves.toEqual({ ok: true });
    expect(dns.resolveMx).toHaveBeenCalledWith("empresa.co");
  });

  test.each(["gmail.com", "hotmail.com", "outlook.com", "live.com", "yahoo.com", "icloud.com"])(
    "%s passes without a DNS query",
    async (domain) => {
      await expect(checkEmailDomain(`ana@${domain}`)).resolves.toEqual({ ok: true });
      expect(dns.resolveMx).not.toHaveBeenCalled();
      expect(dns.resolve4).not.toHaveBeenCalled();
    },
  );

  test("a DNS that does not answer within 1.5 s accepts and cancels the query", async () => {
    // Loads the list first: reading the file is real I/O, which fake timers cannot advance.
    await checkEmailDomain("ana@mailinator.com");
    vi.useFakeTimers();
    dns.resolveMx.mockReturnValue(new Promise(() => {}));
    const result = checkEmailDomain("ana@slow-dns.example");
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(result).resolves.toEqual({ ok: true });
    expect(dns.cancel).toHaveBeenCalled();
  });

  test("a failing DNS server accepts", async () => {
    dns.resolveMx.mockRejectedValue(dnsError("ESERVFAIL"));
    await expect(checkEmailDomain("ana@broken-dns.example")).resolves.toEqual({ ok: true });
  });

  test("an unanswered lookup is not cached", async () => {
    dns.resolveMx.mockRejectedValueOnce(dnsError("ETIMEOUT"));
    await checkEmailDomain("ana@flaky.example");
    await checkEmailDomain("ana@flaky.example");
    expect(dns.resolveMx).toHaveBeenCalledTimes(2);
  });

  test("the second lookup of a domain comes from the cache", async () => {
    dns.resolveMx.mockRejectedValue(dnsError("ENOTFOUND"));
    dns.resolve4.mockRejectedValue(dnsError("ENOTFOUND"));
    await checkEmailDomain("ana@cached.example");
    await expect(checkEmailDomain("luis@cached.example")).resolves.toEqual({
      ok: false,
      reason: "no_mx",
    });
    expect(dns.resolveMx).toHaveBeenCalledTimes(1);
  });

  test("a cached answer expires after 24 hours", async () => {
    vi.useFakeTimers();
    await checkEmailDomain("ana@expiring.example");
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    await checkEmailDomain("ana@expiring.example");
    expect(dns.resolveMx).toHaveBeenCalledTimes(2);
  });
});
