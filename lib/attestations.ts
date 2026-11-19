import type { BidderAttestation } from "@prisma/client";
import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { notify } from "@/lib/email";
import { prettyDate } from "@/lib/format";
import { REGULATED, REGULATED_ONLY_LINE, regulatedBlock, regulatedOnly } from "@/lib/institutions";
import { US_STATES } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { recertifyByFrom } from "@/lib/verification";

// Bidder attestations: a buyer's standing statement for one buying entity, given once on the buyer file and reused at
// every bid, such as an agency sale's bidder certification or a debt-buyer licence. A listing names the kinds its
// bidders need (Listing.requiredAttestations), and a bid, group seat or standing bid for an entity without a current
// one of each is refused. Each is stored with the exact wording and its version, so a later change to the text never
// rewrites what was certified. Not to be confused with actions/attestations.ts, which is post-close trade feedback.

export type AttestationKind = {
  label: string;
  // Bumped when the wording changes. One given under an older version no longer counts, and the buyer gives it again.
  version: string;
  text: string;
  // A licence or registration number the statement names, when the kind asks for one.
  reference: { label: string; placeholder: string; help: string } | null;
  // How long one lasts, in months. Null lasts until the wording changes.
  months: number | null;
};

const DRAFT = "This is UPB's draft of the statement, which counsel is still reviewing.";

// Add a kind here and it shows on the buyer file, in the listing settings and in the bid checks. Change a kind's
// wording and bump its version together.
export const ATTESTATION_KINDS = {
  HUD_EO_14376: {
    label: "HUD bidder certification (Executive Order 14376)",
    version: "draft-1",
    text: [
      "For the buying entity named here, I certify that it complies with Executive Order 14376, Stopping Wall Street from Competing with Main Street Homebuyers (January 20, 2026), and with Title X of the ROAD to Housing Act, as they apply to its bids in sales of loans by HUD or another federal agency, and that I may sign for it.",
      "I will tell the desk at once if that stops being true.",
      // Counsel: HUD hasn't published its bidder form's wording where we could read it.
      "This is UPB's draft of the statement. Counsel and the agency's own bidder form control, and an agency sale may still ask for its form as well.",
    ].join(" "),
    reference: null,
    // Good until the agency changes its form, which bumps the version.
    months: null,
  },
  DEBT_BUYER_LICENSE: {
    label: "Debt-buyer licence statement",
    version: "draft-1",
    text: [
      "For the buying entity named here, I certify that it holds the debt-buyer or collection licence named below, that the licence is current and in good standing, and that I may sign for it.",
      "I will tell the desk at once if the licence lapses, is suspended or is revoked.",
      // Counsel: which states license buyers of residential mortgage debt, and whether a bank or credit union is exempt.
      DRAFT,
    ].join(" "),
    reference: { label: "State and licence number", placeholder: "PA DB-012345", help: "The state's two-letter code, then the licence number as the regulator issued it." },
    months: 12,
  },
  QUALIFIED_PURCHASER: {
    label: "Qualified purchaser statement",
    version: "draft-1",
    text: [
      "For the buying entity named here, I certify that it is a qualified purchaser as section 2(a)(51) of the Investment Company Act of 1940 defines the term, and that I may sign for it.",
      "I will tell the desk at once if that stops being true.",
      DRAFT,
    ].join(" "),
    reference: null,
    months: 12,
  },
} satisfies Record<string, AttestationKind>;

export type AttestationKey = keyof typeof ATTESTATION_KINDS;
export const ATTESTATION_KEYS = Object.keys(ATTESTATION_KINDS) as AttestationKey[];

export function isAttestationKind(value: unknown): value is AttestationKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ATTESTATION_KINDS, value);
}

export function kindOf(key: AttestationKey): AttestationKind {
  return ATTESTATION_KINDS[key];
}

export function lastsLine(kind: AttestationKind) {
  if (!kind.months) return "Lasts until the wording changes.";
  return kind.months === 12 ? "Lasts a year." : `Lasts ${kind.months} months.`;
}

