import type { MetadataRoute } from "next";

const BASE = "https://reranker.co";
// Bump when a page's content changes meaningfully.
const UPDATED = "2026-11-05";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: BASE, lastModified: UPDATED, changeFrequency: "weekly", priority: 1 },
    {
      url: `${BASE}/politica-de-datos`,
      lastModified: UPDATED,
      changeFrequency: "yearly",
      priority: 0.2,
    },
    { url: `${BASE}/terminos`, lastModified: UPDATED, changeFrequency: "yearly", priority: 0.2 },
  ];
}
