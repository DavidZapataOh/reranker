// Notify Bing (and other IndexNow engines) that reranker.co pages changed.
// ChatGPT search relies on Bing's index, so run this after each deploy that adds or edits pages:
//   pnpm --filter web indexnow
const HOST = "reranker.co";
const KEY = "cda109430c9624bbbebb33e02a6a5f53"; // also served at https://reranker.co/cda109430c9624bbbebb33e02a6a5f53.txt

const sitemap = await fetch(`https://${HOST}/sitemap.xml`).then((r) => r.text());
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
if (urls.length === 0) throw new Error("No URLs found in the sitemap");

const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({
    host: HOST,
    key: KEY,
    keyLocation: `https://${HOST}/${KEY}.txt`,
    urlList: urls,
  }),
});
console.log(`IndexNow: ${res.status} ${res.statusText} for ${urls.length} URLs`);
if (res.status >= 400) process.exit(1);
