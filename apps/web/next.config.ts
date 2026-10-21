import type { NextConfig } from "next";

// Public API paths are rewritten onto one catch-all route that hosts edgestash.
const mounts = ["/api/blob", "/redis", "/s", "/api/admin", "/healthz", "/metrics"];

const config: NextConfig = {
  serverExternalPackages: ["edgestash", "fengari"],
  // The Blob SDK calls "/api/blob/?pathname=..."; a trailing slash redirect would break PUT bodies.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return mounts.flatMap((m) => [
      { source: m, destination: `/es${m}` },
      { source: `${m}/:path*`, destination: `/es${m}/:path*` },
    ]);
  },
};
export default config;
