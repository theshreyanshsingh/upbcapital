"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole, requireUser } from "@/lib/auth";
import { sealedFromSeller } from "@/lib/auction";
import { notify, notifyDesk } from "@/lib/email";
import { fillState, resolvePositionAmount, scaleToTarget, splitPremium } from "@/lib/group-buy";
import { prisma } from "@/lib/prisma";
import { seatMembers } from "@/lib/threads";
import { canSubmitOffer } from "@/lib/verification";

const OPEN_GROUP = ["GATHERING", "OFFERED", "COUNTERED", "CLOSING"] as const;

function dollars(raw: FormDataEntryValue | null) {
  const value = Number(String(raw || "").replace(/[$,\s]/g, ""));
  return Number.isFinite(value) ? value : null;
}

async function buyerReady(userId: string, listingId: string) {
  const [user, profile, nda] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    prisma.buyerProfile.findUnique({ where: { userId } }),
    prisma.ndaAcknowledgment.findUnique({ where: { userId_listingId: { userId, listingId } } }),
  ]);
  if (!user) return "Sign in again.";
  if (user.role === "ADMIN") return null;
  const gate = canSubmitOffer({ role: user.role, accountStatus: user.accountStatus, verificationStatus: profile?.status ?? null });
  if (!gate.ok) return gate.reason === "verification" ? "Verify the buyer file before joining a group." : "This account cannot join a group.";
  if (!nda) return "Sign the confidentiality agreement before taking a seat.";
  return null;
}

async function notifySeats(groupId: string, subject: string, body: string) {
  const seats = await prisma.groupPosition.findMany({ where: { groupId, status: { not: "DROPPED" } }, include: { user: true } });
  for (const seat of seats) await notify(seat.user.email, subject, body);
}

async function publishOffer(groupId: string) {
  const group = await prisma.groupBuy.findUnique({
    where: { id: groupId },
    include: { positions: { include: { user: true } }, listing: { include: { seller: true } } },
  });
  if (!group) return;
  const live = group.positions.filter((seat) => seat.status === "PLEDGED");
  const state = fillState(Number(group.targetAmount), live.map((seat) => ({ amount: Number(seat.amount), status: seat.status })));
  if (!state.complete) return;
  const lead = [...live].sort((a, b) => Number(b.amount) - Number(a.amount))[0];
  if (!lead) return;
  const message = `Group offer from ${live.length} buyers. One contract for $${Math.round(state.filled).toLocaleString("en-US")}.`;
  if (group.inquiryId) {
    await prisma.inquiry.update({ where: { id: group.inquiryId }, data: { amount: group.targetAmount, status: "OPEN" } });
    await prisma.offerMessage.create({
      data: { inquiryId: group.inquiryId, authorId: lead.userId, kind: "OFFER", amount: group.targetAmount, body: "Every seat reconfirmed the group offer." },
    });
  } else {
    const inquiry = await prisma.inquiry.create({
      data: {
        listingId: group.listingId,
        buyerId: lead.userId,
        type: "OFFER",
        noteId: group.noteId,
        amount: group.targetAmount,
        message,
        status: "OPEN",
      },
    });
    await prisma.offerMessage.create({
      data: { inquiryId: inquiry.id, authorId: lead.userId, kind: "OFFER", amount: group.targetAmount, body: message },
    });
    await prisma.groupBuy.update({ where: { id: group.id }, data: { inquiryId: inquiry.id } });
    const sealed = sealedFromSeller(group.listing);
    await notify(
      group.listing.seller.email,
      `Group offer · ${group.listing.title}`,
      sealed ? `Group offer from ${live.length} buyers. The amount opens at the deadline.` : message,
    );
    const { emitWebhook } = await import("@/lib/webhooks");
    await emitWebhook(group.listing.sellerId, "offer.created", {
      inquiryId: inquiry.id,
      listingId: group.listingId,
      amount: sealed ? null : Number(group.targetAmount),
      sealed,
      group: true,
    });
    await notifyDesk(`Group offer · ${group.listing.title}`, message);
  }
  await prisma.groupBuy.update({ where: { id: group.id }, data: { status: "OFFERED" } });
}

