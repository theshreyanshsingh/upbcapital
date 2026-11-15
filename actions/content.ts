"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { decideReview, submitReview } from "@/lib/reviews";
import { requireDesk } from "@/lib/staff";
import { prisma } from "@/lib/prisma";

// A review a party wrote after a completed closing is theirs: the desk publishes or declines it, and never edits or
// deletes it (lib/reviews.ts).
const CLOSING_REVIEW = "That is a closing review. Publish or decline it; its words and record stay as written.";

async function closingReview(id: string) {
  return Boolean((await prisma.testimonial.findUnique({ where: { id }, select: { closingId: true } }))?.closingId);
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

export async function savePost(formData: FormData) {
  const user = await requireDesk("content", "/admin/blog");
  const title = String(formData.get("title") || "").trim();
  const body = String(formData.get("body") || "").trim();
  const excerpt = String(formData.get("excerpt") || "").trim();
  const slug = slugify(String(formData.get("slug") || title));
  if (title.length < 3 || body.length < 20 || slug.length < 3) redirect("/admin/blog?error=A post needs a title, a slug, and a body.");
  const published = formData.get("published") === "on";
  await prisma.post.upsert({
    where: { slug },
    create: { slug, title, excerpt, body, authorId: user.id, publishedAt: published ? new Date() : null },
    update: { title, excerpt, body, publishedAt: published ? new Date() : null },
  });
  redirect("/admin/blog?notice=post");
}

export async function saveTestimonial(formData: FormData) {
  const user = await requireDesk("content", "/admin/blog");
  const quote = String(formData.get("quote") || "").trim();
  const role = String(formData.get("role") || "").trim();
  const place = String(formData.get("place") || "").trim();
  if (quote.length < 12 || role.length < 2) redirect("/admin/blog?error=A testimonial needs a quote and a role.");
  const row = await prisma.testimonial.create({ data: { quote, role, place, published: true } });
  await audit(user.id, "TESTIMONIAL_ADD", "testimonial", row.id, role);
  revalidatePath("/");
  redirect("/admin/blog?notice=testimonial");
}

export async function updateTestimonial(formData: FormData) {
  const user = await requireDesk("content", "/admin/blog");
  const id = String(formData.get("id") || "");
  const quote = String(formData.get("quote") || "").trim();
  const role = String(formData.get("role") || "").trim();
  const place = String(formData.get("place") || "").trim();
  if (quote.length < 12 || role.length < 2) redirect("/admin/blog?error=A testimonial needs a quote and a role.");
  if (await closingReview(id)) redirect(`/admin/blog?error=${encodeURIComponent(CLOSING_REVIEW)}`);
  await prisma.testimonial.update({ where: { id }, data: { quote, role, place } });
  await audit(user.id, "TESTIMONIAL_EDIT", "testimonial", id, role);
  revalidatePath("/");
  redirect("/admin/blog?notice=testimonial");
}

export async function setTestimonialPublished(formData: FormData) {
  const user = await requireDesk("content", "/admin/blog");
  const id = String(formData.get("id") || "");
  const published = formData.get("published") === "yes";
  if (await closingReview(id)) redirect(`/admin/blog?error=${encodeURIComponent(CLOSING_REVIEW)}`);
  await prisma.testimonial.update({ where: { id }, data: { published } });
  await audit(user.id, published ? "TESTIMONIAL_PUBLISH" : "TESTIMONIAL_UNPUBLISH", "testimonial", id);
  revalidatePath("/");
  redirect("/admin/blog?notice=testimonial");
}

export async function deleteTestimonial(formData: FormData) {
  const user = await requireDesk("content", "/admin/blog");
  const id = String(formData.get("id") || "");
  if (await closingReview(id)) redirect(`/admin/blog?error=${encodeURIComponent(CLOSING_REVIEW)}`);
  await prisma.testimonial.deleteMany({ where: { id } });
  await audit(user.id, "TESTIMONIAL_DELETE", "testimonial", id);
  revalidatePath("/");
  redirect("/admin/blog?notice=testimonial");
}

// The desk's two answers to a closing review. Either keeps the words as written; a declined review stays on file.
export async function decideClosingReview(formData: FormData) {
  const user = await requireDesk("content", "/admin/blog");
  const result = await decideReview(user, { id: String(formData.get("id") || ""), publish: formData.get("decision") === "publish" });
  if (result.error !== null) redirect(`/admin/blog?error=${encodeURIComponent(result.error)}`);
  revalidatePath("/");
  redirect("/admin/blog?notice=testimonial");
}

// The public review form. No sign-in: the signed link from the request names the closing, the side and the account.
export async function submitClosingReview(formData: FormData) {
  const token = String(formData.get("token") || "");
  const result = await submitReview({ token, text: String(formData.get("review") || "") });
  const page = `/review?token=${encodeURIComponent(token)}`;
  if (result.error !== null) redirect(`${page}&error=${encodeURIComponent(result.error)}`);
  redirect(`${page}&done=1`);
}
