import { canManageRoom, canReadDocument, isDeskOnlyDocument, isPrivateDocument, loanFileAccess, ndaOpensRoom } from "@/lib/acl";
import { audit } from "@/lib/audit";
import { bidderAlias } from "@/lib/bidder-alias";
import { dealAccess } from "@/lib/data-room";
import { notify } from "@/lib/email";
import { launchPending } from "@/lib/launch-rules";
import { prisma } from "@/lib/prisma";
import { isPro } from "@/lib/settings";

// A seller can ask to approve each bidder before the room opens. The NDA is signed as always; with approval on, it
// waits as PENDING until the seller, the filing broker or the desk approves or declines that buyer.

type Actor = { id: string; role: string };
type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string) => ({ ok: false as const, error });

// Approval is set while the listing is being filed or is live. After that there is no room left to open.
const APPROVAL_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED"];

export const ENTITY_LABELS: Record<string, string> = {
  INDIVIDUAL: "Individual",
  LLC: "Limited liability company",
  TRUST: "Trust",
  FUND: "Fund",
  OTHER: "Other entity",
  IRA: "Self-directed IRA",
};

function listingLink(listingId: string) {
  return `${process.env.NEXT_PUBLIC_APP_URL || ""}/marketplace/${listingId}`;
}

// What a new signature records. A buyer already waiting, or already declined, can't sign again to start over.
export function ndaOnSign(listing: { roomApproval?: boolean | null }, existing: { accessStatus?: string | null } | null) {
  if (existing?.accessStatus === "PENDING") return { block: "Your NDA is signed. The seller is still deciding on your access to the room." };
  if (existing?.accessStatus === "DECLINED") return { block: "The seller didn't approve access to this room." };
  // A re-signature keeps the decision already made. Only a first signature on an approval room waits.
  if (existing) return { block: null, create: undefined };
  return { block: null, create: listing.roomApproval ? ("PENDING" as const) : undefined };
}

export async function setRoomApproval(actor: Actor, input: { listingId: string; on: boolean }): Promise<Outcome<{ released: number }>> {
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, select: { id: true, title: true, sellerId: true, brokerId: true, status: true, roomApproval: true } });
  if (!listing || !canManageRoom(actor, listing)) return fail("That listing isn't yours to change.");
  if (!APPROVAL_STATUSES.includes(listing.status)) return fail("This listing's room is closed, so there is nothing to approve.");
  await prisma.listing.update({ where: { id: listing.id }, data: { roomApproval: input.on } });
  await audit(actor.id, "ROOM_APPROVAL", "listing", listing.id, input.on ? "on" : "off");
  // Turning approval off opens the room on the NDA alone, so anyone still waiting is let in. A decline stands.
  let released = 0;
  if (!input.on) {
    const waiting = await prisma.ndaAcknowledgment.findMany({ where: { listingId: listing.id, accessStatus: "PENDING" }, select: { id: true } });
    for (const nda of waiting) {
      const decided = await decideRoomAccess(actor, { ndaId: nda.id, decision: "APPROVED" });
      if (decided.ok) released += 1;
    }
  }
  return { ok: true, value: { released } };
}

export async function decideRoomAccess(actor: Actor, input: { ndaId: string; decision: string }): Promise<Outcome<{ status: string; userId: string; listingId: string }>> {
  if (input.decision !== "APPROVED" && input.decision !== "DECLINED") return fail("Approve or decline the request.");
  const nda = await prisma.ndaAcknowledgment.findUnique({
    where: { id: input.ndaId },
    include: { user: { select: { id: true, email: true } }, listing: { select: { id: true, title: true, sellerId: true, brokerId: true, status: true } } },
  });
  if (!nda || !canManageRoom(actor, nda.listing)) return fail("That request isn't on this listing.");
  // A waiting request takes either answer. A declined one can still be approved if the seller changes their mind.
  const from = nda.accessStatus ?? "APPROVED";
  if (from !== "PENDING" && !(from === "DECLINED" && input.decision === "APPROVED")) return fail("That request is already decided.");
  if (input.decision === "APPROVED" && nda.listing.status !== "APPROVED") return fail("This listing isn't live, so its room can't open.");
  // Claimed on the status it was read with, so two people answering at once decide it once.
  const claimed = await prisma.ndaAcknowledgment.updateMany({
    where: { id: nda.id, accessStatus: from },
    data: { accessStatus: input.decision, accessDecidedAt: new Date(), accessDecidedById: actor.id },
  });
  if (claimed.count !== 1) return fail("That request is already decided.");
  await audit(actor.id, input.decision === "APPROVED" ? "ROOM_ACCESS_APPROVED" : "ROOM_ACCESS_DECLINED", "listing", nda.listingId, `${nda.id} · ${nda.userId}`);
  const title = nda.listing.title;
  if (input.decision === "APPROVED") {
    await notify(nda.user.email, `Data room open · ${title}`, `The seller approved your access to the data room on ${title}. The street, the borrower and the files are open to you now. ${listingLink(nda.listingId)}`);
  } else {
    await notify(nda.user.email, `Data room access · ${title}`, `The seller didn't approve access to the data room on ${title}. Your signed NDA stays on file. ${listingLink(nda.listingId)}`);
  }
  return { ok: true, value: { status: input.decision, userId: nda.userId, listingId: nda.listingId } };
}

