import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Stops `next dev` rewriting AGENTS.md.
  agentRules: false,
  // Lets a phone load the dev server through a temporary Cloudflare tunnel.
  allowedDevOrigins: ["*.trycloudflare.com"],
  // The dev badge covers bottom bar tabs and buttons on a phone.
  devIndicators: false,
  cacheComponents: true,
  partialPrefetching: true,
  async headers() {
    // Immutable for a year, so a changed model must get a new folder (cat-detector-v2) and a new URL in src/lib/detector.ts.
    return [{ source: "/models/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] }];
  },
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
