"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { InvestorEntity } from "@prisma/client";
import { audit } from "@/lib/audit";
import { addBeneficialOwner, fileGaps, removeBeneficialOwner } from "@/lib/beneficial-owners";
import { confirmRecertification, reviewBuyerFile } from "@/lib/buyer-file";
import { ROAD_THRESHOLD, readEligibility, reoStrategyLabel } from "@/lib/eligibility";
import { prettyDate } from "@/lib/format";
import { MAIN_FILE_ENTITIES } from "@/lib/labels";
import { requireUser } from "@/lib/auth";
import { requireDesk } from "@/lib/staff";
import { notifyDesk } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { screenInBackground, screenUser } from "@/lib/screening";
import { clearSettingsCache, getSettings } from "@/lib/settings";
import { extensionOf, mimeFor, putBytes, safeBasename } from "@/lib/storage";
import { uploadProblem } from "@/lib/uploads";
import { ACCREDITATION_TEXT, VENDOR_LOCKED, readTaxIdLast4, recertOpen, recertifyMonthsOf, vendorBlocked } from "@/lib/verification";
import { startKyc } from "@/lib/vendors";

// The main file is never an IRA. An IRA is added as another buying entity, with its custodian and account title.
const ENTITIES = new Set<string>(MAIN_FILE_ENTITIES.map((entity) => entity.value));

export async function submitVerification(formData: FormData) {
  const user = await requireUser();
  if (user.role !== "BUYER") redirect("/");
  if (user.accountStatus === "REJECTED") redirect("/buyer/pending");
  const entityType = String(formData.get("entityType") || "");
  const entityName = String(formData.get("entityName") || "").trim();
  const jurisdiction = String(formData.get("jurisdiction") || "").trim();
  const accredited = String(formData.get("accredited") || "") === "yes";
  if (!ENTITIES.has(entityType) || entityName.length < 2 || jurisdiction.length < 2) {
    redirect("/buyer/verification?error=Name the investing entity and where it is formed.");
  }
  if (!accredited) redirect("/buyer/verification?error=Offers require the accredited-investor certification.");
  // The last four only. Anything longer is refused rather than cut down, so the whole number is never kept.
  const taxId = readTaxIdLast4(formData.get("taxIdLast4"));
  if (taxId.error !== null) redirect(`/buyer/verification?error=${encodeURIComponent(taxId.error)}`);
  // An entity lists its owners and a control person before the file goes to the desk.
  const gaps = await fileGaps(user.id, null, entityType);
  if (gaps.length) redirect(`/buyer/verification?error=${encodeURIComponent(`${gaps.join(" ")} Add them under Owners, then submit.`)}#owners`);
  // An approved buyer's form leaves the two eligibility questions to their own form, so resubmitting keeps the answers.
  let eligibility: { homesControlled: number; reoStrategy: string; eligibilityAt: Date } | null = null;
  if (formData.has("homesControlled")) {
    const read = readEligibility(String(formData.get("homesControlled") || ""), String(formData.get("reoStrategy") || ""));
    if (read.error !== null) redirect(`/buyer/verification?error=${encodeURIComponent(read.error)}`);
    eligibility = { homesControlled: read.homesControlled, reoStrategy: read.reoStrategy, eligibilityAt: new Date() };
  }
  const proofAmount = Number(String(formData.get("proofAmount") || "").replace(/[$,\s]/g, ""));
  if (!Number.isFinite(proofAmount) || proofAmount <= 0 || proofAmount > 10_000_000_000) {
    redirect("/buyer/verification?error=Enter the amount your proof of funds shows.");
  }
  const file = formData.get("proof");
  let proofKey = "";
  let proofName = "";
  let proofMime = "";
  const existing = await prisma.buyerProfile.findUnique({ where: { userId: user.id } });
  const wasDue = recertOpen(existing);
  const proofExpired = Boolean(existing?.proofExpiresAt && existing.proofExpiresAt.getTime() < Date.now());
  if (file instanceof File && file.size > 0) {
    const bytes = Buffer.from(await file.arrayBuffer());
    const problem = uploadProblem(file.name, bytes.length, bytes);
    const ext = extensionOf(file.name);
    if (problem || !ext || !["pdf", "png", "jpg", "jpeg", "webp"].includes(ext)) {
      redirect("/buyer/verification?error=Upload a PDF or image under 15 MB.");
    }
    proofKey = `verification/${user.id}/${crypto.randomUUID()}-${safeBasename(file.name)}`;
    proofName = file.name.slice(0, 180);
    proofMime = mimeFor(ext, file.type || "application/octet-stream");
    await putBytes(proofKey, bytes, proofMime);
  } else if (!existing?.proofKey) {
    redirect("/buyer/verification?error=Upload proof of funds.");
  } else if (proofExpired) {
    // The desk's date on the proof has passed, so the file goes back with a fresh one.
    redirect(`/buyer/verification?error=${encodeURIComponent(`Your proof of funds expired on ${prettyDate(existing.proofExpiresAt)}. Upload a fresh one.`)}`);
  } else {
    proofKey = existing.proofKey;
    proofName = existing.proofName;
    proofMime = existing.proofMime;
  }
  await prisma.buyerProfile.upsert({
    where: { userId: user.id },
    update: {
      entityType: entityType as InvestorEntity,
      entityName,
      jurisdiction,
      accredited: true,
      certificationText: ACCREDITATION_TEXT,
      proofKey,
      proofName,
      proofMime,
      proofAmount,
      proofExpiresAt: null,
      proofVerifiedAt: null,
      taxIdLast4: taxId.value,
      status: "SUBMITTED",
      submittedAt: new Date(),
      reviewerNote: "",
      ...(eligibility ?? {}),
    },
    create: {
      userId: user.id,
      entityType: entityType as InvestorEntity,
      entityName,
      jurisdiction,
      accredited: true,
      certificationText: ACCREDITATION_TEXT,
      proofKey,
      proofName,
      proofMime,
      proofAmount,
      taxIdLast4: taxId.value,
      status: "SUBMITTED",
      submittedAt: new Date(),
      ...(eligibility ?? {}),
    },
  });
  if (wasDue) await audit(user.id, "RECERTIFIED", "user", user.id, "Updated with the form");
  screenInBackground(() => screenUser(user.id, "Buyer file"));
  if (eligibility) await audit(user.id, "ELIGIBILITY_ANSWERS", "user", user.id, `${eligibility.homesControlled} homes · ${reoStrategyLabel(eligibility.reoStrategy)}`);
  const homes = eligibility ? ` They state ${eligibility.homesControlled.toLocaleString("en-US")} single-family homes controlled.` : "";
  await notifyDesk(`Verification submitted · ${user.name}`, `${entityName} (${entityType}) in ${jurisdiction} is waiting on the desk.${homes}`);
  revalidatePath("/buyer/verification");
  revalidatePath("/admin/verification");
  redirect("/buyer/verification?notice=submitted_kyc");
}

