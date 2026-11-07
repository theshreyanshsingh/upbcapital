import type { InvestorEntity, ListingStatus, VerificationStatus } from "@prisma/client";
import { removeStoredFile } from "@/lib/account-deletion";
import { audit } from "@/lib/audit";
import { DESK_DENIED, deskCan, type Staff } from "@/lib/desk-roles";
import { notify, notifyDesk } from "@/lib/email";
import { MAIN_FILE_ENTITIES, entityLabel } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { OFAC_DOWN_MESSAGE, OFAC_HOLD_MESSAGE, ofacHold, screenAndRecord } from "@/lib/screening";
import { extensionOf, mimeFor, putBytes, safeBasename } from "@/lib/storage";
import { uploadProblem } from "@/lib/uploads";

type SellerAccount = { id: string; name: string; companyName?: string | null };

// The name a sale's papers give the seller: the entity the desk approved on the seller's identity file, else the
// account's company or name.
export async function sellerOnTitle(seller: SellerAccount) {
  const profile = await prisma.sellerProfile.findUnique({ where: { userId: seller.id }, select: { status: true, entityName: true } });
  if (profile?.status === "APPROVED" && profile.entityName.trim()) return profile.entityName.trim();
  return seller.companyName || seller.name;
}

// Whether a listing needs its seller's identity approved before the desk approves it. The desk's setting wins;
// without one, release builds require it and the demo doesn't.
export function sellerIdentityRequired(settings: { requireSellerIdentity?: boolean | null }, env: Record<string, string | undefined> = process.env) {
  if (typeof settings.requireSellerIdentity === "boolean") return settings.requireSellerIdentity;
  return env.UPB_RELEASE === "1";
}

// ---------------------------------------------------------------------------------------------------------------
// The seller file: who is selling, who signs for them, and a document showing that person may sell. The desk reads
// both documents and approves, asks for changes, or declines. A vendor check, when one is set, is identity only.

export const SELLER_ROLES = ["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER"] as const;

export function isSellerRole(role: string | null | undefined) {
  return (SELLER_ROLES as readonly string[]).includes(role ?? "");
}

// Who keeps a seller file: every seller of record. A broker is the seller of record on what they file, so they keep
// one too, with their license or firm authority as the authority document. Each note holder's mandate goes on that
// listing. Only the desk's own paper goes without.
export function keepsSellerFile(role: string | null | undefined) {
  return isSellerRole(role) || role === "BROKER";
}

// A seller sells as themselves or through an entity. An IRA is a buying vehicle, so it isn't offered here.
export const SELLER_ENTITIES = MAIN_FILE_ENTITIES;
const ENTITY_VALUES = new Set<string>(SELLER_ENTITIES.map((entity) => entity.value));

export const SELLER_FILE_HREF = "/admin/verification/sellers";

export const TAX_ID_NOTE = "The last four digits only. UPB never asks for the whole number and never stores it, so don't type it here.";

// What shows the signer may sell, by how the note is held.
export const AUTHORITY_HELP: Record<string, string> = {
  INDIVIDUAL: "The endorsement or assignment of the note to you, so the desk sees you hold it.",
  LLC: "The operating agreement, or a resolution of the members, naming the person who signs.",
  TRUST: "A certificate of trust naming the trustee who signs.",
  FUND: "A resolution, or the fund's governing documents, naming the person who signs.",
  OTHER: "A resolution, or the entity's governing documents, naming the person who signs.",
};

// A broker's file shows they may act as a broker. The note holder's mandate goes on each listing instead, as a
// Mandate file, since a broker lists for many holders.
export const BROKER_AUTHORITY_HELP =
  "Your broker license, or a resolution or letter showing you may act for your firm. Each note holder's signed mandate or listing agreement goes on that listing as a Mandate file.";

export const ID_HELP = "A driver's license or passport for the person who signs.";

export type SellerDocKind = "id" | "authority";
const DOC_LABEL: Record<SellerDocKind, string> = { id: "identity document", authority: "authority document" };
const DOC_TYPES = new Set(["pdf", "png", "jpg", "jpeg", "webp"]);
// Two files go up in one form, and a server action body stops at 25 MB.
const DOC_MAX_BYTES = 10 * 1024 * 1024;

