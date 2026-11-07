"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { InvestorEntity, VerificationStatus } from "@prisma/client";
import { audit } from "@/lib/audit";
import { proofExpiry } from "@/lib/bid-sheet";
import { ROAD_THRESHOLD, readEligibility, reoStrategyLabel } from "@/lib/eligibility";
import { requireUser } from "@/lib/auth";
import { requireDesk } from "@/lib/staff";
import { notify, notifyDesk } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { OFAC_DOWN_MESSAGE, OFAC_HOLD_MESSAGE, ofacHold, screenInBackground, screenUser } from "@/lib/screening";
import { extensionOf, mimeFor, putBytes, safeBasename } from "@/lib/storage";
import { uploadProblem } from "@/lib/uploads";
import { ACCREDITATION_TEXT, VENDOR_LOCKED, vendorBlocked } from "@/lib/verification";
import { startKyc } from "@/lib/vendors";

const ENTITIES = new Set(["INDIVIDUAL", "LLC", "TRUST", "FUND", "OTHER"]);

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
      status: "SUBMITTED",
      submittedAt: new Date(),
      ...(eligibility ?? {}),
    },
  });
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
  const userId = String(formData.get("userId") || "");
  const decision = String(formData.get("decision") || "");
  const reviewerNote = String(formData.get("reviewerNote") || "").trim();
  const status: VerificationStatus | null =
    decision === "APPROVED" ? "APPROVED" : decision === "REJECTED" ? "REJECTED" : decision === "CHANGES_REQUESTED" ? "CHANGES_REQUESTED" : null;
  if (!status) redirect("/admin/verification");
  if (status !== "APPROVED" && reviewerNote.length < 3) {
    redirect("/admin/verification?error=Tell the buyer what to fix.");
  }
  const verified = Number(String(formData.get("proofAmount") || "").replace(/[$,\s]/g, ""));
  if (status === "APPROVED" && (!Number.isFinite(verified) || verified <= 0)) {
    redirect(`/admin/verification?error=${encodeURIComponent("Enter the funds amount the proof supports before approving.")}`);
  }
  if (status === "APPROVED") {
    if ((await screenUser(userId, "Buyer file approval")).unavailable) redirect(`/admin/verification?error=${encodeURIComponent(OFAC_DOWN_MESSAGE)}`);
    if (await ofacHold({ userIds: [userId] })) redirect(`/admin/verification?error=${encodeURIComponent(OFAC_HOLD_MESSAGE)}`);
  }
  const now = new Date();
  const expires = status === "APPROVED" ? proofExpiry(String(formData.get("proofExpiresAt") || ""), now) : null;
  const profile = await prisma.buyerProfile.update({
    where: { userId },
    data: {
      status,
      reviewerNote,
      reviewedAt: now,
      ...(status === "APPROVED" && expires ? { proofAmount: verified, proofExpiresAt: expires, proofVerifiedAt: now } : {}),
    },
    include: { user: true },
  });
  await audit(reviewer.id, "VERIFICATION", "user", userId, status === "APPROVED" && expires ? `APPROVED · funds $${verified.toLocaleString("en-US")} through ${expires.toISOString().slice(0, 10)}` : status);
  await notify(
    profile.user.email,
    `Verification ${status === "APPROVED" ? "approved" : status === "REJECTED" ? "declined" : "needs changes"}`,
    reviewerNote || "The desk approved your buyer file. You can submit offers.",
  );
  revalidatePath("/admin/verification");
  redirect("/admin/verification?notice=kyc");
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
