"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { onGroupDeclined } from "@/lib/group-events";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { notify } from "@/lib/email";
import { canCompleteStep } from "@/lib/closing";
import { buyerSideEmails, cancelOpenClosing, completeDepositFromWire, finalizeClosing, isClosingStepKey, walkAwayFromClosing } from "@/lib/closing-service";
import { prisma } from "@/lib/prisma";
import { OFAC_HOLD_MESSAGE, ofacHold } from "@/lib/screening";
import { moneyGate } from "@/lib/settlement";
import { emitWebhook } from "@/lib/webhooks";
import { extensionOf, mimeFor, putBytes, safeBasename } from "@/lib/storage";
import { uploadProblem } from "@/lib/uploads";

async function loadClosing(id: string) {
  return prisma.closing.findUnique({
    where: { id },
    include: {
      listing: { include: { seller: true } },
      steps: { include: { files: true } },
      funders: true,
    },
  });
}

async function participant(closingId: string) {
  const user = await requireUser();
  const closing = await loadClosing(closingId);
  if (!closing) redirect("/closings");
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, include: { buyer: true } }) : null;
  const allowed = user.role === "ADMIN" || user.id === closing.listing.sellerId || user.id === inquiry?.buyerId || closing.funders.some((funder) => funder.userId === user.id);
  if (!allowed) redirect("/");
  return { user, closing, inquiry };
}

