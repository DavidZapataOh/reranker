import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  devIndicators: false,
  // PostHog reverse proxy: events go through reranker.co/ingest so ad blockers don't drop them.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    const region = process.env.NEXT_PUBLIC_POSTHOG_REGION === "eu" ? "eu" : "us";
    return [
      { source: "/ingest/static/:path*", destination: `https://${region}-assets.i.posthog.com/static/:path*` },
      { source: "/ingest/array/:path*", destination: `https://${region}-assets.i.posthog.com/array/:path*` },
      { source: "/ingest/:path*", destination: `https://${region}.i.posthog.com/:path*` },
    ];
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
