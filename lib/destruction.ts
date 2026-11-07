import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { canManageRoom, ndaOpensRoom } from "@/lib/acl";
import { audit } from "@/lib/audit";
import { bidderAlias } from "@/lib/bidder-alias";
import { unset } from "@/lib/db-filters";
import { notify, sendAlert } from "@/lib/email";
import { prisma } from "@/lib/prisma";

// Once a listing goes to another buyer, every bidder whose room opened is asked once to certify they destroyed the
// files, as the NDA requires, and reminded once a week later. The certificate names the bidder for themselves and
// the desk, and by letter for the seller and broker, as everything else does after an award.

const DAY = 24 * 60 * 60 * 1000;
export const REMIND_AFTER_DAYS = 7;
// A request older than this gets no reminder, so the reminder marker below outlives every request it could match.
const REMIND_UNTIL_DAYS = 90;
// How far the first run looks back when no earlier run is on record.
const FIRST_LOOKBACK_DAYS = 30;

// In contract or sold, the room is shut to everyone outside the deal (lib/acl.ts dataRoomOpenTo). A pool sold loan
// by loan stays live until its last loan sells, and a losing bid on one loan can still bid on the rest until then.
const SHUT = ["PENDING", "SOLD"] as const;

const appUrl = () => process.env.NEXT_PUBLIC_APP_URL || "";
export const certificateLink = (ndaId: string) => `${appUrl()}/api/destruction/${ndaId}`;

export type DestructionNda = {
  id: string;
  userId: string;
  listingId: string;
  user: { email: string; name: string };
  listing: { title: string };
};

// Where this run starts looking: the last run, less a day of overlap so a run that failed part-way is picked up
// again. The request marker on each NDA stops a second send.
export async function destructionWindowStart(now = new Date()) {
  const last = await prisma.jobRun.findFirst({ orderBy: { startedAt: "desc" }, select: { startedAt: true } });
  return last ? new Date(last.startedAt.getTime() - DAY) : new Date(now.getTime() - FIRST_LOOKBACK_DAYS * DAY);
}

// The buyers of one listing keep the files: each awarded bidder and group seat holder on a closing still standing.
async function buyersOf(listingId: string) {
  const closings = await prisma.closing.findMany({
    where: { listingId, status: { not: "CANCELED" } },
    select: { inquiryId: true, funders: { select: { userId: true } } },
  });
  const inquiryIds = closings.map((closing) => closing.inquiryId).filter((id): id is string => Boolean(id));
  const bids = inquiryIds.length ? await prisma.inquiry.findMany({ where: { id: { in: inquiryIds } }, select: { buyerId: true } }) : [];
  return new Set([...bids.map((bid) => bid.buyerId), ...closings.flatMap((closing) => closing.funders.map((funder) => funder.userId))]);
}

const ndaInclude = { user: { select: { email: true, name: true, role: true, deletedAt: true } }, listing: { select: { title: true } } } as const;

// The NDAs still to ask: on each listing whose sale moved since `since` (a closing opened or closed) and that is now
// shut, every buyer whose room opened and who isn't buying. A bidder who was declined or never let in had no files.
// `listingIds` narrows a run, so a test asks about its own listings only.
export async function destructionRequestsDue(since: Date, options: { listingIds?: string[] } = {}) {
  const closings = await prisma.closing.findMany({
    where: {
      status: { not: "CANCELED" },
      OR: [{ openedAt: { gte: since } }, { closedAt: { gte: since } }],
      listing: { status: { in: [...SHUT] } },
      ...(options.listingIds ? { listingId: { in: options.listingIds } } : {}),
    },
    select: { listingId: true },
  });
  const due: DestructionNda[] = [];
  for (const listingId of new Set(closings.map((closing) => closing.listingId))) {
    const [buyers, ndas] = await Promise.all([
      buyersOf(listingId),
      prisma.ndaAcknowledgment.findMany({ where: { listingId, AND: [unset("destroyRequestedAt"), unset("destroyedAt")] }, include: ndaInclude }),
    ]);
    due.push(...ndas.filter((nda) => nda.user.role === "BUYER" && !nda.user.deletedAt && !buyers.has(nda.userId) && ndaOpensRoom(nda)));
  }
  return due;
}

function requestBody(title: string, reminder: boolean) {
  return `${reminder ? "A reminder. " : ""}${title} went to another buyer, so its data room is closed to you. Your NDA asks you to destroy every file you took from the room, with any copies and notes that carry borrower details.

Once you have, certify it on your inquiries page: ${appUrl()}/buyer/offers#destruction

The seller gets a certificate that names you by your bidder letter only.`;
}

