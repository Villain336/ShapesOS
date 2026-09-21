import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required for the self-hosted Docker image (see Dockerfile)
  output: "standalone",
};

export default nextConfig;