// Exactly four digits, spaces aside. Anything longer is refused rather than cut down, so a whole number typed here
// is never kept.
export function readTaxIdLast4(text: string) {
  const digits = text.replace(/\s/g, "");
  return /^\d{4}$/.test(digits) ? digits : null;
}

export type SellerIdentityFields = {
  entityType: InvestorEntity;
  entityName: string;
  signerName: string;
  signerTitle: string;
  taxIdLast4: string;
};

const text = (value: unknown, max: number) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function readSellerIdentity(fields: Record<string, unknown>): { error: string; data?: never } | { error: null; data: SellerIdentityFields } {
  const entityType = String(fields.entityType ?? "");
  const entityName = text(fields.entityName, 180);
  const signerName = text(fields.signerName, 120);
  const signerTitle = text(fields.signerTitle, 80);
  if (!ENTITY_VALUES.has(entityType)) return { error: "Choose how you sell: as yourself or through an entity." };
  if (entityName.length < 2) return { error: "Give the legal name the note is held in." };
  if (signerName.length < 2) return { error: "Name the person who signs for the seller." };
  if (entityType !== "INDIVIDUAL" && signerTitle.length < 2) return { error: "Give the signer's title, such as managing member or trustee." };
  const taxIdLast4 = readTaxIdLast4(String(fields.taxIdLast4 ?? ""));
  if (!taxIdLast4) return { error: "Enter only the last four digits of the EIN or SSN." };
  return { error: null, data: { entityType: entityType as InvestorEntity, entityName, signerName, signerTitle, taxIdLast4 } };
}

// An approved or declined file is the desk's. The seller writes the desk to change it.
export function sellerFileLocked(status: string | null | undefined) {
  if (status === "APPROVED") return "The desk approved this file. Write the desk to change it.";
  if (status === "REJECTED") return "The desk declined this file. Write the desk to reopen it.";
  return null;
}

const LOCKED: VerificationStatus[] = ["APPROVED", "REJECTED"];

export function sellerFileLabel(status: string | null | undefined) {
  if (status === "SUBMITTED") return "waiting for review";
  if (status === "APPROVED") return "approved";
  if (status === "CHANGES_REQUESTED") return "changes requested";
  if (status === "REJECTED") return "declined";
  return "not sent";
}

type ReadDoc = { error: string; file?: never } | { error: null; file: { bytes: Buffer; name: string; mime: string; ext: string } | null };

async function readDoc(value: FormDataEntryValue | null, kind: SellerDocKind): Promise<ReadDoc> {
  if (!(value instanceof File) || value.size === 0) return { error: null, file: null };
  const bytes = Buffer.from(await value.arrayBuffer());
  const ext = extensionOf(value.name);
  if (uploadProblem(value.name, bytes.length, bytes, DOC_MAX_BYTES) || !ext || !DOC_TYPES.has(ext)) {
    return { error: `Upload the ${DOC_LABEL[kind]} as a PDF or image under 10 MB.` };
  }
  return { error: null, file: { bytes, name: value.name.slice(0, 180), mime: mimeFor(ext, value.type || "application/octet-stream"), ext } };
}

async function dropFile(key: string) {
  await removeStoredFile(key).catch((error) => console.error(`[upb-seller-file] ${key} was not removed:`, error instanceof Error ? error.message : error));
}

type Seller = { id: string; name: string; email: string; role: string; accountStatus: string };

