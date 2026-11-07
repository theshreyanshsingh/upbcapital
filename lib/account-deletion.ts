import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcryptjs";
import { audit } from "@/lib/audit";
import { demoSeat } from "@/lib/deploy";
import { notifyDesk, sendAlert } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { assertStorageKey, s3Key, storageMode, uploadDir } from "@/lib/storage";

// Deleting an account anonymises it. A hard delete would cascade through Prisma's relations and take closings,
// signed papers and the audit trail with it, and deal records have to be kept for the retention years. So the
// person goes, and the deals stay under an account with no name.

export const DELETED_NAME = "Deleted account";
export const deletedEmail = (userId: string) => `deleted+${userId}@deleted.invalid`;

// Sign-in and every session refuse a deleted account, even if the desk later lifts the lock by mistake.
export function deletedAccountRefusal(user: { deletedAt?: Date | null }) {
  return user.deletedAt ? "This account was deleted at the holder's request." : null;
}

const LIVE_LISTING = ["SUBMITTED", "UNDER_REVIEW", "APPROVED", "CHANGES_REQUESTED", "PENDING"] as const;
const OPEN_GROUP = ["GATHERING", "OFFERED", "COUNTERED", "CLOSING"] as const;

export type DeletionBlocker = "an open bid" | "an open closing" | "a live listing" | "an unfunded group seat";

// What a counterparty still relies on. Each one stops a deletion, and the desk is told which.
export async function deletionBlockers(userId: string): Promise<DeletionBlocker[]> {
  const won = (await prisma.inquiry.findMany({ where: { buyerId: userId, status: "ACCEPTED" }, select: { id: true } })).map((row) => row.id);
  const [bids, closings, listings, seats, shares] = await Promise.all([
    prisma.inquiry.count({ where: { buyerId: userId, type: "OFFER", status: { in: ["OPEN", "REVIEWED"] } } }),
    prisma.closing.count({
      where: { status: "OPEN", OR: [{ inquiryId: { in: won } }, { funders: { some: { userId } } }, { listing: { sellerId: userId } }, { listing: { brokerId: userId } }] },
    }),
    prisma.listing.count({ where: { OR: [{ sellerId: userId }, { brokerId: userId }], status: { in: [...LIVE_LISTING] } } }),
    prisma.groupPosition.count({ where: { userId, status: { in: ["PLEDGED", "RECONFIRM"] }, group: { status: { in: [...OPEN_GROUP] } } } }),
    prisma.closingFunder.count({ where: { userId, status: "PENDING", closing: { status: "OPEN" } } }),
  ]);
  const blockers: DeletionBlocker[] = [];
  if (bids) blockers.push("an open bid");
  if (closings) blockers.push("an open closing");
  if (listings) blockers.push("a live listing");
  if (seats || shares) blockers.push("an unfunded group seat");
  return blockers;
}

export function blockerSentence(blockers: DeletionBlocker[]) {
  const list = blockers.length > 1 ? `${blockers.slice(0, -1).join(", ")} and ${blockers.at(-1)}` : blockers[0];
  return `This account still has ${list}. ${blockers.length > 1 ? "Each has" : "That has"} to finish or close before the account can be deleted.`;
}

// Whether any closing, of any status, names the account. Its buyer file is then part of a deal record.
async function closingReferences(userId: string) {
  const bids = (await prisma.inquiry.findMany({ where: { buyerId: userId }, select: { id: true } })).map((row) => row.id);
  const count = await prisma.closing.count({
    where: { OR: [{ inquiryId: { in: bids } }, { funders: { some: { userId } } }, { listing: { sellerId: userId } }, { listing: { brokerId: userId } }] },
  });
  return count > 0;
}

// lib/storage.ts reads and writes but has no delete. This follows its modes: the blob store, the bucket, and the
// local disk that a bucket read falls back to.
export async function removeStoredFile(key: string) {
  assertStorageKey(key);
  const mode = storageMode();
  if (mode === "blob") {
    const { del } = await import("@vercel/blob");
    await del(key);
    return;
  }
  if (mode === "s3") {
    const { DeleteObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
    const client = new S3Client({
      region: process.env.S3_REGION || "us-east-1",
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: Boolean(process.env.S3_ENDPOINT),
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID || "", secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "" },
    });
    await client.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: s3Key(key) }));
  }
  const root = path.resolve(uploadDir());
  const full = path.resolve(root, key);
  if (!full.startsWith(`${root}${path.sep}`)) throw new Error("Bad storage key");
  await fs.rm(full, { force: true });
}

