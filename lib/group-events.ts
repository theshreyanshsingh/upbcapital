import { notify } from "@/lib/email";
import { scaleToTarget, splitPremium } from "@/lib/group-buy";
import { prisma } from "@/lib/prisma";
import { seatMembers } from "@/lib/threads";
import { vestingNames } from "@/lib/vesting";

// What happens to a group when the desk counters, awards or declines its offer. These run from the desk's own
// actions, so they live here rather than in actions/group, where every export is a public endpoint.

export async function notifySeats(groupId: string, subject: string, body: string) {
  const seats = await prisma.groupPosition.findMany({ where: { groupId, status: { not: "DROPPED" } }, include: { user: true } });
  for (const seat of seats) await notify(seat.user.email, subject, body);
}

export async function onGroupCounter(inquiryId: string, amount: number, from: "desk" | "seller" = "desk") {
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
  await notifySeats(group.id, `Counter · ${group.listing.title}`, `The ${from} countered the group at $${Math.round(amount).toLocaleString("en-US")}. Reconfirm your seat or drop it.`);
}

export async function onGroupAccepted(inquiryId: string, closingId: string, premiumCents: number) {
  const group = await prisma.groupBuy.findFirst({ where: { inquiryId }, include: { positions: { include: { user: true } }, listing: true } });
  if (!group) return;
  const live = group.positions.filter((seat) => seat.status === "PLEDGED" || seat.status === "FUNDED");
  const splits = splitPremium(premiumCents, live.map((seat) => ({ userId: seat.userId, amount: Number(seat.amount) })));
  const names = await vestingNames(live.map((seat) => seat.userId));
  for (const seat of live) {
    const split = splits.find((row) => row.userId === seat.userId);
    const entityName = names.get(seat.userId) ?? null;
    await prisma.closingFunder.upsert({
      where: { closingId_userId: { closingId, userId: seat.userId } },
      create: {
        closingId,
        userId: seat.userId,
        amount: seat.amount,
        premiumCents: split?.premiumCents ?? 0,
        percent: seat.percent,
        slice: seat.slice,
        entityName,
      },
      update: { amount: seat.amount, premiumCents: split?.premiumCents ?? 0, percent: seat.percent, slice: seat.slice, entityName },
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

export async function onGroupDeclined(inquiryId: string, message = "The seller did not take the group offer.") {
  const group = await prisma.groupBuy.findFirst({ where: { inquiryId }, include: { listing: true } });
  if (!group || group.status === "CLOSED") return;
  await prisma.groupBuy.update({ where: { id: group.id }, data: { status: "DISSOLVED" } });
  await notifySeats(group.id, `Group declined · ${group.listing.title}`, message);
}