export async function openGroup(formData: FormData) {
  const user = await requireUser();
  const listingId = String(formData.get("listingId") || "");
  const listing = await prisma.listing.findUnique({ where: { id: listingId } });
  const back = `/marketplace/${listingId}`;
  if (!listing || listing.status !== "APPROVED") redirect(`${back}?error=Groups open on a live listing.`);
  const blocked = user.role === "ADMIN" ? null : await buyerReady(user.id, listingId);
  if (blocked) redirect(`${back}?error=${encodeURIComponent(blocked)}`);
  const existing = await prisma.groupBuy.findFirst({ where: { listingId, status: { in: [...OPEN_GROUP] } } });
  if (existing) redirect(`/groups/${existing.id}?error=This listing already has a group.`);
  const target = dollars(formData.get("targetAmount"));
  const min = dollars(formData.get("minPosition"));
  const deadline = new Date(String(formData.get("deadline") || ""));
  const structure = String(formData.get("structure") || "PRO_RATA") === "SENIOR_JUNIOR" ? "SENIOR_JUNIOR" : "PRO_RATA";
  const seniorYield = dollars(formData.get("seniorYield"));
  if (target == null || target <= 0 || min == null || min <= 0 || min > target) {
    redirect(`${back}?error=Set a target price and a minimum seat below it.`);
  }
  if (Number.isNaN(deadline.getTime()) || deadline.getTime() < Date.now()) {
    redirect(`${back}?error=The deadline has to be in the future.`);
  }
  if (structure === "SENIOR_JUNIOR" && (seniorYield == null || seniorYield <= 0 || seniorYield > 20)) {
    redirect(`${back}?error=Set the senior yield between 0 and 20%.`);
  }
  const group = await prisma.groupBuy.create({
    data: {
      listingId,
      openedById: user.id,
      minPosition: min,
      deadline,
      targetAmount: target,
      structure,
      seniorYield: structure === "SENIOR_JUNIOR" ? seniorYield : null,
      allowPartial: formData.get("allowPartial") === "on",
    },
  });
  const mine = dollars(formData.get("amount"));
  if (mine && mine > 0) {
    const sized = resolvePositionAmount({ target, amount: mine, percent: null, min, remaining: target });
    if (sized) {
      const slice = structure === "SENIOR_JUNIOR" && formData.get("slice") === "JUNIOR" ? "JUNIOR" : structure === "SENIOR_JUNIOR" ? "SENIOR" : "PARI";
      await prisma.groupPosition.create({
        data: { groupId: group.id, userId: user.id, seat: 1, amount: sized, percent: (sized / target) * 100, slice, status: "PLEDGED" },
      });
      await publishOffer(group.id);
    }
  }
  revalidatePath(back);
  redirect(`/groups/${group.id}?notice=group`);
}

