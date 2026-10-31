import { sealedFromSeller } from "@/lib/auction";
import { notify } from "@/lib/email";
import { prisma } from "@/lib/prisma";

export async function seatMembers(threadId: string, userIds: string[]) {
  const unique = [...new Set(userIds.filter(Boolean))];
  for (const userId of unique) {
    await prisma.threadMember.upsert({
      where: { threadId_userId: { threadId, userId } },
      create: { threadId, userId },
      update: {},
    });
  }
}

export async function ensureInquiryThread(inquiryId: string) {
  const inquiry = await prisma.inquiry.findUnique({
    where: { id: inquiryId },
    include: { buyer: true, listing: { include: { seller: true } }, messages: { orderBy: { createdAt: "asc" }, take: 1 } },
  });
  if (!inquiry) return null;
  // The bid thread holds the bidder's own words, so a seller joins it only once a sealed round opens.
  const sealed = inquiry.type === "OFFER" && sealedFromSeller(inquiry.listing);
  const seats = sealed ? [inquiry.buyerId] : [inquiry.buyerId, inquiry.listing.sellerId];
  const existing = await prisma.deskThread.findUnique({ where: { inquiryId } });
  if (existing) {
    await seatMembers(existing.id, seats);
    if (sealed && inquiry.listing.sellerId !== inquiry.buyerId) {
      await prisma.threadMember.deleteMany({ where: { threadId: existing.id, userId: inquiry.listing.sellerId } });
    }
    return existing;
  }
  const opener = inquiry.messages[0];
  const body = opener?.body || inquiry.message || "Opened on the desk.";
  const thread = await prisma.deskThread.create({
    data: {
      subject: `${inquiry.type === "OFFER" ? "Offer" : "Inquiry"} · ${inquiry.listing.title}`,
      listingId: inquiry.listingId,
      inquiryId,
      members: { create: [...new Set(seats)].map((userId) => ({ userId })) },
      posts: { create: { authorId: opener?.authorId || inquiry.buyerId, body, createdAt: opener?.createdAt || inquiry.createdAt } },
    },
  });
  return thread;
}

export async function ensureClosingThread(closingId: string) {
  const closing = await prisma.closing.findUnique({
    where: { id: closingId },
    include: { listing: { include: { seller: true } } },
  });
  if (!closing) return null;
  const inquiry = closing.inquiryId
    ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId } })
    : null;
  const admins = closing.deskBidId
    ? await prisma.user.findMany({ where: { role: "ADMIN" }, select: { id: true } })
    : [];
  const existing = await prisma.deskThread.findUnique({ where: { closingId } });
  const members = [...new Set([closing.listing.sellerId, inquiry?.buyerId || "", ...admins.map((row) => row.id)].filter(Boolean))];
  if (existing) {
    await seatMembers(existing.id, members);
    return existing;
  }
  return prisma.deskThread.create({
    data: {
      subject: `Closing · ${closing.listing.title}`,
      listingId: closing.listingId,
      closingId,
      members: { create: members.map((userId) => ({ userId })) },
      posts: {
        create: {
          authorId: closing.listing.sellerId,
          body: `Closing opened at $${Number(closing.salePrice).toLocaleString("en-US")}.`,
        },
      },
    },
  });
}

export async function syncThreadsFor(userId: string, role: string) {
  if (role === "ADMIN") {
    const [inquiries, closings] = await Promise.all([
      prisma.inquiry.findMany({ select: { id: true }, take: 80, orderBy: { createdAt: "desc" } }),
      prisma.closing.findMany({ select: { id: true }, take: 40, orderBy: { openedAt: "desc" } }),
    ]);
    for (const inquiry of inquiries) await ensureInquiryThread(inquiry.id);
    for (const closing of closings) await ensureClosingThread(closing.id);
    return;
  }
  const [inquiries, closings] = await Promise.all([
    prisma.inquiry.findMany({
      where: { OR: [{ buyerId: userId }, { listing: { sellerId: userId } }] },
      select: { id: true },
      take: 80,
    }),
    prisma.closing.findMany({
      where: { OR: [{ listing: { sellerId: userId } }, { inquiryId: { in: (await prisma.inquiry.findMany({ where: { buyerId: userId }, select: { id: true } })).map((row) => row.id) } }] },
      select: { id: true },
      take: 40,
    }),
  ]);
  for (const inquiry of inquiries) await ensureInquiryThread(inquiry.id);
  for (const closing of closings) await ensureClosingThread(closing.id);
}

export async function notifyThread(threadId: string, authorId: string, body: string) {
  const thread = await prisma.deskThread.findUnique({
    where: { id: threadId },
    include: { members: { include: { user: true } } },
  });
  if (!thread) return;
  for (const member of thread.members) {
    if (member.userId === authorId) continue;
    await notify(member.user.email, thread.subject, body.slice(0, 500));
  }
}
