"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { onGroupDeclined } from "@/actions/group";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { notify } from "@/lib/email";
import { canCompleteStep } from "@/lib/closing";
import { cancelOpenClosing, finalizeClosing, isClosingStepKey } from "@/lib/closing-service";
import { prisma } from "@/lib/prisma";
import { OFAC_HOLD_MESSAGE, ofacHold } from "@/lib/screening";
import { emitWebhook } from "@/lib/webhooks";
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
  const { user, closing, inquiry } = await participant(closingId);
  if (user.role !== "ADMIN") redirect(`/closings/${closingId}?error=Only the desk edits wire instructions.`);
  if (closing.status !== "OPEN") redirect(`/closings/${closingId}?error=This closing is already finished.`);
  const wireInstructions = String(formData.get("wireInstructions") || "").trim();
  const providerRef = String(formData.get("providerRef") || "").trim();
  await prisma.closing.update({ where: { id: closingId }, data: { wireInstructions, providerRef } });
  if (wireInstructions !== closing.wireInstructions || providerRef !== closing.providerRef) {
    await audit(user.id, "WIRE_EDIT", "closing", closingId, `Before: ${closing.wireInstructions.slice(0, 200)} (ref ${closing.providerRef || "none"}). After: ${wireInstructions.slice(0, 200)} (ref ${providerRef || "none"}).`);
  }
  if (wireInstructions !== closing.wireInstructions) {
    // Changed wire details are the classic closing fraud, so each side hears about it from the desk.
    const warning = "The desk changed the wire instructions on this closing. Before sending money, confirm them by phone on a number you already trust.";
    const buyer = inquiry ? await prisma.user.findUnique({ where: { id: inquiry.buyerId } }) : null;
    if (buyer) await notify(buyer.email, `Wires changed · ${closing.listing.title}`, warning);
    await notify(closing.listing.seller.email, `Wires changed · ${closing.listing.title}`, warning);
  }
  revalidatePath(`/closings/${closingId}`);
  redirect(`/closings/${closingId}?notice=wires`);
}

export async function uploadClosingFile(formData: FormData) {
  const closingId = String(formData.get("closingId") || "");
  const stepKey = String(formData.get("stepKey") || "");
  const { user, closing } = await participant(closingId);
  if (closing.status !== "OPEN") redirect(`/closings/${closingId}?error=This closing is already finished.`);
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
  await audit(user.id, "CLOSING_FILE", "closing", closingId, `${stepKey}: ${file.name.slice(0, 180)}`);
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
  const funders = await prisma.closingFunder.findMany({ where: { closingId }, select: { userId: true } });
  if (await ofacHold({ listingId: closing.listingId, userIds: [inquiry?.buyerId, closing.listing.sellerId, ...funders.map((row) => row.userId)] })) {
    redirect(`/closings/${closingId}?error=${encodeURIComponent(OFAC_HOLD_MESSAGE)}`);
  }
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

export async function cancelClosing(formData: FormData) {
  const closingId = String(formData.get("closingId") || "");
  const reason = String(formData.get("reason") || "").trim().slice(0, 500);
  const { user, closing, inquiry } = await participant(closingId);
  if (user.role !== "ADMIN") redirect(`/closings/${closingId}?error=Only the desk cancels a closing.`);
  if (closing.status !== "OPEN") redirect(`/closings/${closingId}?error=This closing is already finished.`);
  if (reason.length < 3) redirect(`/closings/${closingId}?error=${encodeURIComponent("Say why the closing is being canceled.")}`);
  await cancelOpenClosing(closingId, reason);
  await audit(user.id, "CLOSING_CANCELED", "closing", closingId, reason);
  const message = `The desk canceled this closing. Reason: ${reason} Any money already wired has to be returned outside the app, so write the desk about it.`;
  if (inquiry) {
    await onGroupDeclined(inquiry.id, message);
    await emitWebhook(closing.listing.sellerId, "offer.declined", { inquiryId: inquiry.id, listingId: closing.listingId });
    const buyer = await prisma.user.findUnique({ where: { id: inquiry.buyerId } });
    if (buyer) await notify(buyer.email, `Closing canceled · ${closing.listing.title}`, message);
  }
  await notify(closing.listing.seller.email, `Closing canceled · ${closing.listing.title}`, message);
  const thread = await prisma.deskThread.findUnique({ where: { closingId } });
  if (thread) await prisma.threadPost.create({ data: { threadId: thread.id, authorId: user.id, body: message } });
  revalidatePath(`/closings/${closingId}`);
  revalidatePath("/closings");
  revalidatePath("/admin");
  revalidatePath("/marketplace");
  redirect(`/closings/${closingId}?notice=closing_canceled`);
}
