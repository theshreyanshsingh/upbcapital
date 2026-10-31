"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { InvestorEntity, VerificationStatus } from "@prisma/client";
import { audit } from "@/lib/audit";
import { requireRole, requireUser } from "@/lib/auth";
import { notify, notifyDesk } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { OFAC_DOWN_MESSAGE, OFAC_HOLD_MESSAGE, ofacHold, screenInBackground, screenUser } from "@/lib/screening";
import { extensionOf, mimeFor, putBytes, safeBasename } from "@/lib/storage";
import { uploadProblem } from "@/lib/uploads";
import { ACCREDITATION_TEXT } from "@/lib/verification";
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
      status: "SUBMITTED",
      submittedAt: new Date(),
      reviewerNote: "",
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
      status: "SUBMITTED",
      submittedAt: new Date(),
    },
  });
  screenInBackground(() => screenUser(user.id, "Buyer file"));
  await notifyDesk(`Verification submitted · ${user.name}`, `${entityName} (${entityType}) in ${jurisdiction} is waiting on the desk.`);
  revalidatePath("/buyer/verification");
  revalidatePath("/admin/verification");
  redirect("/buyer/verification?notice=submitted_kyc");
}

export async function reviewVerification(formData: FormData) {
  const reviewer = await requireRole(["ADMIN"]);
  const userId = String(formData.get("userId") || "");
  const decision = String(formData.get("decision") || "");
  const reviewerNote = String(formData.get("reviewerNote") || "").trim();
  const status: VerificationStatus | null =
    decision === "APPROVED" ? "APPROVED" : decision === "REJECTED" ? "REJECTED" : decision === "CHANGES_REQUESTED" ? "CHANGES_REQUESTED" : null;
  if (!status) redirect("/admin/verification");
  if (status !== "APPROVED" && reviewerNote.length < 3) {
    redirect("/admin/verification?error=Tell the buyer what to fix.");
  }
  if (status === "APPROVED") {
    if ((await screenUser(userId, "Buyer file approval")).unavailable) redirect(`/admin/verification?error=${encodeURIComponent(OFAC_DOWN_MESSAGE)}`);
    if (await ofacHold({ userIds: [userId] })) redirect(`/admin/verification?error=${encodeURIComponent(OFAC_HOLD_MESSAGE)}`);
  }
  const profile = await prisma.buyerProfile.update({
    where: { userId },
    data: { status, reviewerNote, reviewedAt: new Date() },
    include: { user: true },
  });
  await audit(reviewer.id, "VERIFICATION", "user", userId, status);
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
  let started;
  try {
    started = await startKyc({ userId: user.id, email: user.email, name: user.name });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The verification vendor did not respond.";
    redirect(`/buyer/verification?error=${encodeURIComponent(message)}`);
  }
  if (!started.url) redirect("/buyer/verification?error=Vendor%20keys%20are%20not%20set.%20Use%20the%20desk%20form.");
  await prisma.buyerProfile.upsert({
    where: { userId: user.id },
    update: { vendor: started.provider, vendorRef: started.reference, status: "SUBMITTED", submittedAt: new Date() },
    create: {
      userId: user.id,
      vendor: started.provider,
      vendorRef: started.reference,
      status: "SUBMITTED",
      submittedAt: new Date(),
      entityName: user.name,
    },
  });
  redirect(started.url);
}
