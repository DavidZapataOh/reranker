const { bypassHeaders } = require("@reranker/testing/bypass");

const SAME_SITE = { lax: "Lax", strict: "Strict", none: "None" };

// Session cookie pinned to the deployment host, whatever Domain or expiry Vercel sends:
// the browser only lives for this collection.
function toCookie(setCookie, host) {
  const [pair, ...attributes] = setCookie.split(";");
  const separator = pair.indexOf("=");
  const cookie = {
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim(),
    domain: host,
    path: "/",
  };
  for (const attribute of attributes) {
    const [key, value = ""] = attribute.split("=").map((part) => part.trim());
    const name = key.toLowerCase();
    if (name === "path") cookie.path = value;
    else if (name === "secure") cookie.secure = true;
    else if (name === "httponly") cookie.httpOnly = true;
    else if (name === "samesite") cookie.sameSite = SAME_SITE[value.toLowerCase()];
  }
  return cookie;
}

/**
 * Lighthouse applies `settings.extraHeaders` to every origin the page loads, so the bypass
 * secret stays in Node and Chrome only gets Vercel's bypass cookie for the deployment host.
 * @param {import("puppeteer-core").Browser} browser
 * @param {{ url: string }} context
 */
module.exports = async (browser, { url }) => {
  const headers = bypassHeaders();
  if (Object.keys(headers).length === 0) return;

  const { origin, host } = new URL(url);
  const response = await fetch(origin, {
    headers: { ...headers, "x-vercel-set-bypass-cookie": "true" },
    redirect: "manual",
  });
  await response.body?.cancel();
  const cookies = response.headers.getSetCookie().map((header) => toCookie(header, host));

  // A rejected secret also sets a cookie (the SSO nonce) and Lighthouse would then audit the
  // login page under another URL, which no assertion matches. Prove the cookies open the site.
  const cookie = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  const check = await fetch(origin, { headers: cookie ? { cookie } : {}, redirect: "manual" });
  await check.body?.cancel();
  if (!check.ok) {
    throw new Error(`Vercel did not grant a bypass cookie for ${origin} (status ${check.status})`);
  }
  if (cookies.length > 0) await browser.setCookie(...cookies);
};