export function attestationLabel(key: string) {
  return isAttestationKind(key) ? kindOf(key).label : key.replaceAll("_", " ").toLowerCase();
}

// The kinds a listing asks for, in the list's order. A kind no longer in the code can't be given, so it is left out
// rather than stopping every bid.
export function requiredKinds(raw: readonly string[] | null | undefined): AttestationKey[] {
  const asked = new Set(raw ?? []);
  return ATTESTATION_KEYS.filter((key) => asked.has(key));
}

// A label mid-sentence: "debt-buyer licence statement", but "HUD bidder certification".
const phrase = (label: string) => (/^[A-Z]{2}/.test(label) ? label : `${label.charAt(0).toLowerCase()}${label.slice(1)}`);

export function sentenceLabel(key: string) {
  return phrase(attestationLabel(key));
}

export function kindList(keys: readonly string[]) {
  const labels = keys.map(sentenceLabel);
  return labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

const STATES = new Set<string>(US_STATES);

// "pa db-012345" reads as "PA DB-012345": a state code, then a licence number with at least one digit.
export function readReference(raw: unknown) {
  const value = String(raw ?? "").replace(/\s+/g, " ").trim();
  const match = /^([A-Za-z]{2})[\s,:·-]+([A-Za-z0-9][A-Za-z0-9 ./-]{0,38})$/.exec(value);
  const state = match?.[1].toUpperCase() ?? "";
  if (!match || !STATES.has(state) || !/\d/.test(match[2])) return { error: "Give the state's two-letter code and the licence number, such as PA DB-012345." } as const;
  return { error: null, value: `${state} ${match[2].trim().toUpperCase()}` } as const;
}

export type AttestationState = "current" | "expired" | "revoked" | "outdated";
type Row = Pick<BidderAttestation, "kind" | "version" | "expiresAt" | "revokedAt">;

// Withdrawn or revoked first, then a wording that has moved on, then the date.
export function attestationState(row: Row, now = new Date()): AttestationState {
  if (row.revokedAt) return "revoked";
  if (!isAttestationKind(row.kind) || row.version !== kindOf(row.kind).version) return "outdated";
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "current";
}

const sameFile = (row: { buyerEntityId?: string | null }, buyerEntityId: string | null) => (row.buyerEntityId ?? null) === buyerEntityId;

// The latest one of each kind for one file decides. Rows come newest first.
export function latestOf<T extends Row & { buyerEntityId?: string | null; attestedAt: Date }>(rows: T[], buyerEntityId: string | null, kind: string) {
  return rows.filter((row) => row.kind === kind && sameFile(row, buyerEntityId)).sort((a, b) => b.attestedAt.getTime() - a.attestedAt.getTime())[0] ?? null;
}

export async function attestationsOf(userId: string) {
  return prisma.bidderAttestation.findMany({ where: { userId }, orderBy: { attestedAt: "desc" } });
}

// The kinds among these that this file has no current attestation of.
export async function attestationGaps(input: { userId: string; buyerEntityId: string | null; kinds: readonly string[]; now?: Date }) {
  const kinds = requiredKinds(input.kinds);
  if (!kinds.length) return [];
  const now = input.now ?? new Date();
  const rows = await prisma.bidderAttestation.findMany({ where: { userId: input.userId, kind: { in: kinds } }, orderBy: { attestedAt: "desc" } });
  return kinds.filter((kind) => {
    const latest = latestOf(rows, input.buyerEntityId, kind);
    return !latest || attestationState(latest, now) !== "current";
  });
}

export const ATTESTATIONS_HREF = "/buyer/verification#attestations";

// Why a bid on this listing can't go in for this entity, or null: a sale open to banks and credit unions only, or a
// statement the listing asks for that the entity has none current of. A missing statement sends the buyer to their
// file, where they give it.
export async function bidderLimitBlock(input: { user: { id: string }; listingId: string; buyerEntityId: string | null; now?: Date; seat?: boolean }) {
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, select: { buyerLimit: true, requiredAttestations: true } });
  if (!listing) return null;
  const regulated = await regulatedBlock(listing, input.user, input.buyerEntityId, { seat: input.seat });
  if (regulated) return { error: regulated, verification: false };
  const missing = await attestationGaps({ userId: input.user.id, buyerEntityId: input.buyerEntityId, kinds: listing.requiredAttestations, now: input.now });
  if (!missing.length) return null;
  const which = input.buyerEntityId ? "the buying entity you chose" : "your main buyer file";
  const named = `This sale asks each bidder for a current ${kindList(missing)}, and ${which} has none. Give ${missing.length === 1 ? "it" : "them"} in your buyer file at ${ATTESTATIONS_HREF}, then bid again.`;
  // A notice past 300 characters doesn't show (lib/notice-text.ts), so a long list gives the count and the page.
  const error = named.length <= 300 ? named : `This sale asks each bidder for ${missing.length} statements that ${which} has none current of. See which in your buyer file at ${ATTESTATIONS_HREF}, then bid again.`;
  return { error, verification: true };
}