export async function joinGroup(formData: FormData) {
  const user = await requireUser();
  const groupId = String(formData.get("groupId") || "");
  const group = await prisma.groupBuy.findUnique({ where: { id: groupId }, include: { positions: true, listing: true } });
  if (!group) redirect("/marketplace");
  const back = `/groups/${group.id}`;
  if (group.status !== "GATHERING" && group.status !== "COUNTERED") redirect(`${back}?error=This group is not taking seats.`);
  if (group.deadline.getTime() < Date.now() && group.status === "GATHERING") redirect(`${back}?error=The deadline passed. Extend it, bid what is filled, or dissolve.`);
  const blocked = await buyerReady(user.id, group.listingId);
  if (blocked) redirect(`${back}?error=${encodeURIComponent(blocked)}`);
  if (group.positions.some((seat) => seat.userId === user.id && seat.status !== "DROPPED")) redirect(`${back}?error=You already have a seat.`);
  const state = fillState(Number(group.targetAmount), group.positions.map((seat) => ({ amount: Number(seat.amount), status: seat.status })));
  const sized = resolvePositionAmount({
    target: Number(group.targetAmount),
    amount: dollars(formData.get("amount")),
    percent: dollars(formData.get("percent")),
    min: Number(group.minPosition),
    remaining: state.remaining,
  });
  if (sized == null) redirect(`${back}?error=That seat is below the minimum or larger than what is left.`);
  const slice = group.structure === "SENIOR_JUNIOR" ? (formData.get("slice") === "JUNIOR" ? "JUNIOR" : "SENIOR") : "PARI";
  const seatNo = group.positions.reduce((max, seat) => Math.max(max, seat.seat), 0) + 1;
  const dropped = group.positions.find((seat) => seat.userId === user.id && seat.status === "DROPPED");
  if (dropped) {
    await prisma.groupPosition.update({
      where: { id: dropped.id },
      data: { amount: sized, percent: (sized / Number(group.targetAmount)) * 100, slice, status: "PLEDGED", seat: dropped.seat },
    });
  } else {
    await prisma.groupPosition.create({
      data: { groupId: group.id, userId: user.id, seat: seatNo, amount: sized, percent: (sized / Number(group.targetAmount)) * 100, slice, status: "PLEDGED" },
    });
  }
  await publishOffer(group.id);
  revalidatePath(`/marketplace/${group.listingId}`);
  redirect(`${back}?notice=joined`);
}

export async function reconfirmSeat(formData: FormData) {
  const user = await requireUser();
  const groupId = String(formData.get("groupId") || "");
  const seat = await prisma.groupPosition.findFirst({ where: { groupId, userId: user.id, status: "RECONFIRM" } });
  if (!seat) redirect(`/groups/${groupId}?error=There is nothing to reconfirm.`);
  await prisma.groupPosition.update({ where: { id: seat.id }, data: { status: "PLEDGED" } });
  const group = await prisma.groupBuy.findUnique({ where: { id: groupId }, include: { positions: true } });
  const waiting = group?.positions.some((row) => row.id !== seat.id && row.status === "RECONFIRM");
  if (group && !waiting) await publishOffer(group.id);
  redirect(`/groups/${groupId}?notice=reconfirmed`);
}

export async function dropSeat(formData: FormData) {
  const user = await requireUser();
  const groupId = String(formData.get("groupId") || "");
  const group = await prisma.groupBuy.findUnique({ where: { id: groupId }, include: { positions: true, listing: { include: { seller: true } } } });
  if (!group || group.status === "CLOSING" || group.status === "CLOSED" || group.status === "DISSOLVED") {
    redirect(`/groups/${groupId}?error=That seat can no longer be dropped.`);
  }
  const seat = group.positions.find((row) => row.userId === user.id && row.status !== "DROPPED");
  if (!seat && user.role !== "ADMIN") redirect(`/groups/${groupId}?error=That seat is not yours.`);
  const targetId = seat?.id || String(formData.get("positionId") || "");
  await prisma.groupPosition.update({ where: { id: targetId }, data: { status: "DROPPED" } });
  if (group.inquiryId && (group.status === "OFFERED" || group.status === "COUNTERED")) {
    await prisma.offerMessage.create({
      data: { inquiryId: group.inquiryId, authorId: user.id, kind: "NOTE", body: "A seat opened. The group offer is paused until it refills." },
    });
    await prisma.inquiry.update({ where: { id: group.inquiryId }, data: { status: "DECLINED" } });
    await prisma.groupBuy.update({ where: { id: group.id }, data: { inquiryId: null, status: "GATHERING" } });
    await notify(group.listing.seller.email, `Group paused · ${group.listing.title}`, "A buyer left the group. The offer is paused until the book refills.");
  }
  redirect(`/groups/${groupId}?notice=dropped`);
}

