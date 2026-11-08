"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { onGroupDeclined } from "@/lib/group-events";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { notify } from "@/lib/email";
import { canCompleteStep } from "@/lib/closing";
import { buyerSideEmails, cancelOpenClosing, completeDepositFromWire, finalizeClosing, isClosingStepKey, walkAwayFromClosing } from "@/lib/closing-service";
import { depositNoticeLine } from "@/lib/deposits";
import { prisma } from "@/lib/prisma";
import { payoutLabel, proceedsAccount } from "@/lib/payout-accounts";
import { OFAC_HOLD_MESSAGE, ofacHold } from "@/lib/screening";
import { moneyGate, proceedsGate } from "@/lib/settlement";
import { emitWebhook } from "@/lib/webhooks";
import { extensionOf, mimeFor, putBytes, safeBasename } from "@/lib/storage";
import { guardDesk } from "@/lib/staff";
import { faultLabel, isCancelFault, strikeStanding } from "@/lib/strikes";
import { uploadProblem } from "@/lib/uploads";
import { proposeWireChange } from "@/lib/wire-changes";

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
  guardDesk(user, "closings", `/closings/${closingId}`);
  if (closing.status !== "OPEN") redirect(`/closings/${closingId}?error=This closing is already finished.`);
  const wireInstructions = String(formData.get("wireInstructions") || "").trim();
  const providerRef = String(formData.get("providerRef") || "").trim();
  // The escrow reference doesn't say where money goes, so it saves at once.
  if (providerRef !== closing.providerRef) {
    await prisma.closing.update({ where: { id: closingId }, data: { providerRef } });
    await audit(user.id, "ESCROW_REF", "closing", closingId, `${closing.providerRef || "none"} to ${providerRef || "none"}`);
  }
  // New instructions wait for a second desk member to approve them. Both sides are told when they take effect.
  const proposed = await proposeWireChange(user, { closingId, instructions: wireInstructions, reason: String(formData.get("reason") || "") });
  if (proposed.error !== null) redirect(`/closings/${closingId}?error=${encodeURIComponent(proposed.error)}#wires`);
  revalidatePath(`/closings/${closingId}`);
  redirect(`/closings/${closingId}?notice=${proposed.change ? encodeURIComponent("The new wire instructions are waiting for another desk member to approve them. The ones on file stand until then.") : "wires"}#wires`);
}

