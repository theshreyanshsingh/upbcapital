import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicPage } from "@/components/public-page";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const post = await prisma.post.findUnique({ where: { slug } });
  if (!post) return { title: "Journal" };
  return { title: post.title, description: post.excerpt || post.title };
}

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = await prisma.post.findUnique({ where: { slug } });
  if (!post || !post.publishedAt) notFound();
  return (
    <PublicPage title={post.title} lede={post.excerpt}>
      {post.body.split(/\n\n+/).map((paragraph) => (
        <p key={paragraph.slice(0, 24)}>{paragraph}</p>
      ))}
    </PublicPage>
  );
}