const clean = (text: string, max = 500) => text.replace(/\s+/g, " ").trim().slice(0, max);

export async function requestDeletion(user: { id: string; name: string; email: string }, reason: string) {
  // The demo seats are shared, so one visitor can't take them away from the rest.
  if (demoSeat(user.email)) return { error: "The demo seats can't be deleted. Sign up with your own email to try this." } as const;
  const open = await prisma.deletionRequest.findFirst({ where: { userId: user.id, status: "REQUESTED" } });
  if (open) return { error: "Your request is already with the desk." } as const;
  const text = clean(reason);
  const request = await prisma.deletionRequest.create({ data: { userId: user.id, reason: text } });
  await audit(user.id, "DELETION_REQUESTED", "user", user.id, text);
  await notifyDesk(
    `Deletion request · ${user.name}`,
    `${user.name} (${user.email}) asked the desk to delete their account.${text ? ` Their reason: ${text}` : ""}\n\nDecide it on the compliance page.`,
  );
  return { request } as const;
}

// Everything kept about the buyer's file is its status. The rest was about the person.
const REDUCED_PROFILE = {
  entityType: "INDIVIDUAL",
  entityName: "",
  jurisdiction: "",
  accredited: false,
  certificationText: "",
  proofAmount: null,
  proofExpiresAt: null,
  proofVerifiedAt: null,
  reviewerNote: "",
  homesControlled: null,
  reoStrategy: null,
  eligibilityAt: null,
  vendor: "",
  vendorRef: "",
  submittedAt: null,
  reviewedAt: null,
} as const;

export type ProofOutcome = "none" | "removed" | "kept" | "failed";

// Clears the person and the things that only served them. Closings, signed papers, NDAs, bids and the audit log
// stay. The proof of funds goes only when no closing names the account; if the store refuses, the key stays so the
// file isn't lost track of.
export async function anonymiseAccount(userId: string, now = new Date()): Promise<{ proof: ProofOutcome }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { buyerProfile: true } });
  if (!user) return { proof: "none" };
  const profile = user.buyerProfile;
  let proof: ProofOutcome = "none";
  if (profile?.proofKey) {
    if (await closingReferences(userId)) proof = "kept";
    else {
      proof = await removeStoredFile(profile.proofKey).then(
        () => "removed" as const,
        (error) => {
          console.error(`[upb-deletion] proof of funds for ${userId} was not removed:`, error instanceof Error ? error.message : error);
          return "failed" as const;
        },
      );
    }
  }
  // Children first, so nothing is left pointing at a parent that went.
  await prisma.webhookDelivery.deleteMany({ where: { endpoint: { userId } } });
  await prisma.listingMatch.deleteMany({ where: { userId } });
  await Promise.all([
    prisma.serverSession.deleteMany({ where: { userId } }),
    prisma.pushSubscription.deleteMany({ where: { userId } }),
    prisma.savedSearch.deleteMany({ where: { userId } }),
    prisma.favorite.deleteMany({ where: { userId } }),
    prisma.buyBox.deleteMany({ where: { userId } }),
    prisma.apiKey.deleteMany({ where: { userId } }),
    prisma.webhookEndpoint.deleteMany({ where: { userId } }),
    prisma.loginCode.deleteMany({ where: { userId } }),
    prisma.passwordReset.deleteMany({ where: { userId } }),
    // In-app copies of mail carry the old address. They aren't deal records.
    prisma.notification.deleteMany({ where: { OR: [{ userId }, { toEmail: user.email }] } }),
  ]);
  if (profile) {
    await prisma.buyerProfile.update({
      where: { userId },
      data: { ...REDUCED_PROFILE, ...(proof === "kept" || proof === "failed" ? {} : { proofKey: "", proofName: "", proofMime: "" }) },
    });
  }
  await prisma.user.update({
    where: { id: userId },
    data: {
      name: DELETED_NAME,
      email: deletedEmail(userId),
      phone: "",
      companyName: "",
      totpSecret: "",
      totpEnabled: false,
      recoveryHashes: "",
      recoveryReveal: "",
      emailOtpFallback: false,
      // Nobody knows this password, so not even the anonymised address signs in.
      passwordHash: await bcrypt.hash(randomUUID(), 10),
      // The code was made from the name.
      referralCode: `DELETED${userId}`,
      notifyEmail: false,
      notifyInApp: false,
      pushEnabled: false,
      marketDispatch: false,
      dealAlerts: false,
      watchAlerts: false,
      sellerReport: false,
      digest: "OFF",
      accountStatus: "SUSPENDED",
      deletedAt: now,
    },
  });
  return { proof };
}