// Tells the seller, and a filing broker who isn't the seller, that a buyer signed. The bidder is named by alias.
export async function announceNda(listing: { id: string; title: string; sellerId: string; brokerId: string | null }, buyerId: string, pending: boolean) {
  const alias = await bidderAlias(listing.id, buyerId);
  const people = await prisma.user.findMany({ where: { id: { in: [listing.sellerId, ...(listing.brokerId ? [listing.brokerId] : [])] } }, select: { email: true } });
  const subject = pending ? `Data room request · ${listing.title}` : `NDA signed · ${listing.title}`;
  const body = pending
    ? `${alias} signed confidentiality on ${listing.title} and is waiting for your approval to open the data room. Approve or decline on your listing page.`
    : `${alias} signed confidentiality on ${listing.title}. The PDF is in the data room.`;
  for (const email of new Set(people.map((person) => person.email))) await notify(email, subject, body);
}

// Requests waiting on the seller, and ones declined, with the buyer's vetted entity, so the seller can judge who is
// asking. The person's own name and email stay with the desk.
export async function roomRequests(listingId: string) {
  const ndas = await prisma.ndaAcknowledgment.findMany({
    where: { listingId, accessStatus: { in: ["PENDING", "DECLINED"] } },
    orderBy: { acknowledgedAt: "asc" },
    include: { user: { select: { id: true, name: true, companyName: true } } },
  });
  const profiles = ndas.length
    ? await prisma.buyerProfile.findMany({ where: { userId: { in: ndas.map((nda) => nda.userId) } }, select: { userId: true, entityName: true, entityType: true, status: true } })
    : [];
  const byUser = new Map(profiles.map((profile) => [profile.userId, profile]));
  return ndas.map((nda) => {
    const profile = byUser.get(nda.userId);
    return {
      id: nda.id,
      userId: nda.userId,
      status: nda.accessStatus as "PENDING" | "DECLINED",
      signedAt: nda.acknowledgedAt,
      decidedAt: nda.accessDecidedAt,
      entityName: profile?.entityName || "",
      entityType: ENTITY_LABELS[profile?.entityType ?? ""] ?? "",
      verified: profile?.status === "APPROVED",
      user: nda.user,
    };
  });
}

type DocumentViewer = { id: string; role: string; accountStatus: string; subscriptionTier: string; subscriptionStatus: string; subscriptionCurrentPeriodEnd?: Date | null };

// The download route's rule for one file and one person. `buyerCopy` is set when the file goes to a bidder rather
// than to the seller, the broker or the desk, so the route knows to stamp it.
export async function documentGate(user: DocumentViewer, documentId: string) {
  const document = await prisma.document.findUnique({ where: { id: documentId }, include: { listing: true } });
  if (!document) return { document: null, allowed: false, buyerCopy: false };
  const owner = document.listing.sellerId === user.id || (Boolean(document.listing.brokerId) && document.listing.brokerId === user.id);
  const admin = user.role === "ADMIN";
  // A coming-soon listing's room stays shut to buyers until launch, whatever they signed on an earlier approval.
  if (!owner && !admin && launchPending(document.listing)) return { document, allowed: false, buyerCopy: false };
  const [ownNda, nda] = await Promise.all([
    prisma.ndaAcknowledgment.findFirst({ where: { userId: user.id, documentId: document.id } }),
    prisma.ndaAcknowledgment.findUnique({ where: { userId_listingId: { userId: user.id, listingId: document.listingId } } }),
  ]);
  const deal = owner || admin ? { whole: false, loans: new Set<string>() } : await dealAccess(document.listingId, user.id);
  // A loan's own file follows that loan: sold out of a pool, it closes to everyone but its buyer.
  const note = document.noteId
    ? await prisma.note.findUnique({ where: { id: document.noteId }, select: { id: true, listingId: true, tradeStatus: true } })
    : null;
  // An NDA waiting on the seller, or declined, opens nothing but the buyer's own signed copy.
  const signedNda = ndaOpensRoom(nda);
  const allowed = canReadDocument({
    owner,
    admin,
    ownNda: Boolean(ownNda),
    privateFile: isPrivateDocument(document, document.listing),
    deskOnly: isDeskOnlyDocument(document),
    proBuyer: user.role === "BUYER" && user.accountStatus === "APPROVED" && isPro(user),
    signedNda,
    listingStatus: document.listing.status,
    closingParty: deal.whole || deal.loans.size > 0,
    loan: document.noteId
      ? loanFileAccess({ note, listingId: document.listingId, listingStatus: document.listing.status, signedNda, wholeParty: deal.whole, loanIds: deal.loans })
      : null,
  });
  // A buyer's own signed NDA is their record of what they agreed to, so it goes back to them as signed.
  return { document, allowed, buyerCopy: !owner && !admin && !ownNda };
}

// The name a buyer's copy carries: the vetted entity when there is one.
export async function stampName(user: { id: string; name: string; companyName?: string | null }) {
  const profile = await prisma.buyerProfile.findUnique({ where: { userId: user.id }, select: { entityName: true } });
  return profile?.entityName || user.companyName || user.name;
}
