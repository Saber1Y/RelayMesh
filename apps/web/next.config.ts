import { loadEnvConfig } from "@next/env";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The monorepo keeps one .env at the repository root (DATABASE_URL, V3 endpoints). Next.js has already
// loaded (and cached) env for apps/web, so forceReload is needed for the root directory to be read.
loadEnvConfig(fileURLToPath(new URL("../..", import.meta.url)), process.env.NODE_ENV !== "production", undefined, true);

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript sources.
  transpilePackages: ["@relaymesh/core", "@relaymesh/db", "@relaymesh/routes", "@relaymesh/chains", "@relaymesh/contracts"],
  // Server-only drivers stay as Node modules instead of being bundled.
  serverExternalPackages: ["postgres"],
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
