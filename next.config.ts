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

const nextConfig: NextConfig = {
  serverExternalPackages: ["bcryptjs", "xlsx", "@aws-sdk/client-s3", "nodemailer"],
  experimental: {
    serverActions: {
      bodySizeLimit: "25mb",
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  },
};

export default nextConfig;
