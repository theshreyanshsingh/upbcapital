import type { VerificationStatus } from "@prisma/client";
import { audit } from "@/lib/audit";
import { fileGaps, ownerApprovalBlock } from "@/lib/beneficial-owners";
import { proofExpiry } from "@/lib/bid-sheet";
import { unset } from "@/lib/db-filters";
import { notify, notifyDesk } from "@/lib/email";
import { prettyDate } from "@/lib/format";
import type { Tally } from "@/lib/jobs";
import { prisma } from "@/lib/prisma";
import { OFAC_DOWN_MESSAGE, OFAC_HOLD_MESSAGE, ofacHold, screenUser } from "@/lib/screening";
import { getSettings } from "@/lib/settings";
import { RECERT_NOTICE_DAYS, recertBlock, recertOpen, recertifyByFrom, recertifyMonthsOf } from "@/lib/verification";

// The buyer's main file at the desk: the review, and the yearly re-certification that brings it back.

const DAY = 24 * 60 * 60 * 1000;

const DECISIONS: Record<string, VerificationStatus> = { APPROVED: "APPROVED", REJECTED: "REJECTED", CHANGES_REQUESTED: "CHANGES_REQUESTED" };

// The desk approves, declines or asks for changes. Approval screens the buyer and every owner again and waits for the
// answer, and starts the file's year: it is current until recertifyBy.
export async function reviewBuyerFile(
  reviewer: { id: string },
  input: { userId: string; decision: string; reviewerNote: string; proofAmount: string; proofExpiresAt: string },
  now = new Date(),
) {
  const status = DECISIONS[input.decision];
  if (!status) return { error: "Approve, decline or ask for changes." } as const;
  const reviewerNote = input.reviewerNote.trim();
  if (status !== "APPROVED" && reviewerNote.length < 3) return { error: "Tell the buyer what to fix." } as const;
  const current = await prisma.buyerProfile.findUnique({ where: { userId: input.userId }, select: { entityType: true } });
  if (!current) return { error: "That buyer file no longer exists." } as const;
  const verified = Number(input.proofAmount.replace(/[$,\s]/g, ""));
  if (status === "APPROVED" && (!Number.isFinite(verified) || verified <= 0)) return { error: "Enter the funds amount the proof supports before approving." } as const;
  if (status === "APPROVED") {
    if ((await screenUser(input.userId, "Buyer file approval")).unavailable) return { error: OFAC_DOWN_MESSAGE } as const;
    const owners = await ownerApprovalBlock({ userId: input.userId, buyerEntityId: null, entityType: current.entityType }, now);
    if (owners) return { error: owners } as const;
    if (await ofacHold({ userIds: [input.userId] })) return { error: OFAC_HOLD_MESSAGE } as const;
  }
  const expires = status === "APPROVED" ? proofExpiry(input.proofExpiresAt, now) : null;
  const recertifyBy = status === "APPROVED" ? recertifyByFrom(now, recertifyMonthsOf((await getSettings()).recertifyMonths)) : null;
  const profile = await prisma.buyerProfile.update({
    where: { userId: input.userId },
    data: {
      status,
      reviewerNote,
      reviewedAt: now,
      ...(status === "APPROVED" && expires ? { proofAmount: verified, proofExpiresAt: expires, proofVerifiedAt: now } : {}),
      // A new year starts, with its own reminder.
      ...(recertifyBy ? { recertifyBy, recertRemindedAt: null } : {}),
    },
    include: { user: true },
  });
  await audit(
    reviewer.id,
    "VERIFICATION",
    "user",
    input.userId,
    status === "APPROVED" && expires
      ? `APPROVED · funds $${verified.toLocaleString("en-US")} through ${expires.toISOString().slice(0, 10)} · current until ${recertifyBy!.toISOString().slice(0, 10)}`
      : status,
  );
  await notify(
    profile.user.email,
    `Verification ${status === "APPROVED" ? "approved" : status === "REJECTED" ? "declined" : "needs changes"}`,
    reviewerNote || `The desk approved your buyer file. You can submit offers. It is current until ${prettyDate(recertifyBy)}.`,
  );
  return { error: null, status, recertifyBy } as const;
}

