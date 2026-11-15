import { decideClosingReview, deleteTestimonial, savePost, saveTestimonial, setTestimonialPublished, updateTestimonial } from "@/actions/content";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { prettyDate, q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { reviewStates, testimonialByline, type ReviewState } from "@/lib/reviews";
import { deskCan } from "@/lib/staff";
import { ensureStories } from "@/lib/stories";

export const metadata = { title: "Journal" };

export default async function BlogAdminPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Every desk role reads the journal. Writing it is content work, and the actions check the same.
  const writes = deskCan(await requireRole(["ADMIN"]), "content");
  await ensureStories();
  const query = await searchParams;
  const [posts, quotes] = await Promise.all([
    prisma.post.findMany({ orderBy: { updatedAt: "desc" } }),
    prisma.testimonial.findMany({ orderBy: { createdAt: "desc" } }),
  ]);
  // Reviews from parties to completed closings: their state, the month each trade closed, and who decided.
  const reviews = quotes.filter((quote) => quote.closingId);
  const [states, closings] = await Promise.all([
    reviewStates(reviews.map((quote) => quote.id)),
    prisma.closing.findMany({ where: { id: { in: reviews.map((quote) => quote.closingId!) } }, select: { id: true, closedAt: true } }),
  ]);
  const deciders = await prisma.user.findMany({ where: { id: { in: [...states.values()].flatMap((row) => (row.by ? [row.by] : [])) } }, select: { id: true, name: true } });
  const closedAt = new Map(closings.map((closing) => [closing.id, closing.closedAt]));
  return (
    <div>
      <PageIntro eyebrow="Journal" title="Posts and testimonials." lede="Published posts appear at /blog. The two newest published testimonials appear on the home page. Add one only when a real client agrees to be quoted. Rows whose role starts with Placeholder never show publicly. Reviews from the buyer or seller of a completed closing arrive on their own: publish or decline each, as written." />
      <Notice notice={q(query, "notice")} error={q(query, "error")} />
      {writes ? (
        <form action={savePost} className="mt-8 grid max-w-2xl gap-3">
          <input name="title" className="desk-input" aria-label="Post title" placeholder="Title" required />
          <input name="slug" className="desk-input" aria-label="Slug" placeholder="slug, optional" />
          <input name="excerpt" className="desk-input" aria-label="Excerpt" placeholder="Excerpt" />
          <textarea name="body" className="desk-input min-h-40" aria-label="Post body" placeholder="Body. Blank lines start a new paragraph." required />
          <label className="flex items-center gap-3 text-sm text-foreground"><input type="checkbox" name="published" value="on" defaultChecked /> Publish</label>
          <SubmitButton className="h-11 text-[13px] font-medium">Save post</SubmitButton>
        </form>
      ) : (
        <p className="mt-8 text-sm text-muted-foreground">Posts and testimonials are written by the content side of the desk.</p>
      )}
      <ul className="mt-8 space-y-2 text-sm text-muted-foreground">
        {posts.map((post) => (
          <li key={post.id}>{post.publishedAt ? "Live" : "Draft"} · {post.title} · {post.publishedAt ? prettyDate(post.publishedAt) : "unpublished"}</li>
        ))}
      </ul>
      {writes ? (
        <form action={saveTestimonial} className="mt-10 grid max-w-2xl gap-3">
          <p className="eyebrow">New testimonial</p>
          <input name="role" className="desk-input" aria-label="Role" placeholder="Role" required />
          <input name="place" className="desk-input" aria-label="Place" placeholder="City" />
          <textarea name="quote" className="desk-input min-h-24" aria-label="Quote" placeholder="Quote" required />
          <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">Add testimonial</SubmitButton>
        </form>
      ) : (
        <p className="eyebrow mt-10">Testimonials</p>
      )}
      <ul className="mt-6 max-w-2xl space-y-4">
        {quotes.length === 0 && <li className="text-sm text-muted-foreground">No testimonials yet. The home page leaves the section out.</li>}
        {quotes.map((quote) => quote.closingId ? (
          <ReviewRow
            key={quote.id}
            quote={quote}
            review={states.get(quote.id)}
            byline={testimonialByline(quote, closedAt.get(quote.closingId) ?? null)}
            decider={deciders.find((user) => user.id === states.get(quote.id)?.by)?.name ?? null}
            writes={writes}
          />
        ) : (
          <li key={quote.id} className="border border-border p-4 rounded-xl">
            <p className="text-[13px] font-medium text-muted-foreground">{quote.role.startsWith("Placeholder") ? "Placeholder, never shown" : quote.published ? "Live" : "Hidden"}</p>
            {writes ? (
              <>
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
              </>
            ) : (
              <div className="mt-2 text-sm">
                <p className="text-foreground">{quote.quote}</p>
                <p className="mt-1 text-muted-foreground">{quote.role}{quote.place ? ` · ${quote.place}` : ""}</p>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// A review from a party to a completed closing: shown as written, with no edit and no delete. The desk publishes or
// declines it, and a declined review stays on file (lib/reviews.ts).
function ReviewRow({
  quote,
  review,
  byline,
  decider,
  writes,
}: {
  quote: { id: string; quote: string; createdAt: Date };
  review: { state: ReviewState; at: Date | null } | undefined;
  byline: string;
  decider: string | null;
  writes: boolean;
}) {
  const state = review?.state ?? "WAITING";
  const status = state === "PUBLISHED" ? "Review, live" : state === "DECLINED" ? "Review, declined" : "Review, waiting for the desk";
  return (
    <li className="border border-border p-4 rounded-xl">
      <p className="text-[13px] font-medium text-muted-foreground">
        {status}
        {review?.at && state !== "WAITING" ? ` · ${prettyDate(review.at)}${decider ? ` by ${decider}` : ""}` : ""}
      </p>
      <div className="mt-2 text-sm">
        <p className="whitespace-pre-wrap text-foreground">{quote.quote}</p>
        <p className="mt-1 text-muted-foreground">{byline} · received {prettyDate(quote.createdAt)}</p>
      </div>
      {writes && (
        <div className="mt-2 flex flex-wrap gap-2">
          {state !== "PUBLISHED" && (
            <form action={decideClosingReview}>
              <input type="hidden" name="id" value={quote.id} />
              <input type="hidden" name="decision" value="publish" />
              <SubmitButton variant="ghost" className="h-9 text-[13px] font-medium">Publish</SubmitButton>
            </form>
          )}
          {state !== "DECLINED" && (
            <form action={decideClosingReview}>
              <input type="hidden" name="id" value={quote.id} />
              <input type="hidden" name="decision" value="decline" />
              <SubmitButton variant="ghost" className="h-9 text-[13px] font-medium">Decline</SubmitButton>
            </form>
          )}
        </div>
      )}
      <p className="mt-2 text-xs text-muted-foreground">Written by the party and shown as written. A declined review stays on file.</p>
    </li>
  );
}
