import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // The app has no home page: open the chat.
  async redirects() {
    return [{ source: "/", destination: "/agent", permanent: false }];
  },
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    agentUpgrade: "security",
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