export async function saveWireInstructions(formData: FormData) {
  const closingId = String(formData.get("closingId") || "");
  const { user, closing } = await participant(closingId);
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
    for (const email of [...(await buyerSideEmails(closingId)), closing.listing.seller.email]) {
      await notify(email, `Wires changed · ${closing.listing.title}`, warning);
    }
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
  const override = String(formData.get("override") || "").trim().slice(0, 300);
  const { user, closing, inquiry } = await participant(closingId);
  if (user.role !== "ADMIN") redirect(`/closings/${closingId}?error=Only the desk advances a closing.`);
  if (!isClosingStepKey(stepKey)) redirect(`/closings/${closingId}?error=Unknown step.`);
  if (closing.status !== "OPEN") redirect(`/closings/${closingId}?error=This closing is already finished.`);
  if (await ofacHold({ listingId: closing.listingId, userIds: [inquiry?.buyerId, closing.listing.sellerId, ...closing.funders.map((row) => row.userId)] })) {
    redirect(`/closings/${closingId}?error=${encodeURIComponent(OFAC_HOLD_MESSAGE)}`);
  }
  if (!canCompleteStep(closing.steps, stepKey)) {
    redirect(`/closings/${closingId}?error=${encodeURIComponent("Finish the earlier steps before marking the file closed.")}`);
  }
  const step = closing.steps.find((item) => item.key === stepKey);
  if (!step) redirect(`/closings/${closingId}`);
  // Money steps wait for the recorded wire. The desk can go ahead without it only by saying why, and that is audited.
  const gate = moneyGate(stepKey, closing, closing.funders);
  if (gate && override.length < 3) {
    redirect(`/closings/${closingId}?error=${encodeURIComponent(`${gate} Record it first, or give a reason to go ahead without it.`)}`);
  }
  const marked = await prisma.closingStep.updateMany({
    where: { id: step.id, status: "PENDING" },
    data: { status: "COMPLETE", note, completedAt: new Date() },
  });
  if (marked.count !== 1) redirect(`/closings/${closingId}?error=${encodeURIComponent("That step is already marked complete.")}`);
  if (stepKey === "CLOSED") {
    const finished = await finalizeClosing(closingId);
    if (finished?.status !== "COMPLETE") {
      // A cancel landed first. Put the step back so a canceled file doesn't read as closed.
      await prisma.closingStep.update({ where: { id: step.id }, data: { status: "PENDING", note: step.note, completedAt: null } });
      redirect(`/closings/${closingId}?error=${encodeURIComponent("This closing was canceled, so it can't be marked closed.")}`);
    }
  }
  if (gate) await audit(user.id, "CLOSING_OVERRIDE", "closing", closingId, `${stepKey}: ${gate} Reason: ${override}`);
  await audit(user.id, "CLOSING", "closing", closingId, stepKey);
  const label = stepKey.replaceAll("_", " ").toLowerCase();
  for (const email of [...(await buyerSideEmails(closingId)), closing.listing.seller.email]) {
    await notify(email, `Closing · ${closing.listing.title}`, `The desk marked ${label} complete.`);
  }
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
  // A close or another cancel that landed first wins, and nobody is told this one happened.
  if (!(await cancelOpenClosing(closingId, reason))) redirect(`/closings/${closingId}?error=This closing is already finished.`);
  await audit(user.id, "CLOSING_CANCELED", "closing", closingId, reason);
  const message = `The desk canceled this closing. Reason: ${reason} Any money already wired has to be returned outside the app, so write the desk about it.`;
  if (inquiry) {
    await onGroupDeclined(inquiry.id, message);
    await emitWebhook(closing.listing.sellerId, "offer.declined", { inquiryId: inquiry.id, listingId: closing.listingId });
    await notify(inquiry.buyer.email, `Closing canceled · ${closing.listing.title}`, message);
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

// The buyer walks away inside the diligence window, with a reason the seller reads.
export async function walkAway(formData: FormData) {
  const closingId = String(formData.get("closingId") || "");
  const reason = String(formData.get("reason") || "");
  const { user } = await participant(closingId);
  const result = await walkAwayFromClosing(closingId, user.id, reason);
  if (result.error !== null) redirect(`/closings/${closingId}?error=${encodeURIComponent(result.error)}`);
  revalidatePath(`/closings/${closingId}`);
  revalidatePath("/closings");
  revalidatePath("/buyer/offers");
  revalidatePath("/marketplace");
  redirect(`/closings/${closingId}?notice=${encodeURIComponent("You walked away. The closing is canceled, and the seller and the desk were told.")}`);
}

function dateInput(raw: FormDataEntryValue | null) {
  const value = String(raw || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T23:59:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function setClosingDates(formData: FormData) {
  const closingId = String(formData.get("closingId") || "");
  const { user, closing } = await participant(closingId);
  if (user.role !== "ADMIN") redirect(`/closings/${closingId}?error=Only the desk sets closing dates.`);
  if (closing.status !== "OPEN") redirect(`/closings/${closingId}?error=This closing is already finished.`);
  const target = dateInput(formData.get("targetCloseAt"));
  if (!target) redirect(`/closings/${closingId}?error=${encodeURIComponent("Set a target close date.")}`);
  const changed: string[] = [];
  for (const step of closing.steps) {
    const due = dateInput(formData.get(`due_${step.key}`));
    if (due && due.getTime() !== step.dueAt?.getTime()) {
      await prisma.closingStep.update({ where: { id: step.id }, data: { dueAt: due, remindedAt: null } });
      changed.push(`${step.key} ${due.toISOString().slice(0, 10)}`);
    }
  }
  await prisma.closing.update({ where: { id: closingId }, data: { targetCloseAt: target } });
  await audit(user.id, "CLOSING_DATES", "closing", closingId, `Target ${target.toISOString().slice(0, 10)}${changed.length ? `. ${changed.join(", ")}` : ""}`);
  revalidatePath(`/closings/${closingId}`);
  revalidatePath("/closings");
  redirect(`/closings/${closingId}?notice=dates`);
}

// Escrow is manual, so the desk records each wire by hand and both sides can see it landed.
export async function recordSettlement(formData: FormData) {
  const closingId = String(formData.get("closingId") || "");
  const side = String(formData.get("side") || "");
  const { user, closing } = await participant(closingId);
  if (user.role !== "ADMIN") redirect(`/closings/${closingId}?error=Only the desk records money movement.`);
  if (closing.status === "CANCELED") redirect(`/closings/${closingId}?error=This closing was canceled.`);
  if (side !== "funds" && side !== "proceeds" && side !== "deposit") redirect(`/closings/${closingId}?error=Choose which wire this is.`);
  const amount = Number(String(formData.get("amount") || "").replace(/[$,\s]/g, ""));
  const at = dateInput(formData.get("at"));
  const reference = String(formData.get("reference") || "").trim().slice(0, 120);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) redirect(`/closings/${closingId}?error=${encodeURIComponent("Enter the wire amount in dollars.")}`);
  if (!at) redirect(`/closings/${closingId}?error=${encodeURIComponent("Enter the date the wire landed or went out.")}`);
  const cents = Math.round(amount * 100);
  const before = side === "funds" ? closing.fundsReceivedCents : side === "deposit" ? closing.depositReceivedCents : closing.proceedsSentCents;
  await prisma.closing.update({
    where: { id: closingId },
    data: side === "funds"
      ? { fundsReceivedCents: cents, fundsReceivedAt: at, fundsReference: reference }
      : side === "deposit"
        ? { depositReceivedCents: cents, depositReceivedAt: at, depositReference: reference }
        : { proceedsSentCents: cents, proceedsSentAt: at, proceedsReference: reference },
  });
  const label = side === "funds" ? "Buyer funds received" : side === "deposit" ? "Buyer deposit received" : "Seller proceeds sent";
  const dollars = `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  await audit(user.id, side === "funds" ? "FUNDS_RECEIVED" : side === "deposit" ? "DEPOSIT_RECEIVED" : "PROCEEDS_SENT", "closing", closingId, `${label}: ${before == null ? "none" : `$${(before / 100).toFixed(2)}`} to ${dollars} on ${at.toISOString().slice(0, 10)}${reference ? ` · ${reference}` : ""}`);
  const message = `The desk recorded ${label.toLowerCase()} of ${dollars} on ${at.toISOString().slice(0, 10)}${reference ? ` (reference ${reference})` : ""} for ${closing.listing.title}. If that does not match your records, reply on the closing thread.`;
  if (side === "proceeds") await notify(closing.listing.seller.email, `${label} · ${closing.listing.title}`, message);
  if (side === "funds" || side === "deposit") {
    for (const email of await buyerSideEmails(closingId)) await notify(email, `${label} · ${closing.listing.title}`, message);
  }
  if (side === "deposit") await completeDepositFromWire(closingId);
  revalidatePath(`/closings/${closingId}`);
  redirect(`/closings/${closingId}?notice=settlement`);
}
