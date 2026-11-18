import { server } from "@reranker/testing/msw";
import { HttpResponse, http } from "msw";
import { delay } from "msw/utils/delay";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { safeGet } from "../../src/web/safe-get";

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup, default: { lookup: dns.lookup } }));

const PUBLIC_IP = "93.184.215.14";
const OPTS = { timeoutMs: 2000, maxBytes: 524_288 };
const answers = new Map<string, string[]>();

function stubLookup(host: string, ...ips: string[]) {
  answers.set(host, ips);
}

beforeAll(() => server.listen());
beforeEach(() => {
  dns.lookup.mockImplementation(async (host: string) => {
    const ips = answers.get(host);
    if (!ips) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  });
});
afterEach(() => {
  server.resetHandlers();
  answers.clear();
  vi.clearAllMocks();
});
afterAll(() => server.close());

test.each([
  "127.0.0.1",
  "10.1.2.3",
  "172.16.0.9",
  "192.168.1.1",
  "169.254.169.254",
  "100.64.0.1",
  "0.0.0.0",
  "::1",
  "fd00::1",
  "fe80::1",
  "::ffff:127.0.0.1",
])("safeGet refuses a host resolving to %s", async (ip) => {
  stubLookup("tienda.example", ip);
  expect(await safeGet("https://tienda.example/", OPTS)).toBeNull();
});

test("safeGet refuses a host when any of its addresses is not public", async () => {
  stubLookup("tienda.example", PUBLIC_IP, "10.0.0.1");
  expect(await safeGet("https://tienda.example/", OPTS)).toBeNull();
});

test.each([
  "https://127.0.0.1/",
  "https://[::1]/",
  "file:///etc/passwd",
  "ftp://tienda.example/",
  "https://user:pw@tienda.example/",
  "not a url",
])("safeGet refuses %s", async (url) => {
  stubLookup("tienda.example", PUBLIC_IP);
  expect(await safeGet(url, OPTS)).toBeNull();
});

test("safeGet refuses a host that does not resolve", async () => {
  expect(await safeGet("https://nadie.example/", OPTS)).toBeNull();
});

test("safeGet returns the status, body and final URL of a public page", async () => {
  stubLookup("tienda.example", PUBLIC_IP);
  server.use(http.get("https://tienda.example/", () => HttpResponse.html("<title>Hola</title>")));
  expect(await safeGet("https://tienda.example/", OPTS)).toEqual({
    status: 200,
    body: "<title>Hola</title>",
    finalUrl: "https://tienda.example/",
  });
});

test("safeGet follows a redirect on the same site and refuses another host", async () => {
  stubLookup("tienda.example", PUBLIC_IP);
  stubLookup("www.tienda.example", PUBLIC_IP);
  stubLookup("evil.example", PUBLIC_IP);
  server.use(
    http.get("http://tienda.example/", () =>
      HttpResponse.redirect("https://www.tienda.example/", 301),
    ),
    http.get("https://www.tienda.example/", () => HttpResponse.html("ok")),
    http.get("https://tienda.example/salir", () =>
      HttpResponse.redirect("https://evil.example/", 302),
    ),
  );
  expect(await safeGet("http://tienda.example/", OPTS)).toMatchObject({
    status: 200,
    finalUrl: "https://www.tienda.example/",
  });
  expect(await safeGet("https://tienda.example/salir", OPTS)).toBeNull();
});

test("safeGet refuses a redirect back to plain HTTP", async () => {
  stubLookup("tienda.example", PUBLIC_IP);
  server.use(
    http.get("https://tienda.example/", () => HttpResponse.redirect("http://tienda.example/a")),
  );
  expect(await safeGet("https://tienda.example/", OPTS)).toBeNull();
});

test("safeGet re-checks the address of each redirect", async () => {
  stubLookup("tienda.example", PUBLIC_IP);
  stubLookup("interno.tienda.example", "10.0.0.5");
  server.use(
    http.get("https://tienda.example/", () =>
      HttpResponse.redirect("https://interno.tienda.example/"),
    ),
  );
  expect(await safeGet("https://tienda.example/", OPTS)).toBeNull();
});

test("safeGet gives up after three redirects", async () => {
  stubLookup("tienda.example", PUBLIC_IP);
  server.use(
    http.get("https://tienda.example/:n", ({ params }) =>
      HttpResponse.redirect(`https://tienda.example/${Number(params.n) + 1}`),
    ),
  );
  expect(await safeGet("https://tienda.example/1", OPTS)).toBeNull();
});

test("safeGet stops at maxBytes", async () => {
  stubLookup("tienda.example", PUBLIC_IP);
  server.use(http.get("https://tienda.example/", () => HttpResponse.html("a".repeat(4096))));
  const page = await safeGet("https://tienda.example/", { timeoutMs: 2000, maxBytes: 1000 });
  expect(page?.body).toHaveLength(1000);
});

test("safeGet decodes the declared charset", async () => {
  stubLookup("tienda.example", PUBLIC_IP);
  const latin1 = new Uint8Array([0x50, 0x61, 0x6e, 0x61, 0x64, 0x65, 0x72, 0xed, 0x61]);
  server.use(
    http.get(
      "https://tienda.example/",
      () =>
        new HttpResponse(latin1, { headers: { "content-type": "text/html; charset=ISO-8859-1" } }),
    ),
  );
  expect((await safeGet("https://tienda.example/", OPTS))?.body).toBe("Panadería");
});

test("safeGet gives up at the timeout", async () => {
  stubLookup("tienda.example", PUBLIC_IP);
  server.use(
    http.get("https://tienda.example/", async () => {
      await delay(400);
      return HttpResponse.html("tarde");
    }),
  );
  expect(await safeGet("https://tienda.example/", { timeoutMs: 100, maxBytes: 1000 })).toBeNull();
});
