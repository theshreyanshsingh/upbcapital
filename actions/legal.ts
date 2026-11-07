"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { requireDesk } from "@/lib/staff";
import { LEGAL_PATHS, acceptTerms, isLegalKey, raiseLegalVersion } from "@/lib/legal";
import { prisma } from "@/lib/prisma";

// An account that still has to set up two-step sign-in may accept too. Accepting opens nothing.
export async function acceptLegal() {
  const user = await requireUser({ secondFactorSetup: true });
  const version = await acceptTerms(user.id);
  revalidatePath("/", "layout");
  redirect(`/terms?notice=${encodeURIComponent(`Thanks. Version ${version} is accepted on your account.`)}`);
}

export async function saveLegal(formData: FormData) {
  const user = await requireDesk("admin", "/admin/templates");
  const key = String(formData.get("key") || "");
  const title = String(formData.get("title") || "").trim();
  const body = String(formData.get("body") || "").trim();
  if (!isLegalKey(key)) redirect("/admin/templates");
  if (title.length < 3 || title.length > 120) redirect("/admin/templates?error=Give the page a short title.");
  if (body.length < 20 || body.length > 40000) redirect("/admin/templates?error=Keep the page between a short paragraph and 40,000 characters.");
  await prisma.documentTemplate.upsert({ where: { key }, update: { title, body }, create: { key, title, body } });
  await audit(user.id, "LEGAL_SAVED", "template", key, title);
  const version = formData.get("reaccept") === "yes" ? await raiseLegalVersion(user.id) : null;
  revalidatePath("/admin/templates");
  revalidatePath(LEGAL_PATHS[key]);
  if (version) revalidatePath("/", "layout");
  const notice = version ? `${title} is saved. Every account is asked to accept version ${version}.` : `${title} is saved. Accounts keep the version they accepted.`;
  redirect(`/admin/templates?notice=${encodeURIComponent(notice)}`);
}
