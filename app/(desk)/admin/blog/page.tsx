import { deleteTestimonial, savePost, saveTestimonial, setTestimonialPublished, updateTestimonial } from "@/actions/content";
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
      <PageIntro eyebrow="Journal" title="Posts and testimonials." lede="Published posts appear at /blog. The two newest published testimonials appear on the home page. Add one only when a real client agrees to be quoted. Rows whose role starts with Placeholder never show publicly." />
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
        <p className="eyebrow">New testimonial</p>
        <input name="role" className="desk-input" aria-label="Role" placeholder="Role" required />
        <input name="place" className="desk-input" aria-label="Place" placeholder="City" />
        <textarea name="quote" className="desk-input min-h-24" aria-label="Quote" placeholder="Quote" required />
        <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">Add testimonial</SubmitButton>
      </form>
      <ul className="mt-6 max-w-2xl space-y-4">
        {quotes.length === 0 && <li className="text-sm text-muted-foreground">No testimonials yet. The home page leaves the section out.</li>}
        {quotes.map((quote) => (
          <li key={quote.id} className="border border-border p-4 rounded-xl">
            <p className="text-[13px] font-medium text-muted-foreground">{quote.role.startsWith("Placeholder") ? "Placeholder, never shown" : quote.published ? "Live" : "Hidden"}</p>
            <form action={updateTestimonial} className="mt-2 grid gap-2">
              <input type="hidden" name="id" value={quote.id} />
              <input name="role" defaultValue={quote.role} className="desk-input" aria-label="Role" required />
              <input name="place" defaultValue={quote.place} className="desk-input" aria-label="Place" />
              <textarea name="quote" defaultValue={quote.quote} className="desk-input min-h-20" aria-label="Quote" required />
              <SubmitButton variant="outline" className="h-9 w-fit text-[13px] font-medium">Save changes</SubmitButton>
            </form>
            <div className="mt-2 flex flex-wrap gap-2">
              <form action={setTestimonialPublished}>
                <input type="hidden" name="id" value={quote.id} />
                <input type="hidden" name="published" value={quote.published ? "no" : "yes"} />
                <SubmitButton variant="ghost" className="h-9 text-[13px] font-medium">{quote.published ? "Hide" : "Publish"}</SubmitButton>
              </form>
              <form action={deleteTestimonial}>
                <input type="hidden" name="id" value={quote.id} />
                <SubmitButton variant="ghost" className="h-9 text-[13px] font-medium text-bad">Delete</SubmitButton>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
