import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    // AI crawlers are welcome: being read by assistants is the product's whole point.
    rules: [{ userAgent: "*", allow: "/", disallow: ["/ingest/"] }],
    sitemap: "https://reranker.co/sitemap.xml",
    host: "https://reranker.co",
  };
}