// The two eligibility questions on their own, for a buyer whose file is already open. Saving them never reopens the
// file or changes its status. They are the buyer's own statement, recorded with the date.
export async function saveEligibility(formData: FormData) {
  const user = await requireUser();
  if (user.role !== "BUYER") redirect("/");
  const read = readEligibility(String(formData.get("homesControlled") || ""), String(formData.get("reoStrategy") || ""));
  if (read.error !== null) redirect(`/buyer/verification?error=${encodeURIComponent(read.error)}#eligibility`);
  const saved = await prisma.buyerProfile.updateMany({
    where: { userId: user.id },
    data: { homesControlled: read.homesControlled, reoStrategy: read.reoStrategy, eligibilityAt: new Date() },
  });
  if (saved.count !== 1) redirect(`/buyer/verification?error=${encodeURIComponent("Start your buyer file below first.")}`);
  await audit(user.id, "ELIGIBILITY_ANSWERS", "user", user.id, `${read.homesControlled} homes · ${reoStrategyLabel(read.reoStrategy)}`);
  if (read.homesControlled >= ROAD_THRESHOLD) {
    await notifyDesk(
      `Eligibility answers · ${user.name}`,
      `${user.name} states ${read.homesControlled.toLocaleString("en-US")} single-family homes controlled, and ${reoStrategyLabel(read.reoStrategy).toLowerCase()} for homes taken by foreclosure. They acknowledge the ROAD Act notice before bidding on non-performing one- and two-unit loans.`,
    );
  }
  revalidatePath("/buyer/verification");
  revalidatePath("/admin/verification");
  redirect(`/buyer/verification?notice=${encodeURIComponent("Your answers are saved. Your file's status is unchanged.")}#eligibility`);
}

export async function reviewVerification(formData: FormData) {
  const reviewer = await requireDesk("compliance", "/admin/verification");
  const field = (key: string) => String(formData.get(key) || "");
  const result = await reviewBuyerFile(reviewer, {
    userId: field("userId"),
    decision: field("decision"),
    reviewerNote: field("reviewerNote"),
    proofAmount: field("proofAmount"),
    proofExpiresAt: field("proofExpiresAt"),
  });
  if (result.error !== null) redirect(`/admin/verification?error=${encodeURIComponent(result.error)}#buyer-${field("userId")}`);
  revalidatePath("/admin/verification");
  revalidatePath("/buyer/verification");
  redirect("/admin/verification?notice=kyc");
}

// ---------------------------------------------------------------------------------------------------------------
// Owners of the main file or of one buying entity. Each is screened when saved.

function ownersBack(entityId: string) {
  return entityId ? `#entity-${entityId}` : "#owners";
}