export async function completeDeletion(requestId: string, desk: { id: string }, note = "", now = new Date()) {
  const request = await prisma.deletionRequest.findUnique({ where: { id: requestId }, include: { user: true } });
  if (!request || request.status !== "REQUESTED") return { error: "That request was already decided." } as const;
  if (request.userId === desk.id) return { error: "Another desk member decides your own request." } as const;
  if (demoSeat(request.user.email)) return { error: "The demo seats stay. They go with the demo data." } as const;
  const blockers = await deletionBlockers(request.userId);
  if (blockers.length) return { error: blockerSentence(blockers), blockers } as const;
  const text = clean(note);
  const claim = await prisma.deletionRequest.updateMany({
    where: { id: requestId, status: "REQUESTED" },
    data: { status: "COMPLETED", decidedAt: now, decidedById: desk.id, note: text },
  });
  if (claim.count !== 1) return { error: "That request was already decided." } as const;
  const years = (await getSettings()).retentionYears;
  // The confirmation goes first, while the account still has its address.
  await sendAlert(
    request.user.email,
    "Your UPB Capital account is deleted",
    `The desk deleted your account, as you asked. Your name, email, phone and company are gone from it, every device is signed out, and your saved searches, buy boxes, API keys and webhooks are deleted.

Deal records stay for ${years} years, because the law requires it: closings, signed papers, NDAs and the audit log. They now sit under an account with no name.

This is the last email the desk sends to this address.`,
  );
  const { proof } = await anonymiseAccount(request.userId, now);
  await audit(desk.id, "DELETION_COMPLETED", "user", request.userId, `${text}${text ? " · " : ""}proof of funds ${proof}`);
  return { ok: true, proof } as const;
}

export async function refuseDeletion(requestId: string, desk: { id: string }, note: string, now = new Date()) {
  const text = clean(note);
  if (text.length < 3) return { error: "Say why, so the account holder knows what to settle first." } as const;
  const request = await prisma.deletionRequest.findUnique({ where: { id: requestId }, include: { user: true } });
  if (!request || request.status !== "REQUESTED") return { error: "That request was already decided." } as const;
  const claim = await prisma.deletionRequest.updateMany({
    where: { id: requestId, status: "REQUESTED" },
    data: { status: "REFUSED", decidedAt: now, decidedById: desk.id, note: text },
  });
  if (claim.count !== 1) return { error: "That request was already decided." } as const;
  await audit(desk.id, "DELETION_REFUSED", "user", request.userId, text);
  await sendAlert(request.user.email, "Your deletion request", `The desk can't delete your account yet. ${text}\n\nOnce that is settled, ask again from the security page.`);
  return { ok: true } as const;
}

// The desk's queue: each open request with what stands in its way, and the last few decided.
export async function deletionQueue() {
  const [open, decided] = await Promise.all([
    prisma.deletionRequest.findMany({ where: { status: "REQUESTED" }, include: { user: { select: { id: true, name: true, email: true, role: true } } }, orderBy: { requestedAt: "asc" } }),
    prisma.deletionRequest.findMany({ where: { status: { in: ["COMPLETED", "REFUSED"] } }, include: { user: { select: { name: true, email: true } } }, orderBy: { decidedAt: "desc" }, take: 10 }),
  ]);
  const withBlockers = await Promise.all(open.map(async (request) => ({ ...request, blockers: await deletionBlockers(request.userId) })));
  return { open: withBlockers, decided };
}
