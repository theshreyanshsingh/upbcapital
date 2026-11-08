import type { NextConfig } from "next";

// Sent on every response. There is no full Content-Security-Policy: the theme script in app/layout.tsx runs inline
// and Next.js adds inline scripts of its own, so a script policy needs nonces first. frame-ancestors alone is safe,
// and stops another site framing the desk. No page uses the camera, microphone or location, and the PWA's push and
// service worker need none of them.
export function securityHeaders(appUrl = process.env.NEXT_PUBLIC_APP_URL || "") {
  const headers = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ];
  // Only an https origin may promise browsers https next time. An internal http server would lock them out. Without
  // includeSubDomains, so other hosts on a custom domain are untouched.
  if (/^https:\/\//i.test(appUrl.trim())) headers.push({ key: "Strict-Transport-Security", value: "max-age=31536000" });
  return headers;
}

// The one page another site may frame: a broker's intake form at /embed/intake/[code]. Next keeps a header set here
// over one the route sets, so the site-wide rule skips exactly that path, and the route sends frame-ancestors with the
// broker's own sites, or 'none' (lib/broker-widget.ts). Deeper paths under it, and everything else, keep 'none'.
export const FRAMED_SOURCE = "/embed/intake/:code";
export const SITE_SOURCE = "/:path((?!embed/intake/[^/]+$).*)";

export function framedHeaders(appUrl = process.env.NEXT_PUBLIC_APP_URL || "") {
  return securityHeaders(appUrl).filter((header) => header.key !== "X-Frame-Options" && header.key !== "Content-Security-Policy");
}

const nextConfig: NextConfig = {
  serverExternalPackages: ["bcryptjs", "xlsx", "@aws-sdk/client-s3", "nodemailer"],
  experimental: {
    serverActions: {
      bodySizeLimit: "25mb",
    },
  },
  async headers() {
    return [
      { source: SITE_SOURCE, headers: securityHeaders() },
      { source: FRAMED_SOURCE, headers: framedHeaders() },
    ];
  },
};

export default nextConfig;
