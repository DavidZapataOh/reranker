import { expect, test } from "@reranker/testing/playwright";

// Next answers permanent: false redirects with 307.
const channels = [
  ["ig", "instagram", "social", "bio"],
  ["in", "linkedin", "social", "perfil"],
  ["tt", "tiktok", "social", "bio"],
  ["yt", "youtube", "video", "canal"],
  ["wa", "whatsapp", "messaging", "estado"],
  ["mail", "email", "email", "firma"],
] as const;

for (const [path, source, medium, fallback] of channels) {
  test(`/${path} redirects with exact UTM @smoke`, async ({ request }) => {
    const r = await request.get(`/${path}`, { maxRedirects: 0 });
    expect(r.status()).toBe(307);
    expect(r.headers().location).toBe(
      `/?utm_source=${source}&utm_medium=${medium}&utm_campaign=${path}-${fallback}`,
    );
    const c = await request.get(`/${path}/reel-01`, { maxRedirects: 0 });
    expect(c.status()).toBe(307);
    expect(c.headers().location).toBe(
      `/?utm_source=${source}&utm_medium=${medium}&utm_campaign=${path}-reel-01`,
    );
  });
}

test("campaign slugs outside [a-z0-9-]{1,40} are not redirected @smoke", async ({ request }) => {
  expect((await request.get("/ig/REEL_01", { maxRedirects: 0 })).status()).toBe(404);
  expect((await request.get(`/ig/${"a".repeat(41)}`, { maxRedirects: 0 })).status()).toBe(404);
});
