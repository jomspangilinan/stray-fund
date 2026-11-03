import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Stops `next dev` rewriting AGENTS.md.
  agentRules: false,
  cacheComponents: true,
  partialPrefetching: true,
  async headers() {
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
