import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const base = process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:4317";
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/open/", "/learn", "/faq", "/blog", "/developers", "/login", "/signup", "/sell"],
      disallow: ["/admin", "/marketplace", "/seller", "/buyer", "/closings", "/account", "/notifications"],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
