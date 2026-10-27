"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { notify } from "@/lib/email";
import { canCompleteStep } from "@/lib/closing";
import { finalizeClosing, isClosingStepKey } from "@/lib/closing-service";
import { prisma } from "@/lib/prisma";
import { extensionOf, mimeFor, putBytes, safeBasename } from "@/lib/storage";
import { uploadProblem } from "@/lib/uploads";

async function loadClosing(id: string) {
  return prisma.closing.findUnique({
    where: { id },
    include: {
      listing: { include: { seller: true } },
      steps: { include: { files: true } },
    },
  });
}

async function participant(closingId: string) {
  const user = await requireUser();
  const closing = await loadClosing(closingId);
  if (!closing) redirect("/closings");
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId } }) : null;
  const funder = await prisma.closingFunder.findUnique({ where: { closingId_userId: { closingId, userId: user.id } } });
  const allowed = user.role === "ADMIN" || user.id === closing.listing.sellerId || user.id === inquiry?.buyerId || Boolean(funder);
  if (!allowed) redirect("/");
  return { user, closing, inquiry };
}

export async function saveWireInstructions(formData: FormData) {
  const closingId = String(formData.get("closingId") || "");
  const { user } = await participant(closingId);
  if (user.role !== "ADMIN") redirect(`/closings/${closingId}?error=Only the desk edits wire instructions.`);
  const wireInstructions = String(formData.get("wireInstructions") || "").trim();
  const providerRef = String(formData.get("providerRef") || "").trim();
  await prisma.closing.update({ where: { id: closingId }, data: { wireInstructions, providerRef } });
  revalidatePath(`/closings/${closingId}`);
  redirect(`/closings/${closingId}?notice=wires`);
}

export async function uploadClosingFile(formData: FormData) {
  const closingId = String(formData.get("closingId") || "");
  const stepKey = String(formData.get("stepKey") || "");
  const { user, closing } = await participant(closingId);
  if (!isClosingStepKey(stepKey)) redirect(`/closings/${closingId}?error=Unknown step.`);
  const step = closing.steps.find((item) => item.key === stepKey);
  if (!step) redirect(`/closings/${closingId}?error=Unknown step.`);
  const file = formData.get("file");
  if (!(file instanceof File)) redirect(`/closings/${closingId}?error=Choose a file.`);
  const bytes = Buffer.from(await file.arrayBuffer());
  const problem = uploadProblem(file.name, bytes.length, bytes);
  if (problem) redirect(`/closings/${closingId}?error=${encodeURIComponent(problem)}`);
  const ext = extensionOf(file.name);
  if (!ext) redirect(`/closings/${closingId}?error=That file type is not accepted.`);
  const storageKey = `closings/${closingId}/${crypto.randomUUID()}-${safeBasename(file.name)}`;
  await putBytes(storageKey, bytes, mimeFor(ext, file.type || "application/octet-stream"));
  await prisma.closingFile.create({
    data: {
      stepId: step.id,
      originalName: file.name.slice(0, 180),
      storageKey,
      mime: mimeFor(ext, file.type || "application/octet-stream"),
      size: file.size,
      uploadedById: user.id,
    },
  });
  revalidatePath(`/closings/${closingId}`);
  redirect(`/closings/${closingId}?notice=uploaded`);
}

export async function completeClosingStep(formData: FormData) {
  const closingId = String(formData.get("closingId") || "");
  const stepKey = String(formData.get("stepKey") || "");
  const note = String(formData.get("note") || "").trim();
  const { user, closing, inquiry } = await participant(closingId);
  if (user.role !== "ADMIN") redirect(`/closings/${closingId}?error=Only the desk advances a closing.`);
  if (!isClosingStepKey(stepKey)) redirect(`/closings/${closingId}?error=Unknown step.`);
  if (closing.status !== "OPEN") redirect(`/closings/${closingId}?error=This closing is already finished.`);
  if (!canCompleteStep(closing.steps, stepKey)) {
    redirect(`/closings/${closingId}?error=${encodeURIComponent("Finish the earlier steps before marking the file closed.")}`);
  }
  const step = closing.steps.find((item) => item.key === stepKey);
  if (!step) redirect(`/closings/${closingId}`);
  await prisma.closingStep.update({
    where: { id: step.id },
    data: { status: "COMPLETE", note, completedAt: new Date() },
  });
  if (stepKey === "CLOSED") await finalizeClosing(closingId);
  await audit(user.id, "CLOSING", "closing", closingId, stepKey);
  const buyerEmail = inquiry ? (await prisma.user.findUnique({ where: { id: inquiry.buyerId } }))?.email : null;
  const label = stepKey.replaceAll("_", " ").toLowerCase();
  if (buyerEmail) await notify(buyerEmail, `Closing · ${closing.listing.title}`, `The desk marked ${label} complete.`);
  await notify(closing.listing.seller.email, `Closing · ${closing.listing.title}`, `The desk marked ${label} complete.`);
  revalidatePath(`/closings/${closingId}`);
  revalidatePath("/closings");
  revalidatePath("/admin");
  redirect(`/closings/${closingId}?notice=step`);
}
