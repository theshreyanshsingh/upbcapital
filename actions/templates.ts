"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { DEFAULT_TEMPLATES } from "@/lib/closing-docs";
import { requireDesk } from "@/lib/staff";
import { isTemplateKey } from "@/lib/templates";
import { prisma } from "@/lib/prisma";

export async function saveTemplate(formData: FormData) {
  const user = await requireDesk("admin", "/admin/templates");
  const key = String(formData.get("key") || "");
  const title = String(formData.get("title") || "").trim();
  const body = String(formData.get("body") || "").trim();
  if (!isTemplateKey(key)) redirect("/admin/templates");
  if (title.length < 3 || title.length > 120) redirect("/admin/templates?error=Give the form a short title.");
  if (body.length < 20 || body.length > 8000) redirect("/admin/templates?error=Keep the form between a short paragraph and 8,000 characters.");
  await prisma.documentTemplate.upsert({
    where: { key },
    update: { title, body },
    create: { key, title, body },
  });
  await audit(user.id, "TEMPLATE", "template", key, title);
  revalidatePath("/admin/templates");
  revalidatePath("/closings");
  redirect("/admin/templates?notice=template");
}

// A saved form overrides the built-in one, so a database from before a change to the built-in text keeps the old
// wording until someone puts the current default back.
export async function resetTemplate(formData: FormData) {
  const user = await requireDesk("content", "/admin/templates");
  const key = String(formData.get("key") || "");
  if (!isTemplateKey(key)) redirect("/admin/templates");
  const fallback = DEFAULT_TEMPLATES[key];
  await prisma.documentTemplate.upsert({
    where: { key },
    update: { title: fallback.title, body: fallback.body },
    create: { key, title: fallback.title, body: fallback.body },
  });
  await audit(user.id, "TEMPLATE_RESET", "template", key, `${fallback.title} reset to the built-in form.`);
  revalidatePath("/admin/templates");
  revalidatePath("/closings");
  redirect(`/admin/templates?notice=${encodeURIComponent(`${fallback.title} is back to the built-in form.`)}`);
}