export async function extendGroup(formData: FormData) {
  const user = await requireUser();
  const groupId = String(formData.get("groupId") || "");
  const group = await prisma.groupBuy.findUnique({ where: { id: groupId }, include: { listing: true } });
  if (!group || (group.openedById !== user.id && user.role !== "ADMIN")) redirect(`/groups/${groupId}?error=Only the opener or the desk can extend.`);
  const deadline = new Date(String(formData.get("deadline") || ""));
  if (Number.isNaN(deadline.getTime()) || deadline.getTime() < Date.now()) redirect(`/groups/${groupId}?error=Pick a future deadline.`);
  await prisma.groupBuy.update({ where: { id: groupId }, data: { deadline, status: group.status === "DISSOLVED" ? "GATHERING" : group.status } });
  await notifySeats(groupId, `Group extended · ${group.listing.title}`, `The group now runs until ${deadline.toISOString().slice(0, 16)} UTC.`);
  redirect(`/groups/${groupId}?notice=extended`);
}

export async function allowPartialGroup(formData: FormData) {
  const user = await requireUser();
  const groupId = String(formData.get("groupId") || "");
  const group = await prisma.groupBuy.findUnique({ where: { id: groupId }, include: { listing: true } });
  if (!group || (user.role !== "ADMIN" && user.id !== group.listing.sellerId)) redirect(`/groups/${groupId}?error=Only the seller or the desk can allow a partial bid.`);
  await prisma.groupBuy.update({ where: { id: groupId }, data: { allowPartial: formData.get("allowPartial") === "on" } });
  redirect(`/groups/${groupId}?notice=partial`);
}

export async function bidPartial(formData: FormData) {
  const user = await requireUser();
  const groupId = String(formData.get("groupId") || "");
  const group = await prisma.groupBuy.findUnique({ where: { id: groupId }, include: { positions: true, listing: true } });
  if (!group || (group.openedById !== user.id && user.role !== "ADMIN")) redirect(`/groups/${groupId}?error=Only the opener or the desk can send a partial bid.`);
  if (!group.allowPartial) redirect(`/groups/${groupId}?error=The seller has not allowed a partial bid.`);
  const state = fillState(Number(group.targetAmount), group.positions.map((seat) => ({ amount: Number(seat.amount), status: seat.status })));
  if (state.filled + 0.01 < Number(group.minPosition)) redirect(`/groups/${groupId}?error=Nothing is pledged yet.`);
  const next = state.filled;
  for (const seat of group.positions) {
    if (seat.status === "DROPPED") continue;
    const amount = Number(seat.amount);
    await prisma.groupPosition.update({
      where: { id: seat.id },
      data: { percent: (amount / next) * 100, status: "PLEDGED" },
    });
  }
  await prisma.groupBuy.update({ where: { id: group.id }, data: { targetAmount: next } });
  await publishOffer(group.id);
  redirect(`/groups/${groupId}?notice=offered`);
}

export async function dissolveGroup(formData: FormData) {
  const user = await requireUser();
  const groupId = String(formData.get("groupId") || "");
  const group = await prisma.groupBuy.findUnique({ where: { id: groupId }, include: { listing: true } });
  if (!group || (group.openedById !== user.id && user.role !== "ADMIN")) redirect(`/groups/${groupId}?error=Only the opener or the desk can dissolve the group.`);
  if (group.status === "CLOSING" || group.status === "CLOSED") redirect(`/groups/${groupId}?error=The closing has started.`);
  if (group.inquiryId) {
    await prisma.inquiry.update({ where: { id: group.inquiryId }, data: { status: "DECLINED" } });
  }
  await prisma.groupBuy.update({ where: { id: groupId }, data: { status: "DISSOLVED" } });
  await notifySeats(groupId, `Group dissolved · ${group.listing.title}`, "The group did not fill. Your seat is released.");
  redirect(`/groups/${groupId}?notice=dissolved`);
}