// The seller's own submission. Fields are checked before any file is stored, and a document already on file stays
// unless a new one replaces it. Screening runs separately, so the caller decides whether it waits.
export async function submitSellerIdentity(user: Seller, formData: FormData) {
  if (!keepsSellerFile(user.role)) return { error: "Seller files are for seller and broker accounts." } as const;
  if (user.accountStatus === "REJECTED" || user.accountStatus === "SUSPENDED") return { error: "This account can't send a seller file. Write the desk." } as const;
  const read = readSellerIdentity(Object.fromEntries(["entityType", "entityName", "signerName", "signerTitle", "taxIdLast4"].map((key) => [key, formData.get(key)])));
  if (read.error !== null) return { error: read.error } as const;
  const existing = await prisma.sellerProfile.findUnique({ where: { userId: user.id } });
  const locked = sellerFileLocked(existing?.status);
  if (locked) return { error: locked } as const;
  const [id, authority] = await Promise.all([readDoc(formData.get("idDoc"), "id"), readDoc(formData.get("authorityDoc"), "authority")]);
  if (id.error !== null) return { error: id.error } as const;
  if (authority.error !== null) return { error: authority.error } as const;
  if (!id.file && !existing?.idDocKey) return { error: "Upload an identity document for the person who signs." } as const;
  if (!authority.file && !existing?.authorityDocKey) return { error: "Upload the document that shows the signer may sell." } as const;

  const store = async (kind: SellerDocKind, file: NonNullable<typeof id.file>) => {
    const key = `seller-identity/${user.id}/${kind}-${crypto.randomUUID()}-${safeBasename(file.name)}`;
    await putBytes(key, file.bytes, file.mime);
    return key;
  };
  const idKey = id.file ? await store("id", id.file) : null;
  const authorityKey = authority.file ? await store("authority", authority.file) : null;
  const stored = [idKey, authorityKey].filter((key): key is string => Boolean(key));
  const data = {
    ...read.data,
    ...(idKey && id.file ? { idDocKey: idKey, idDocName: id.file.name, idDocMime: id.file.mime } : {}),
    ...(authorityKey && authority.file ? { authorityDocKey: authorityKey, authorityDocName: authority.file.name, authorityDocMime: authority.file.mime } : {}),
    status: "SUBMITTED" as const,
    submittedAt: new Date(),
    reviewerNote: "",
    reviewedAt: null,
    reviewedById: null,
  };
  if (existing) {
    // Conditional, so a desk decision that lands at the same moment stands.
    const saved = await prisma.sellerProfile.updateMany({ where: { userId: user.id, status: { notIn: LOCKED } }, data });
    if (saved.count !== 1) {
      await Promise.all(stored.map(dropFile));
      return { error: "The desk decided this file a moment ago. Reload to see it." } as const;
    }
    // The documents this one replaced served only this review, so they go.
    const replaced = [idKey && existing.idDocKey, authorityKey && existing.authorityDocKey].filter((key): key is string => Boolean(key));
    await Promise.all(replaced.map(dropFile));
  } else {
    await prisma.sellerProfile.upsert({ where: { userId: user.id }, update: data, create: { userId: user.id, ...data } });
  }
  await audit(user.id, "SELLER_FILE_SUBMITTED", "user", user.id, `${read.data.entityName} · ${entityLabel(read.data.entityType)} · signed by ${read.data.signerName}`);
  await notifyDesk(
    `Seller file submitted · ${user.name}`,
    `${read.data.entityName} (${entityLabel(read.data.entityType).toLowerCase()}), signed by ${read.data.signerName}, is waiting on the desk at ${SELLER_FILE_HREF}.`,
    { capability: "compliance" },
  );
  return { ok: true } as const;
}

// The entity and the person who signs for it, each against the list. Rows go under the seller's account, so an open
// match holds the seller file and the seller's listings alike.
export async function screenSellerIdentity(userId: string, context = "Seller file") {
  const profile = await prisma.sellerProfile.findUnique({ where: { userId }, select: { entityName: true, signerName: true } });
  if (!profile) return { unavailable: false };
  const names = new Set([profile.entityName, profile.signerName].map((name) => name.trim()).filter(Boolean));
  let unavailable = false;
  for (const name of names) unavailable = (await screenAndRecord(name, { context, userId })).unavailable || unavailable;
  return { unavailable };
}

const DECISIONS: Record<string, VerificationStatus> = { APPROVED: "APPROVED", CHANGES_REQUESTED: "CHANGES_REQUESTED", REJECTED: "REJECTED" };

