import type { MetadataRoute } from "next";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:4317";
  const [listings, posts] = await Promise.all([
    prisma.listing.findMany({
      where: { status: { in: ["APPROVED", "PENDING"] } },
      select: { id: true, updatedAt: true },
    }),
    prisma.post.findMany({ where: { publishedAt: { not: null } }, select: { slug: true, updatedAt: true } }),
  ]);
  const staticPaths = ["", "/learn", "/learn/what-is-a-note", "/learn/buying", "/learn/selling", "/faq", "/blog", "/developers", "/sell", "/signup", "/login"];
  return [
    ...staticPaths.map((path) => ({ url: `${base}${path || "/"}`, changeFrequency: "weekly" as const, priority: path === "" ? 1 : 0.6 })),
    ...listings.map((listing) => ({
      url: `${base}/open/${listing.id}`,
      lastModified: listing.updatedAt,
    })),
    ...posts.map((post) => ({ url: `${base}/blog/${post.slug}`, lastModified: post.updatedAt, changeFrequency: "monthly" as const, priority: 0.5 })),
  ];
}
