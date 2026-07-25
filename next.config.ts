import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep Puppeteer (and its Chromium) out of the server bundle so it loads from
  // node_modules at runtime instead of being traced/bundled by the compiler.
  serverExternalPackages: ["puppeteer"],
};

export default nextConfig;