export async function uploadClosingFile(formData: FormData) {
  const closingId = String(formData.get("closingId") || "");
  const stepKey = String(formData.get("stepKey") || "");
  const { user, closing } = await participant(closingId);
  guardDesk(user, "closings", `/closings/${closingId}`);
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
  guardDesk(user, "closings", `/closings/${closingId}`);
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
  // The form's values read as words in the confirmation, so "Buyer" arrives and is stored as BUYER.
  const fault = String(formData.get("fault") || "").trim().toUpperCase();
  const { user, closing, inquiry } = await participant(closingId);
  if (user.role !== "ADMIN") redirect(`/closings/${closingId}?error=Only the desk cancels a closing.`);
  guardDesk(user, "closings", `/closings/${closingId}`);
  if (closing.status !== "OPEN") redirect(`/closings/${closingId}?error=This closing is already finished.`);
  if (reason.length < 3) redirect(`/closings/${closingId}?error=${encodeURIComponent("Say why the closing is being canceled.")}`);
  if (!isCancelFault(fault)) redirect(`/closings/${closingId}?error=${encodeURIComponent("Choose whose failure ended the closing: the buyer, the seller or neither.")}`);
  if (fault === "BUYER" && (closing.deskBidId || !inquiry)) {
    redirect(`/closings/${closingId}?error=${encodeURIComponent("The desk is the buyer on this closing, so choose the seller or neither.")}`);
  }
  // A close or another cancel that landed first wins, and nobody is told this one happened.
  if (!(await cancelOpenClosing(closingId, reason, { fault, actorId: user.id }))) redirect(`/closings/${closingId}?error=This closing is already finished.`);
  await audit(user.id, "CLOSING_CANCELED", "closing", closingId, `${faultLabel(fault)}. ${reason}`);
  const message = `The desk canceled this closing. Reason: ${reason} Any money already wired has to be returned outside the app, so write the desk about it.`;
  if (inquiry) {
    await onGroupDeclined(inquiry.id, message);
    await emitWebhook(closing.listing.sellerId, "offer.declined", { inquiryId: inquiry.id, listingId: closing.listingId });
    // The strike is the buyer's own record, so only the buyer hears of it.
    let strikeNote = "";
    if (fault === "BUYER") {
      const standing = await strikeStanding(inquiry.buyerId);
      strikeNote = ` The desk recorded this as the buyer's failure to close, which is a strike on your buyer file. You have ${standing.active} of ${standing.limit}.${standing.paused ? " Your new bids are paused until the desk reviews them." : ""} Your verification page lists them.`;
    }
    // What the deposit is owed under the rules, read from the closing as the cancel left it. lib/deposits.ts.
    const ended = await prisma.closing.findUnique({ where: { id: closingId } });
    await notify(inquiry.buyer.email, `Closing canceled · ${closing.listing.title}`, `${message}${strikeNote}${ended ? depositNoticeLine(ended) : ""}`);
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
  guardDesk(user, "closings", `/closings/${closingId}`);
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
  // A new target starts the stalled-deal backstop's notices over (lib/backstop.ts).
  const moved = target.getTime() !== closing.targetCloseAt?.getTime();
  await prisma.closing.update({ where: { id: closingId }, data: { targetCloseAt: target, ...(moved ? { stallWarnedAt: null, stallFinalAt: null, stallEscalatedAt: null } : {}) } });
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
  guardDesk(user, "closings", `/closings/${closingId}`);
  if (closing.status === "CANCELED") redirect(`/closings/${closingId}?error=This closing was canceled.`);
  if (side !== "funds" && side !== "proceeds" && side !== "deposit") redirect(`/closings/${closingId}?error=Choose which wire this is.`);
  const amount = Number(String(formData.get("amount") || "").replace(/[$,\s]/g, ""));
  const at = dateInput(formData.get("at"));
  const reference = String(formData.get("reference") || "").trim().slice(0, 120);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) redirect(`/closings/${closingId}?error=${encodeURIComponent("Enter the wire amount in dollars.")}`);
  if (!at) redirect(`/closings/${closingId}?error=${encodeURIComponent("Enter the date the wire landed or went out.")}`);
  // The seller is paid after the buyer's money and the note are in. The desk can go ahead without them only by
  // saying why, and that is audited, like a money step.
  const override = String(formData.get("override") || "").trim().slice(0, 300);
  const gate = side === "proceeds" ? proceedsGate(closing, closing.funders, closing.steps) : null;
  if (gate && override.length < 3) {
    redirect(`/closings/${closingId}?error=${encodeURIComponent(`${gate} Record those before paying the seller, or give a reason to go ahead without them.`)}`);
  }
  // Proceeds go only to a payout account of the seller's that the desk verified by call-back, and no reason
  // overrides that. lib/payout-accounts.ts.
  const payout = side === "proceeds" ? await proceedsAccount(closing.listing.sellerId, String(formData.get("payoutAccountId") || "")) : null;
  if (payout && payout.error !== null) redirect(`/closings/${closingId}?error=${encodeURIComponent(payout.error)}#payout`);
  const paidTo = payout ? ` to ${payoutLabel(payout.account)}` : "";
  const cents = Math.round(amount * 100);
  const before = side === "funds" ? closing.fundsReceivedCents : side === "deposit" ? closing.depositReceivedCents : closing.proceedsSentCents;
  await prisma.closing.update({
    where: { id: closingId },
    data: side === "funds"
      ? { fundsReceivedCents: cents, fundsReceivedAt: at, fundsReference: reference }
      : side === "deposit"
        ? { depositReceivedCents: cents, depositReceivedAt: at, depositReference: reference }
        : { proceedsSentCents: cents, proceedsSentAt: at, proceedsReference: reference, payoutAccountId: payout?.account.id },
  });
  if (gate) await audit(user.id, "CLOSING_OVERRIDE", "closing", closingId, `PROCEEDS: ${gate} Reason: ${override}`);
  const label = side === "funds" ? "Buyer funds received" : side === "deposit" ? "Buyer deposit received" : "Seller proceeds sent";
  const dollars = `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  await audit(user.id, side === "funds" ? "FUNDS_RECEIVED" : side === "deposit" ? "DEPOSIT_RECEIVED" : "PROCEEDS_SENT", "closing", closingId, `${label}: ${before == null ? "none" : `$${(before / 100).toFixed(2)}`} to ${dollars} on ${at.toISOString().slice(0, 10)}${reference ? ` · ${reference}` : ""}`);
  // The account it went to is its own entry, so the timeline still reads the wire line above.
  if (payout) await audit(user.id, "PROCEEDS_ACCOUNT", "closing", closingId, `Seller proceeds to ${payoutLabel(payout.account)} (${payout.account.id})`);
  const message = `The desk recorded ${label.toLowerCase()} of ${dollars}${paidTo} on ${at.toISOString().slice(0, 10)}${reference ? ` (reference ${reference})` : ""} for ${closing.listing.title}. If that does not match your records, reply on the closing thread.`;
  if (side === "proceeds") await notify(closing.listing.seller.email, `${label} · ${closing.listing.title}`, message);
  if (side === "funds" || side === "deposit") {
    for (const email of await buyerSideEmails(closingId)) await notify(email, `${label} · ${closing.listing.title}`, message);
  }
  if (side === "deposit") await completeDepositFromWire(closingId);
  revalidatePath(`/closings/${closingId}`);
  redirect(`/closings/${closingId}?notice=settlement`);
}
