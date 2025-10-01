// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    // Let production builds complete even if ESLint finds issues
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Let production builds complete even if there are TS errors
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
