import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  agentRules: false,
  poweredByHeader: false,
  devIndicators: false,
  serverExternalPackages: ["unpdf"],
};

export default nextConfig;
