"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { screenInBackground } from "@/lib/screening";
import {
  SELLER_FILE_HREF,
  decideSellerIdentity,
  keepsSellerFile,
  recordSellerVendor,
  screenSellerIdentity,
  sellerFileLocked,
  submitSellerIdentity,
} from "@/lib/seller-identity";
import { clearSettingsCache, getSettings } from "@/lib/settings";
import { requireDesk } from "@/lib/staff";
import { startKyc } from "@/lib/vendors";

function sellerBack(kind: "notice" | "error", message: string): never {
  redirect(`/seller/verification?${kind}=${encodeURIComponent(message)}`);
}

async function requireSeller() {
  const user = await requireUser();
  if (!keepsSellerFile(user.role)) redirect(user.role === "ADMIN" ? SELLER_FILE_HREF : "/");
  return user;
}

export async function submitSellerFile(formData: FormData) {
  const user = await requireSeller();
  const sent = await submitSellerIdentity(user, formData);
  if (sent.error) sellerBack("error", sent.error);
  // Like a buyer file, the screen runs after the reply. The desk's approval screens again and waits for the answer.
  screenInBackground(() => screenSellerIdentity(user.id, "Seller file"));
  revalidatePath("/seller");
  revalidatePath("/broker");
  revalidatePath("/seller/verification");
  revalidatePath(SELLER_FILE_HREF);
  sellerBack("notice", "Your seller file is with the desk.");
}

export async function startSellerKyc() {
  const user = await requireSeller();
  const profile = await prisma.sellerProfile.findUnique({ where: { userId: user.id }, select: { status: true } });
  const locked = sellerFileLocked(profile?.status);
  if (locked) sellerBack("error", locked);
  let started;
  try {
    started = await startKyc({ userId: user.id, email: user.email, name: user.name });
  } catch (error) {
    sellerBack("error", error instanceof Error ? error.message : "The verification vendor did not respond.");
  }
  if (!started.url) sellerBack("error", "Vendor keys are not set. Use the form below.");
  const opened = await recordSellerVendor(user, started);
  if (opened.error) sellerBack("error", opened.error);
  redirect(started.url);
}

export async function reviewSellerFile(formData: FormData) {
  const reviewer = await requireDesk("compliance", SELLER_FILE_HREF);
  const userId = String(formData.get("userId") || "");
  const decided = await decideSellerIdentity(reviewer, {
    userId,
    decision: String(formData.get("decision") || ""),
    note: String(formData.get("reviewerNote") || ""),
    seen: String(formData.get("seen") || "") || undefined,
  });
  const anchor = `#seller-${encodeURIComponent(userId)}`;
  if (decided.error) redirect(`${SELLER_FILE_HREF}?error=${encodeURIComponent(decided.error)}${anchor}`);
  revalidatePath(SELLER_FILE_HREF);
  revalidatePath("/seller");
  revalidatePath("/broker");
  revalidatePath("/seller/verification");
  const said = decided.status === "APPROVED" ? "Seller file approved." : decided.status === "REJECTED" ? "Seller file declined." : "Changes requested.";
  redirect(`${SELLER_FILE_HREF}?notice=${encodeURIComponent(`${said} The seller is told.`)}${anchor}`);
}

const SETTING_VALUES: Record<string, boolean | null> = { on: true, off: false, default: null };
const settingLabel = (value: boolean | null | undefined) => (value === true ? "on" : value === false ? "off" : "the default");

// The seller identity gate on the desk's listing approval: on, off, or the default, which is on in release builds.
export async function saveSellerIdentitySetting(formData: FormData) {
  const actor = await requireDesk("admin", "/admin/settings");
  const chosen = String(formData.get("requireSellerIdentity") || "");
  if (!Object.hasOwn(SETTING_VALUES, chosen)) redirect(`/admin/settings?error=${encodeURIComponent("Choose on, off or the default.")}#seller-identity`);
  const value = SETTING_VALUES[chosen];
  const before = (await getSettings()).requireSellerIdentity;
  await prisma.platformSettings.upsert({ where: { id: "default" }, update: { requireSellerIdentity: value }, create: { id: "default", requireSellerIdentity: value } });
  clearSettingsCache();
  await audit(actor.id, "SELLER_IDENTITY_SETTING", "settings", "default", `Seller identity gate ${settingLabel(before)} to ${settingLabel(value)}.`);
  revalidatePath("/admin/settings");
  redirect(`/admin/settings?notice=${encodeURIComponent(`The seller identity gate is ${settingLabel(value)}.`)}#seller-identity`);
}
