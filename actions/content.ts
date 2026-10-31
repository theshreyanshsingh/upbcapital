"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

export async function savePost(formData: FormData) {
  const user = await requireRole(["ADMIN"]);
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
  const user = await requireRole(["ADMIN"]);
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
  const user = await requireRole(["ADMIN"]);
  const id = String(formData.get("id") || "");
  const quote = String(formData.get("quote") || "").trim();
  const role = String(formData.get("role") || "").trim();
  const place = String(formData.get("place") || "").trim();
  if (quote.length < 12 || role.length < 2) redirect("/admin/blog?error=A testimonial needs a quote and a role.");
  await prisma.testimonial.update({ where: { id }, data: { quote, role, place } });
  await audit(user.id, "TESTIMONIAL_EDIT", "testimonial", id, role);
  revalidatePath("/");
  redirect("/admin/blog?notice=testimonial");
}

export async function setTestimonialPublished(formData: FormData) {
  const user = await requireRole(["ADMIN"]);
  const id = String(formData.get("id") || "");
  const published = formData.get("published") === "yes";
  await prisma.testimonial.update({ where: { id }, data: { published } });
  await audit(user.id, published ? "TESTIMONIAL_PUBLISH" : "TESTIMONIAL_UNPUBLISH", "testimonial", id);
  revalidatePath("/");
  redirect("/admin/blog?notice=testimonial");
}

export async function deleteTestimonial(formData: FormData) {
  const user = await requireRole(["ADMIN"]);
  const id = String(formData.get("id") || "");
  await prisma.testimonial.deleteMany({ where: { id } });
  await audit(user.id, "TESTIMONIAL_DELETE", "testimonial", id);
  revalidatePath("/");
  redirect("/admin/blog?notice=testimonial");
}
