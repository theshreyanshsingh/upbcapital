import { savePost, saveTestimonial } from "@/actions/content";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { prettyDate, q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { ensureStories } from "@/lib/stories";

export const metadata = { title: "Journal" };

export default async function BlogAdminPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireRole(["ADMIN"]);
  await ensureStories();
  const query = await searchParams;
  const [posts, quotes] = await Promise.all([
    prisma.post.findMany({ orderBy: { updatedAt: "desc" } }),
    prisma.testimonial.findMany({ orderBy: { createdAt: "desc" } }),
  ]);
  return (
    <div>
      <PageIntro eyebrow="Journal" title="Posts and placeholders." lede="Published posts appear at /blog. Testimonials on the home page are labeled placeholders until a real client is named." />
      <Notice notice={q(query, "notice")} error={q(query, "error")} />
      <form action={savePost} className="mt-8 grid max-w-2xl gap-3">
        <input name="title" className="desk-input" aria-label="Post title" placeholder="Title" required />
        <input name="slug" className="desk-input" aria-label="Slug" placeholder="slug, optional" />
        <input name="excerpt" className="desk-input" aria-label="Excerpt" placeholder="Excerpt" />
        <textarea name="body" className="desk-input min-h-40" aria-label="Post body" placeholder="Body. Blank lines start a new paragraph." required />
        <label className="flex items-center gap-3 text-sm text-foreground"><input type="checkbox" name="published" value="on" defaultChecked /> Publish</label>
        <SubmitButton className="h-11 text-[13px] font-medium">Save post</SubmitButton>
      </form>
      <ul className="mt-8 space-y-2 text-sm text-muted-foreground">
        {posts.map((post) => (
          <li key={post.id}>{post.publishedAt ? "Live" : "Draft"} · {post.title} · {post.publishedAt ? prettyDate(post.publishedAt) : "unpublished"}</li>
        ))}
      </ul>
      <form action={saveTestimonial} className="mt-10 grid max-w-2xl gap-3">
        <p className="eyebrow">Testimonial placeholder</p>
        <input name="role" className="desk-input" aria-label="Role" placeholder="Role" required />
        <input name="place" className="desk-input" aria-label="Place" placeholder="City" />
        <textarea name="quote" className="desk-input min-h-24" aria-label="Quote" placeholder="Quote" required />
        <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">Add placeholder</SubmitButton>
      </form>
      <ul className="mt-6 space-y-2 text-sm text-muted-foreground">
        {quotes.map((quote) => <li key={quote.id}>{quote.role} · {quote.place}</li>)}
      </ul>
    </div>
  );
}