// Claimed on destroyRequestedAt, so two overlapping runs ask once. It reaches the inbox whatever the email setting
// says, because it is an obligation under the NDA rather than news.
export async function sendDestructionRequest(nda: DestructionNda, now = new Date()) {
  const claim = await prisma.ndaAcknowledgment.updateMany({
    where: { id: nda.id, AND: [unset("destroyRequestedAt"), unset("destroyedAt")] },
    data: { destroyRequestedAt: now },
  });
  if (claim.count !== 1) return false;
  await sendAlert(nda.user.email, `Destroy the data room files · ${nda.listing.title}`, requestBody(nda.listing.title, false));
  await audit(null, "DATA_DESTRUCTION_REQUESTED", "listing", nda.listingId, `Asked bidder ${nda.userId} to certify the room's files destroyed · nda ${nda.id}`);
  return true;
}

export async function destructionRemindersDue(now = new Date(), options: { listingIds?: string[] } = {}) {
  const ndas = await prisma.ndaAcknowledgment.findMany({
    where: {
      destroyRequestedAt: { lte: new Date(now.getTime() - REMIND_AFTER_DAYS * DAY), gte: new Date(now.getTime() - REMIND_UNTIL_DAYS * DAY) },
      ...unset("destroyedAt"),
      ...(options.listingIds ? { listingId: { in: options.listingIds } } : {}),
    },
    include: ndaInclude,
  });
  return ndas.filter((nda) => !nda.user.deletedAt);
}

// NdaAcknowledgment has no reminder field, so the one reminder is claimed with a marker row keyed by the NDA. The key
// is the row's id, so only the run that created it sends. It outlasts the reminder window.
export const reminderMarker = (ndaId: string) => `destroy-reminder:${ndaId}`;

export async function sendDestructionReminder(nda: DestructionNda, now = new Date()) {
  try {
    // The first run creates the row at 1; a later run only counts up, and sends nothing.
    const marker = await prisma.rateWindow.upsert({
      where: { key: reminderMarker(nda.id) },
      create: { key: reminderMarker(nda.id), count: 1, expiresAt: new Date(now.getTime() + 400 * DAY) },
      update: { count: { increment: 1 } },
    });
    if (marker.count !== 1) return false;
  } catch (error) {
    // Two runs inserting at once: the one that lost sends nothing.
    if ((error as { code?: string }).code === "P2002") return false;
    throw error;
  }
  await sendAlert(nda.user.email, `Reminder: destroy the data room files · ${nda.listing.title}`, requestBody(nda.listing.title, true));
  await audit(null, "DATA_DESTRUCTION_REMINDED", "listing", nda.listingId, `Reminded bidder ${nda.userId} · nda ${nda.id}`);
  return true;
}

// The bidder's own record of it. Claimed on destroyedAt, so a double click certifies once. The bidder and the seller
// each get the certificate's link; the seller's mail names the bidder by letter.
export async function certifyDestruction(input: { ndaId: string; userId: string; ipAddress?: string }, now = new Date()) {
  const nda = await prisma.ndaAcknowledgment.findFirst({
    where: { id: input.ndaId, userId: input.userId },
    include: { listing: { select: { title: true, seller: { select: { email: true } } } }, user: { select: { email: true } } },
  });
  if (!nda) return { error: "That request isn't on your account." } as const;
  if (!nda.destroyRequestedAt) return { error: "Nobody has asked you to destroy these files yet." } as const;
  if (nda.destroyedAt) return { error: "You already certified this one." } as const;
  const claim = await prisma.ndaAcknowledgment.updateMany({ where: { id: nda.id, userId: input.userId, ...unset("destroyedAt") }, data: { destroyedAt: now } });
  if (claim.count !== 1) return { error: "You already certified this one." } as const;
  await audit(input.userId, "DATA_DESTROYED", "listing", nda.listingId, `Certified the room's files destroyed · nda ${nda.id}${input.ipAddress ? ` · ${input.ipAddress}` : ""}`);
  const title = nda.listing.title;
  const day = now.toISOString().slice(0, 10);
  const link = certificateLink(nda.id);
  await notify(nda.user.email, `Destruction certificate · ${title}`, `You certified on ${day} that you destroyed the data room files for ${title}. The certificate, as a PDF: ${link}\n\nThe seller has a copy that names you by your bidder letter.`);
  const alias = await bidderAlias(nda.listingId, input.userId);
  await notify(nda.listing.seller.email, `Destruction certificate · ${title}`, `${alias} certified on ${day} that they destroyed the data room files for ${title}. The certificate, as a PDF: ${link}`);
  return { ok: true } as const;
}