// The desk book has no buyer file to hold a bank charter or a statement, so it doesn't bid where the seller asked
// for either.
export function deskBookBlock(listing: { buyerLimit?: string | null; requiredAttestations?: string[] | null }) {
  if (regulatedOnly(listing)) return `${REGULATED_ONLY_LINE} The desk book doesn't bid on it.`;
  const kinds = requiredKinds(listing.requiredAttestations);
  if (kinds.length) return `This sale asks each bidder for a ${kindList(kinds)}, and the desk book has no buyer file to give ${kinds.length === 1 ? "it" : "them"} on.`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The buyer gives, renews and withdraws. The desk revokes.

type Giver = { id: string; name: string; actor?: { id: string } | null };

// The file the statement is for: the main file, or one of the buyer's own entities the desk hasn't declined.
async function fileName(userId: string, buyerEntityId: string | null) {
  if (!buyerEntityId) {
    const profile = await prisma.buyerProfile.findUnique({ where: { userId }, select: { entityName: true, status: true } });
    if (!profile) return { error: "Start your buyer file first." } as const;
    if (profile.status === "REJECTED") return { error: "The desk declined your buyer file. Write the desk to reopen it." } as const;
    return { error: null, name: profile.entityName.trim() || "Your main buyer file" } as const;
  }
  const entity = await prisma.buyerEntity.findUnique({ where: { id: buyerEntityId }, select: { userId: true, name: true, status: true } });
  if (!entity || entity.userId !== userId) return { error: "Choose one of your own buying entities." } as const;
  if (entity.status === "REJECTED") return { error: "The desk declined that entity, so it can't give statements." } as const;
  return { error: null, name: entity.name } as const;
}

// A new attestation in the kind's current wording. Giving one again is the renewal: the newest one decides.
export async function giveAttestation(user: Giver, input: { kind: unknown; buyerEntityId?: unknown; reference?: unknown; agreed: boolean }, now = new Date()) {
  if (!isAttestationKind(input.kind)) return { error: "Choose a statement to give." } as const;
  const kind = kindOf(input.kind);
  const buyerEntityId = String(input.buyerEntityId ?? "").trim() || null;
  const file = await fileName(user.id, buyerEntityId);
  if (file.error !== null) return { error: file.error } as const;
  let reference: string | null = null;
  if (kind.reference) {
    const read = readReference(input.reference);
    if (read.error !== null) return { error: read.error } as const;
    reference = read.value;
  }
  if (!input.agreed) return { error: `Tick the box to give the statement for ${file.name}.` } as const;
  const row = await prisma.bidderAttestation.create({
    data: {
      userId: user.id,
      buyerEntityId,
      kind: input.kind,
      version: kind.version,
      text: kind.text,
      reference,
      attestedAt: now,
      attestedById: user.actor?.id ?? user.id,
      expiresAt: kind.months ? recertifyByFrom(now, kind.months) : null,
    },
  });
  await audit(user.id, "BIDDER_ATTESTATION", "user", user.id, `${row.id} · ${kind.label} · version ${kind.version} · ${file.name}${reference ? ` · ${reference}` : ""}`, user.actor?.id);
  return { error: null, attestation: row, name: file.name } as const;
}

// The buyer takes back their own current statement. Bids already in stay; new ones for that entity need it again.
export async function withdrawAttestation(user: Giver, attestationId: string, now = new Date()) {
  const row = await prisma.bidderAttestation.findUnique({ where: { id: attestationId } });
  if (!row || row.userId !== user.id) return { error: "That statement isn't on your file." } as const;
  const claimed = await prisma.bidderAttestation.updateMany({ where: { id: row.id, ...unset("revokedAt") }, data: { revokedAt: now } });
  if (claimed.count !== 1) return { error: "That statement is already withdrawn." } as const;
  await audit(user.id, "BIDDER_ATTESTATION_WITHDRAWN", "user", user.id, `${row.id} · ${attestationLabel(row.kind)}`, user.actor?.id);
  return { error: null, label: sentenceLabel(row.kind) } as const;
}

// The desk revokes one, with a reason the buyer reads. It stops counting at once.
export async function revokeAttestation(desk: { id: string }, input: { attestationId: string; reason: unknown }, now = new Date()) {
  const reason = String(input.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (reason.length < 3) return { error: "Say why the desk is revoking it. The buyer reads the reason." } as const;
  const row = await prisma.bidderAttestation.findUnique({ where: { id: input.attestationId } });
  if (!row) return { error: "That statement no longer exists." } as const;
  const claimed = await prisma.bidderAttestation.updateMany({ where: { id: row.id, ...unset("revokedAt") }, data: { revokedAt: now } });
  if (claimed.count !== 1) return { error: "That statement is already withdrawn or revoked." } as const;
  const label = attestationLabel(row.kind);
  await audit(desk.id, "BIDDER_ATTESTATION_REVOKED", "user", row.userId, `${row.id} · ${label} · ${reason}`);
  const buyer = await prisma.user.findUnique({ where: { id: row.userId }, select: { email: true } });
  if (buyer) {
    await notify(
      buyer.email,
      `Statement revoked · ${label}`,
      `The desk revoked your ${sentenceLabel(row.kind)} given ${prettyDate(row.attestedAt)}. Reason: ${reason}${/[.?]$/.test(reason) ? "" : "."} Sales that ask for it take no new bid for that entity until you give it again at ${process.env.NEXT_PUBLIC_APP_URL || ""}${ATTESTATIONS_HREF}.`,
    );
  }
  return { error: null, userId: row.userId, label: sentenceLabel(row.kind) } as const;
}

// How each one ended, from the log: the buyer's withdrawal, or the desk's revocation with its reason.
export async function endings(userId: string) {
  const events = await prisma.auditEvent.findMany({
    where: { entityType: "user", entityId: userId, action: { in: ["BIDDER_ATTESTATION_WITHDRAWN", "BIDDER_ATTESTATION_REVOKED"] } },
    select: { action: true, detail: true },
  });
  const byId = new Map<string, { by: "buyer" | "desk"; reason: string }>();
  for (const event of events) {
    const [id, , ...rest] = event.detail.split(" · ");
    if (id) byId.set(id, { by: event.action === "BIDDER_ATTESTATION_REVOKED" ? "desk" : "buyer", reason: rest.join(" · ") });
  }
  return byId;
}

export function stateLine(row: Row & { attestedAt: Date }, now = new Date(), ending?: { by: "buyer" | "desk"; reason: string }) {
  const state = attestationState(row, now);
  if (state === "revoked") return ending?.by === "desk" ? `Revoked by the desk ${prettyDate(row.revokedAt)}${ending.reason ? `: ${ending.reason}` : ""}` : `Withdrawn ${prettyDate(row.revokedAt)}`;
  if (state === "outdated") return "The wording has changed since you gave it. Give it again.";
  if (state === "expired") return `Expired ${prettyDate(row.expiresAt)}. Renew it.`;
  return row.expiresAt ? `Given ${prettyDate(row.attestedAt)} · current until ${prettyDate(row.expiresAt)}` : `Given ${prettyDate(row.attestedAt)} · current until the wording changes`;
}

// ---------------------------------------------------------------------------------------------------------------
// The listing's settings: who may bid, and what each bidder needs on file.

const OPEN_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "CHANGES_REQUESTED", "APPROVED", "PENDING"];

export function limitsOpen(status: string) {
  return OPEN_STATUSES.includes(status);
}

const LIVE_BIDS = ["OPEN", "REVIEWED", "ACCEPTED"] as const;
const OPEN_GROUPS = ["GATHERING", "OFFERED", "COUNTERED", "CLOSING"] as const;

// Bids in, or a group gathering seats, lock the limits against tightening: a bidder already in would be caught by a
// rule they didn't bid under. Loosening stays open.
export async function bidsIn(listingId: string) {
  const [bids, groups] = await Promise.all([
    prisma.inquiry.count({ where: { listingId, type: "OFFER", status: { in: [...LIVE_BIDS] } } }),
    prisma.groupBuy.count({ where: { listingId, status: { in: [...OPEN_GROUPS] } } }),
  ]);
  return bids + groups > 0;
}

// Who may turn on the regulated-only limit: the desk, and an institutional seller on their own listing. Anyone who
// may change the settings may turn it off.
export function offersRegulatedSwitch(actor: { role: string }, seller: { role: string }) {
  return actor.role === "ADMIN" || seller.role === "INSTITUTIONAL_SELLER";
}

export async function setBidderLimits(actor: { id: string; role: string }, input: { listingId: string; regulated: boolean; kinds: unknown[] }) {
  const listing = await prisma.listing.findUnique({ where: { id: input.listingId }, select: { id: true, status: true, sellerId: true, buyerLimit: true, requiredAttestations: true, seller: { select: { role: true } } } });
  if (!listing || (actor.role !== "ADMIN" && listing.sellerId !== actor.id)) return { error: "That listing isn't yours to change." } as const;
  if (!limitsOpen(listing.status)) return { error: "This listing is closed, so there is nothing to change." } as const;
  if (input.kinds.some((kind) => !isAttestationKind(kind))) return { error: "Choose statements from the list." } as const;
  const kinds = requiredKinds(input.kinds as string[]);
  const before = requiredKinds(listing.requiredAttestations);
  const wasRegulated = regulatedOnly(listing);
  const tightens = (input.regulated && !wasRegulated) || kinds.some((kind) => !before.includes(kind));
  if (input.regulated && !wasRegulated && !offersRegulatedSwitch(actor, listing.seller)) return { error: "Only an institutional seller or the desk can limit a sale to banks and credit unions." } as const;
  if (tightens && (await bidsIn(listing.id))) return { error: "Bids are in, so these can only be loosened now. Write the desk if the sale needs a new rule." } as const;
  const unchanged = input.regulated === wasRegulated && kinds.join() === before.join();
  if (unchanged) return { error: null, unchanged: true, regulated: wasRegulated, kinds } as const;
  await prisma.listing.update({ where: { id: listing.id }, data: { buyerLimit: input.regulated ? REGULATED : null, requiredAttestations: kinds } });
  await audit(actor.id, "BIDDER_LIMITS", "listing", listing.id, `${input.regulated ? "Banks and credit unions only" : "Any approved buyer"} · ${kinds.length ? kinds.join(", ") : "no statements"}`);
  // Matches follow the limit at once: buyers it now leaves out lose their match, and loosening brings them back.
  if (input.regulated !== wasRegulated) {
    const { rescoreListing } = await import("@/lib/matching");
    await rescoreListing(listing.id, false);
  }
  return { error: null, unchanged: false, regulated: input.regulated, kinds } as const;
}

// The listing's line for buyers and its own side: who may bid, and what each bidder needs on file.
export function bidderLimitLines(listing: { buyerLimit?: string | null; requiredAttestations?: string[] | null }) {
  const kinds = requiredKinds(listing.requiredAttestations);
  return {
    regulated: regulatedOnly(listing),
    needs: kinds.length ? `Each bidder needs a current ${kindList(kinds)} on file for the entity they bid through.` : null,
  };
}
