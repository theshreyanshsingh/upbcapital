"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { isTemplateKey } from "@/lib/templates";
import { prisma } from "@/lib/prisma";

export async function saveTemplate(formData: FormData) {
  await requireRole(["ADMIN"]);
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
  revalidatePath("/admin/templates");
  revalidatePath("/closings");
  redirect("/admin/templates?notice=template");
}
