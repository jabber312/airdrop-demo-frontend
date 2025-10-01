import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      {
        source: "/(.*)", // Apply headers to all routes
        headers: [
          {
            key: "Content-Security-Policy",
            // Allow ethers.js + MetaMask to work
            value: "script-src 'self' 'unsafe-eval'; object-src 'none'; base-uri 'self';",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