export async function addOwner(formData: FormData) {
  const user = await requireUser();
  if (user.role !== "BUYER") redirect("/");
  if (user.accountStatus === "REJECTED") redirect("/buyer/pending");
  const entityId = String(formData.get("buyerEntityId") || "");
  const result = await addBeneficialOwner(user, {
    buyerEntityId: entityId,
    name: formData.get("name"),
    title: formData.get("title"),
    ownershipPct: formData.get("ownershipPct"),
    controlPerson: String(formData.get("controlPerson") || ""),
    country: formData.get("country"),
  });
  if (result.error !== null) redirect(`/buyer/verification?error=${encodeURIComponent(result.error)}${ownersBack(entityId)}`);
  revalidatePath("/buyer/verification");
  revalidatePath("/admin/verification");
  redirect(`/buyer/verification?notice=${encodeURIComponent(`${result.owner.name} is listed.`)}${ownersBack(entityId)}`);
}

export async function removeOwner(formData: FormData) {
  const user = await requireUser();
  if (user.role !== "BUYER") redirect("/");
  if (user.accountStatus === "REJECTED") redirect("/buyer/pending");
  const entityId = String(formData.get("buyerEntityId") || "");
  const result = await removeBeneficialOwner(user, String(formData.get("ownerId") || ""));
  if (result.error !== null) redirect(`/buyer/verification?error=${encodeURIComponent(result.error)}${ownersBack(entityId)}`);
  revalidatePath("/buyer/verification");
  revalidatePath("/admin/verification");
  redirect(`/buyer/verification?notice=${encodeURIComponent("The owner is removed.")}${ownersBack(entityId)}`);
}

// The yearly re-certification, when nothing on the file has changed. A change goes through the main form instead.
export async function confirmRecertify(formData: FormData) {
  const user = await requireUser();
  if (user.role !== "BUYER") redirect("/");
  if (user.accountStatus === "REJECTED") redirect("/buyer/pending");
  const result = await confirmRecertification(user, { confirmed: String(formData.get("unchanged") || "") === "yes" });
  if (result.error !== null) redirect(`/buyer/verification?error=${encodeURIComponent(result.error)}#recertify`);
  screenInBackground(() => screenUser(user.id, "Buyer file re-certified"));
  revalidatePath("/buyer/verification");
  revalidatePath("/admin/verification");
  redirect(`/buyer/verification?notice=${encodeURIComponent("Your file is back with the desk. New bids wait until they approve it again.")}`);
}

// How long an approved file stays current, from the settings page. Files keep the date they were approved with.
export async function saveRecertifySettings(formData: FormData) {
  const actor = await requireDesk("admin", "/admin/settings");
  const raw = String(formData.get("recertifyMonths") || "").trim();
  const months = Number(raw);
  if (!/^\d+$/.test(raw) || recertifyMonthsOf(months) !== months) {
    redirect(`/admin/settings?error=${encodeURIComponent("Set re-certification as a whole number of months from 1 to 36.")}#recertify`);
  }
  const before = recertifyMonthsOf((await getSettings()).recertifyMonths);
  await prisma.platformSettings.upsert({ where: { id: "default" }, update: { recertifyMonths: months }, create: { id: "default", recertifyMonths: months } });
  clearSettingsCache();
  await audit(actor.id, "RECERTIFY_SETTINGS", "settings", "default", `Re-certification ${before} to ${months} months.`);
  revalidatePath("/admin/settings");
  redirect(`/admin/settings?notice=${encodeURIComponent(`Files the desk approves from now on stay current for ${months} month${months === 1 ? "" : "s"}.`)}#recertify`);
}

export async function startVendorKyc() {
  const user = await requireUser();
  if (user.role !== "BUYER") redirect("/");
  // A vendor check is identity only. It never reopens a file the desk has already decided.
  const profile = await prisma.buyerProfile.findUnique({ where: { userId: user.id }, select: { status: true } });
  const decided = vendorBlocked(profile?.status);
  if (decided) redirect(`/buyer/verification?error=${encodeURIComponent(decided)}`);
  let started;
  try {
    started = await startKyc({ userId: user.id, email: user.email, name: user.name });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The verification vendor did not respond.";
    redirect(`/buyer/verification?error=${encodeURIComponent(message)}`);
  }
  if (!started.url) redirect("/buyer/verification?error=Vendor%20keys%20are%20not%20set.%20Use%20the%20desk%20form.");
  const data = { vendor: started.provider, vendorRef: started.reference, status: "SUBMITTED" as const, submittedAt: new Date() };
  if (profile) {
    // Conditional, so a desk decision that lands while the vendor opens still stands.
    const opened = await prisma.buyerProfile.updateMany({ where: { userId: user.id, status: { notIn: [...VENDOR_LOCKED] } }, data });
    if (opened.count !== 1) redirect(`/buyer/verification?error=${encodeURIComponent("The desk has already decided this file.")}`);
  } else {
    // A file made in the meantime keeps its status and only gains the vendor reference.
    await prisma.buyerProfile.upsert({
      where: { userId: user.id },
      update: { vendor: data.vendor, vendorRef: data.vendorRef },
      create: { userId: user.id, ...data, entityName: user.name },
    });
  }
  redirect(started.url);
}
