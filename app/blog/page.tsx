import type { Metadata } from "next";
import Link from "next/link";
import { PublicPage } from "@/components/public-page";
import { prettyDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { ensureStories } from "@/lib/stories";

export const metadata: Metadata = {
  title: "Journal",
  description: "Notes from the UPB Capital desk on trading mortgage paper.",
};

export const dynamic = "force-dynamic";

export default async function BlogPage() {
  await ensureStories();
  const posts = await prisma.post.findMany({ where: { publishedAt: { not: null } }, orderBy: { publishedAt: "desc" } });
  return (
    <PublicPage title="From the desk." lede="Short notes on how paper is priced and how a file moves. Nothing here is an offer to sell a security.">
      <ul className="space-y-6">
        {posts.map((post) => (
          <li key={post.id}>
            <Link href={`/blog/${post.slug}`} className="font-semibold tracking-tight text-3xl text-foreground">{post.title}</Link>
            <p className="mt-2 text-sm text-muted-foreground">{post.publishedAt ? prettyDate(post.publishedAt) : ""} · {post.excerpt}</p>
          </li>
        ))}
      </ul>
    </PublicPage>
  );
}
