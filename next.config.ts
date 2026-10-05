import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Static SPA export: `next build` emits plain files into ./out
  output: "export",
};

export default nextConfig;