// The buyer says nothing on the file has changed. The file goes back to the desk as submitted, with its proof, owners
// and answers as they are. Expired proof, a missing tax ID or a missing owner goes through the form instead.
export async function confirmRecertification(user: { id: string; name: string }, input: { confirmed: boolean }, now = new Date()) {
  const profile = await prisma.buyerProfile.findUnique({ where: { userId: user.id } });
  if (!profile || !recertOpen(profile, now)) return { error: "Your file isn't due for re-certification yet." } as const;
  if (!input.confirmed) return { error: "Tick the box to confirm the file is unchanged, or update it with the form below." } as const;
  if (profile.proofExpiresAt && profile.proofExpiresAt.getTime() < now.getTime()) {
    return { error: `Your proof of funds expired on ${prettyDate(profile.proofExpiresAt)}. Upload a fresh one with the form below.` } as const;
  }
  if (!profile.taxIdLast4) return { error: "Add the last four digits of your tax ID with the form below." } as const;
  const gaps = await fileGaps(user.id, null, profile.entityType);
  if (gaps.length) return { error: `${gaps.join(" ")} Add them under Owners, then confirm.` } as const;
  // Claimed on the status as read, so a desk decision landing at the same moment stands.
  const claimed = await prisma.buyerProfile.updateMany({
    where: { userId: user.id, status: "APPROVED" },
    data: { status: "SUBMITTED", submittedAt: now, reviewerNote: "" },
  });
  if (claimed.count !== 1) return { error: "Your file changed a moment ago. Check it and try again." } as const;
  await audit(user.id, "RECERTIFIED", "user", user.id, `Unchanged · was current until ${profile.recertifyBy!.toISOString().slice(0, 10)}`);
  await notifyDesk(
    `Re-certification · ${user.name}`,
    `${user.name} confirmed that ${profile.entityName || "their buyer file"} is unchanged. It is waiting on the desk, and their new bids wait until it is approved again.`,
  );
  return { error: null } as const;
}

// Why this buyer can't commit money now for a lapsed file, or null: a group seat taken, re-taken or reconfirmed, as a
// bid would. The caller sends the buyer to their verification page with it.
export async function lapsedFileBlock(userId: string, now = new Date()) {
  return recertBlock(await prisma.buyerProfile.findUnique({ where: { userId }, select: { status: true, recertifyBy: true } }), now);
}

// The daily job: each approved buyer hears once, when their file is 30 days from its date or already past it. The
// claim on recertRemindedAt keeps an overlapping run from sending twice. Approval clears it for the next year.
export async function remindRecertifications(now = new Date()): Promise<Tally> {
  const due = await prisma.buyerProfile.findMany({
    where: { status: "APPROVED", recertifyBy: { lte: new Date(now.getTime() + RECERT_NOTICE_DAYS * DAY) }, ...unset("recertRemindedAt") },
    include: { user: { select: { email: true, deletedAt: true } } },
  });
  // Loaded on call: lib/jobs loads this module the same way.
  const { eachItem } = await import("@/lib/jobs");
  return eachItem("Re-certification reminders", due, (profile) => profile.userId, async (profile) => {
    if (profile.user.deletedAt) return false;
    const claimed = await prisma.buyerProfile.updateMany({
      where: { userId: profile.userId, status: "APPROVED", recertifyBy: profile.recertifyBy, ...unset("recertRemindedAt") },
      data: { recertRemindedAt: now },
    });
    if (claimed.count !== 1) return false;
    const lapsed = profile.recertifyBy!.getTime() < now.getTime();
    await notify(
      profile.user.email,
      lapsed ? "Your buyer file needs re-certification" : "Your buyer file is due for re-certification",
      `${lapsed ? `Your buyer file was current until ${prettyDate(profile.recertifyBy)}, so new bids are paused.` : `Your buyer file is current until ${prettyDate(profile.recertifyBy)}.`} Once a year the desk asks you to confirm the file is unchanged, or to update it. Do it on your verification page. Expired proof of funds needs a fresh upload. New bids wait until the desk approves the file again.`,
    );
    return true;
  });
}