// What the buyer's inquiries page lists: open requests first, then the ones already certified.
export async function destructionRequestsFor(userId: string) {
  return prisma.ndaAcknowledgment.findMany({
    where: { userId, destroyRequestedAt: { not: null } },
    select: { id: true, listingId: true, destroyRequestedAt: true, destroyedAt: true, listing: { select: { title: true } } },
    orderBy: { destroyRequestedAt: "desc" },
    take: 20,
  });
}

// One cell in the access log and the engagement summary.
export function destructionLabel(nda: { destroyRequestedAt?: Date | null; destroyedAt?: Date | null } | undefined) {
  if (nda?.destroyedAt) return "Certified";
  if (nda?.destroyRequestedAt) return "Asked";
  return "";
}

function wrap(text: string, width: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > width && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export type CertificateInput = {
  ndaId: string;
  listingId: string;
  listingTitle: string;
  bidder: string;
  ndaSignedAt: Date;
  requestedAt: Date | null;
  destroyedAt: Date;
};

// Laid out like the settlement statement in lib/settlement.ts.
export async function buildDestructionPdf(input: CertificateInput) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const quiet = rgb(0.42, 0.42, 0.46);
  const clean = (text: string) => text.replace(/[^\x20-\x7E]/g, "-");
  const stamp = (at: Date | null) => (at ? `${at.toISOString().slice(0, 16).replace("T", " ")} UTC` : "-");
  page.drawText("UPB CAPITAL  -  DATA DESTRUCTION CERTIFICATE", { x: 48, y: 744, size: 10, font: bold, color: quiet });
  page.drawText(clean(input.listingTitle).slice(0, 70), { x: 48, y: 712, size: 18, font: bold, color: ink });
  page.drawText(`Listing ${input.listingId}  -  certificate ${input.ndaId}`, { x: 48, y: 692, size: 9, font, color: quiet });
  const facts: [string, string][] = [
    ["Bidder", clean(input.bidder).slice(0, 80)],
    ["NDA signed", stamp(input.ndaSignedAt)],
    ["Asked to destroy the files", stamp(input.requestedAt)],
    ["Certified destroyed", stamp(input.destroyedAt)],
  ];
  let y = 650;
  for (const [label, value] of facts) {
    page.drawText(label, { x: 48, y, size: 10, font, color: quiet });
    page.drawText(value, { x: 220, y, size: 10, font: bold, color: ink });
    y -= 20;
  }
  y -= 16;
  const statement =
    "The bidder named above certifies that, after this listing went to another buyer, it destroyed or deleted every file it took from the UPB Capital data room for this listing, including copies, extracts and notes that carry borrower information, as its confidentiality agreement requires.";
  for (const line of wrap(statement, 92)) {
    page.drawText(line, { x: 48, y, size: 10, font, color: ink });
    y -= 15;
  }
  const footer = [
    "Recorded by UPB Capital from the bidder's own certification, made signed in to the desk. UPB did not inspect",
    "the bidder's systems. The desk's audit log keeps the certification with its time and network address.",
  ];
  footer.forEach((line, index) => page.drawText(line, { x: 48, y: 72 - index * 12, size: 8, font, color: quiet }));
  return pdf.save();
}

// Who may open a certificate and how it names the bidder: the bidder and the desk by name, the seller and the broker
// by letter. The NDA's signer name stays after an account is deleted, so the desk's copy still reads.
export async function destructionCertificate(ndaId: string, viewer: { id: string; role: string }) {
  const nda = await prisma.ndaAcknowledgment.findUnique({
    where: { id: ndaId },
    include: { listing: { select: { id: true, title: true, sellerId: true, brokerId: true } }, user: { select: { name: true, companyName: true } } },
  });
  if (!nda?.destroyedAt) return { status: 404 as const };
  const own = viewer.id === nda.userId;
  if (!own && !canManageRoom(viewer, nda.listing)) return { status: 403 as const };
  let bidder: string;
  if (own || viewer.role === "ADMIN") {
    const profile = await prisma.buyerProfile.findUnique({ where: { userId: nda.userId }, select: { entityName: true } });
    const entity = profile?.entityName || nda.user.companyName;
    const signer = nda.signerName || nda.user.name;
    bidder = entity && entity !== signer ? `${signer} for ${entity}` : signer;
  } else {
    bidder = await bidderAlias(nda.listingId, nda.userId);
  }
  const pdf = await buildDestructionPdf({
    ndaId: nda.id,
    listingId: nda.listing.id,
    listingTitle: nda.listing.title,
    bidder,
    ndaSignedAt: nda.acknowledgedAt,
    requestedAt: nda.destroyRequestedAt,
    destroyedAt: nda.destroyedAt,
  });
  return { status: 200 as const, pdf, bidder };
}