function decisionMail(status: VerificationStatus, note: string) {
  if (status === "APPROVED") {
    return {
      subject: "Seller file approved",
      body: `${note ? `${note}\n\n` : ""}The desk approved your identity and signing authority. Buyers see that your identity is verified, and the desk still approves each listing before it goes live.`,
    };
  }
  if (status === "CHANGES_REQUESTED") return { subject: "Seller file needs changes", body: `${note}\n\nUpdate the file at /seller/verification and send it back.` };
  return { subject: "Seller file declined", body: `${note}\n\nWrite the desk if you think this is wrong.` };
}

// A compliance decision on a seller file. Approval needs both documents and screens the entity and signer again,
// and waits on the answer. `seen` is the submission the desk read, so a file sent again since is decided afresh.
export async function decideSellerIdentity(reviewer: Staff & { id: string }, input: { userId: string; decision: string; note: string; seen?: string }) {
  if (!deskCan(reviewer, "compliance")) return { error: DESK_DENIED } as const;
  const status = DECISIONS[input.decision];
  if (!status) return { error: "Choose a decision." } as const;
  const note = text(input.note, 600);
  if (status !== "APPROVED" && note.length < 3) return { error: "Tell the seller what to fix, or why the file is declined." } as const;
  const profile = await prisma.sellerProfile.findUnique({ where: { userId: input.userId }, include: { user: { select: { email: true, name: true } } } });
  if (!profile?.submittedAt || profile.status === "NOT_STARTED") return { error: "That seller hasn't sent a file yet." } as const;
  const resent = "The seller sent the file again a moment ago. Reload and decide again.";
  if (input.seen && input.seen !== profile.submittedAt.toISOString()) return { error: resent } as const;
  if (status === "APPROVED") {
    if (!profile.idDocKey || !profile.authorityDocKey) return { error: "Both documents have to be on file before approval." } as const;
    if ((await screenSellerIdentity(profile.userId, "Seller file approval")).unavailable) return { error: OFAC_DOWN_MESSAGE } as const;
    if (await ofacHold({ userIds: [profile.userId] })) return { error: OFAC_HOLD_MESSAGE } as const;
  }
  const now = new Date();
  const saved = await prisma.sellerProfile.updateMany({
    where: { userId: profile.userId, submittedAt: profile.submittedAt },
    data: { status, reviewerNote: note, reviewedById: reviewer.id, reviewedAt: now },
  });
  if (saved.count !== 1) return { error: resent } as const;
  await audit(reviewer.id, "SELLER_FILE", "user", profile.userId, `${status}${note ? ` · ${note}` : ""}`);
  const mail = decisionMail(status, note);
  await notify(profile.user.email, mail.subject, mail.body);
  return { ok: true, status } as const;
}

// A vendor case opened from the seller page. The reference goes on the file for the desk; the status stays with the
// desk, which still reads the documents.
export async function recordSellerVendor(user: { id: string }, started: { provider: string; reference: string }) {
  const data = { vendor: started.provider, vendorRef: started.reference };
  const existing = await prisma.sellerProfile.findUnique({ where: { userId: user.id }, select: { status: true } });
  if (!existing) {
    await prisma.sellerProfile.upsert({ where: { userId: user.id }, update: data, create: { userId: user.id, ...data } });
    return { ok: true } as const;
  }
  const opened = await prisma.sellerProfile.updateMany({ where: { userId: user.id, status: { notIn: LOCKED } }, data });
  if (opened.count !== 1) return { error: "The desk has already decided this file." } as const;
  return { ok: true } as const;
}

// A vendor's result on a seller's case, from the identity webhook. Like a buyer's, it tells the desk and decides
// nothing. False when no open seller file carries the reference.
export async function sellerVendorResult(parsed: { reference: string; userId: string; status: string }) {
  const reference = parsed.reference.trim();
  if (!reference) return false;
  const profile = await prisma.sellerProfile.findFirst({ where: { vendorRef: reference }, include: { user: { select: { name: true } } } });
  if (!profile || sellerFileLocked(profile.status) || (parsed.userId && parsed.userId !== profile.userId)) return false;
  const detail = `Vendor ${profile.vendor || "check"} ${reference.slice(0, 120)} said ${parsed.status}. The seller file waits on the desk.`;
  if (await prisma.auditEvent.findFirst({ where: { action: "KYC_WEBHOOK", entityId: profile.userId, detail } })) return true;
  await audit(null, "KYC_WEBHOOK", "user", profile.userId, detail);
  if (parsed.status !== "SUBMITTED") {
    const outcome = parsed.status === "APPROVED" ? "passed" : "did not pass";
    await notifyDesk(`Identity check ${outcome} · ${profile.user.name}`, `The vendor's identity check ${outcome} for seller ${profile.user.name}. The seller file still waits on your review.`, {
      capability: "compliance",
    });
  }
  return true;
}

