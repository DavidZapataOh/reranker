import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  devIndicators: false,
  transpilePackages: [],
  // Short tracked links for each channel, e.g. reranker.co/ig (bio) or reranker.co/ig/reel-01.
  // They land on the home page with UTM tags so the dashboard can tell channels apart.
  async redirects() {
    const channels: [string, string, string, string][] = [
      // [path, utm_source, utm_medium, default campaign]
      ["ig", "instagram", "social", "bio"],
      ["in", "linkedin", "social", "perfil"],
      ["tt", "tiktok", "social", "bio"],
      ["yt", "youtube", "video", "canal"],
      ["wa", "whatsapp", "messaging", "estado"],
      ["mail", "email", "email", "firma"],
    ];
    return channels.flatMap(([path, source, medium, fallback]) => [
      {
        source: `/${path}`,
        destination: `/?utm_source=${source}&utm_medium=${medium}&utm_campaign=${path}-${fallback}`,
        permanent: false,
      },
      {
        source: `/${path}/:campaign([a-z0-9-]{1,40})`,
        destination: `/?utm_source=${source}&utm_medium=${medium}&utm_campaign=${path}-:campaign`,
        permanent: false,
      },
    ]);
  },
  // PostHog reverse proxy: events go through reranker.co/ingest so ad blockers don't drop them.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    const region = process.env.NEXT_PUBLIC_POSTHOG_REGION === "eu" ? "eu" : "us";
    return [
      {
        source: "/ingest/static/:path*",
        destination: `https://${region}-assets.i.posthog.com/static/:path*`,
      },
      {
        source: "/ingest/array/:path*",
        destination: `https://${region}-assets.i.posthog.com/array/:path*`,
      },
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
