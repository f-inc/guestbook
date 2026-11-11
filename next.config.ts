import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["haseab--3030.getbb.app", "127.0.0.1"],
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