// The seller and compliance read the documents. Other desk roles don't: an ID document is the most sensitive file
// on the desk.
export function canReadSellerFile(viewer: Staff & { id: string }, ownerId: string) {
  return viewer.id === ownerId || (viewer.role === "ADMIN" && deskCan(viewer, "compliance"));
}

// ---------------------------------------------------------------------------------------------------------------
// The listing approval gate. It asks the seller of record, whoever filed: a seller for themselves, or a broker for a
// note holder. Only the desk's own paper is exempt.

// A broker-filed listing also needs the note holder's mandate for it, as a MANDATE document on the listing.
type GateListing = { id?: string; sellerId: string; brokerId?: string | null; seller: { role: string } };

export const MANDATE_MISSING =
  "Approval waits on the note holder's mandate for this listing. The broker adds the signed mandate or listing agreement on the deal page as a Mandate file.";

// A listing's mandates, newest first. Desk-only files: lib/acl.ts isDeskOnlyDocument.
export function listingMandates(listingId: string) {
  return prisma.document.findMany({ where: { listingId, type: "MANDATE" }, select: { id: true, originalName: true, createdAt: true }, orderBy: { createdAt: "desc" } });
}

const IN_REVIEW: ListingStatus[] = ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED"];

// Broker-filed listings waiting on the desk with no mandate on file, for launch readiness.
export async function brokerListingsWithoutMandate() {
  const listings = await prisma.listing.findMany({ where: { brokerId: { not: null }, status: { in: IN_REVIEW } }, select: { id: true } });
  if (!listings.length) return 0;
  const covered = await prisma.document.findMany({ where: { listingId: { in: listings.map((listing) => listing.id) }, type: "MANDATE" }, select: { listingId: true } });
  const withMandate = new Set(covered.map((row) => row.listingId));
  return listings.filter((listing) => !withMandate.has(listing.id)).length;
}

export function identityGateApplies(listing: GateListing) {
  return keepsSellerFile(listing.seller.role);
}

export function identityGateMessage(status: string | null | undefined) {
  const why =
    status === "SUBMITTED"
      ? "Their file is waiting for review."
      : status === "CHANGES_REQUESTED"
        ? "Their file is back with them for changes."
        : status === "REJECTED"
          ? "The desk declined their file."
          : "They haven't sent their file yet.";
  return `Approval waits on the seller of record's identity and signing authority. ${why} Decide it under Seller files first.`;
}

// Why this listing can't be approved yet for its seller's identity, or null. An approved file's entity and signer
// are screened again with the listing, as every approval screens its parties.
export async function sellerIdentityHold(listing: GateListing, settings: { requireSellerIdentity?: boolean | null }, env: Record<string, string | undefined> = process.env) {
  if (!identityGateApplies(listing)) return null;
  const profile = await prisma.sellerProfile.findUnique({ where: { userId: listing.sellerId }, select: { status: true } });
  const required = sellerIdentityRequired(settings, env);
  if (required && profile?.status !== "APPROVED") return identityGateMessage(profile?.status);
  if (required && listing.brokerId && !(listing.id && (await listingMandates(listing.id)).length)) return MANDATE_MISSING;
  if (profile?.status === "APPROVED" && (await screenSellerIdentity(listing.sellerId, "Seller file on listing approval")).unavailable) return OFAC_DOWN_MESSAGE;
  return null;
}

export async function sellerVerified(sellerId: string) {
  const profile = await prisma.sellerProfile.findUnique({ where: { userId: sellerId }, select: { status: true } });
  return profile?.status === "APPROVED";
}