export async function onGroupCounter(inquiryId: string, amount: number) {
  const group = await prisma.groupBuy.findFirst({ where: { inquiryId }, include: { positions: true, listing: true } });
  if (!group || group.status === "CLOSED" || group.status === "DISSOLVED") return;
  const oldTarget = Number(group.targetAmount);
  const live = group.positions.filter((seat) => seat.status !== "DROPPED");
  let allocated = 0;
  for (let index = 0; index < live.length; index += 1) {
    const seat = live[index];
    const next = index === live.length - 1 ? Math.round((amount - allocated) * 100) / 100 : scaleToTarget(Number(seat.amount), oldTarget, amount);
    allocated += next;
    await prisma.groupPosition.update({
      where: { id: seat.id },
      data: { amount: next, percent: amount > 0 ? (next / amount) * 100 : 0, status: "RECONFIRM" },
    });
  }
  await prisma.groupBuy.update({ where: { id: group.id }, data: { targetAmount: amount, status: "COUNTERED" } });
  await notifySeats(group.id, `Counter · ${group.listing.title}`, `The desk countered the group at $${Math.round(amount).toLocaleString("en-US")}. Reconfirm your seat or drop it.`);
}

export async function onGroupAccepted(inquiryId: string, closingId: string, premiumCents: number) {
  const group = await prisma.groupBuy.findFirst({ where: { inquiryId }, include: { positions: { include: { user: true } }, listing: true } });
  if (!group) return;
  const live = group.positions.filter((seat) => seat.status === "PLEDGED" || seat.status === "FUNDED");
  const splits = splitPremium(premiumCents, live.map((seat) => ({ userId: seat.userId, amount: Number(seat.amount) })));
  for (const seat of live) {
    const split = splits.find((row) => row.userId === seat.userId);
    await prisma.closingFunder.upsert({
      where: { closingId_userId: { closingId, userId: seat.userId } },
      create: {
        closingId,
        userId: seat.userId,
        amount: seat.amount,
        premiumCents: split?.premiumCents ?? 0,
        percent: seat.percent,
        slice: seat.slice,
      },
      update: { amount: seat.amount, premiumCents: split?.premiumCents ?? 0, percent: seat.percent, slice: seat.slice },
    });
    await prisma.groupPosition.update({ where: { id: seat.id }, data: { status: "FUNDED" } });
  }
  await prisma.groupBuy.update({ where: { id: group.id }, data: { status: "CLOSING", closingId } });
  const thread = await prisma.deskThread.findUnique({ where: { closingId } });
  if (thread) {
    await seatMembers(thread.id, live.map((position) => position.userId));
  }
  const link = `/closings/${closingId}`;
  for (const seat of live) {
    await notify(seat.user.email, `Group accepted · ${group.listing.title}`, `Your seat is on the closing checklist. Fund your share: ${link}`);
  }
}

export async function onGroupDeclined(inquiryId: string) {
  const group = await prisma.groupBuy.findFirst({ where: { inquiryId }, include: { listing: true } });
  if (!group || group.status === "CLOSED") return;
  await prisma.groupBuy.update({ where: { id: group.id }, data: { status: "DISSOLVED" } });
  await notifySeats(group.id, `Group declined · ${group.listing.title}`, "The seller did not take the group offer.");
}

export async function markShareFunded(formData: FormData) {
  const user = await requireUser();
  const closingId = String(formData.get("closingId") || "");
  const userId = String(formData.get("userId") || user.id);
  if (userId !== user.id && user.role !== "ADMIN") redirect(`/closings/${closingId}?error=You can mark only your own share.`);
  const funder = await prisma.closingFunder.findUnique({ where: { closingId_userId: { closingId, userId } } });
  if (!funder) redirect(`/closings/${closingId}?error=That share is not on this closing.`);
  await prisma.closingFunder.update({ where: { id: funder.id }, data: { status: "FUNDED", fundedAt: new Date() } });
  const pending = await prisma.closingFunder.count({ where: { closingId, status: "PENDING" } });
  if (pending === 0) {
    await prisma.closingStep.updateMany({
      where: { closingId, key: "BUYER_DEPOSIT", status: "PENDING" },
      data: { status: "COMPLETE", completedAt: new Date(), note: "Each buyer funded their share." },
    });
  }
  revalidatePath(`/closings/${closingId}`);
  redirect(`/closings/${closingId}?notice=funded`);
}

export async function deskOpenGroup(formData: FormData) {
  await requireRole(["ADMIN"]);
  return openGroup(formData);
}
