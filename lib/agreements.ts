import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

// The standing agreements a member signs once: the master purchase agreement for buyers and the master sale
// agreement for sellers. Each sale's purchase agreement incorporates them by reference when every party has
// accepted the current version, and lib/closing-packet.ts writes that paragraph. The texts live here, newest version
// last, so a member can still read the version they accepted before. A new version is a new entry at the end of the
// list, and every member is asked to accept it.
export const MASTER_KINDS = ["MASTER_PURCHASE", "MASTER_SALE"] as const;
export type MasterKind = (typeof MASTER_KINDS)[number];

export const MASTER_LABELS: Record<MasterKind, string> = {
  MASTER_PURCHASE: "Master purchase agreement",
  MASTER_SALE: "Master sale agreement",
};

// The periods the remedy and the fee tail use, shared with the purchase agreement's articles in lib/closing-docs.ts.
export const REPURCHASE_DAYS = 180;
export const CURE_DAYS = 30;
export const FEE_TAIL_MONTHS = 12;

export const MASTER_DRAFT_NOTE =
  "> Desk draft pending counsel review. This text is not final, and it may change before UPB Capital opens to the public. Figures in square brackets are placeholders for counsel.";

export type MasterText = { version: string; effective: string; title: string; body: string };

const ROLE_NOTE = (other: string) =>
  `Each sale also has its own purchase and sale agreement, "the sale agreement". It names the ${other}, the loans, the price, the deposit and the dates. When the buyer and the seller have both accepted the current versions of their master agreements, the sale agreement incorporates both by reference, so the two sides are bound to each other on these terms. Until then, the sale agreement's own articles govern that sale. [Counsel to confirm that incorporation binds buyer and seller to each other without UPB as a party to the sale.]`;

const GOVERNS =
  "The sale agreement sets the price, the loans, the deposit amount and the dates. This agreement governs everything else, and wins if the two conflict on anything else. The terms of use at /terms govern your use of the desk.";

const REPURCHASE_PRICE = [
  "- the price paid for that loan;",
  "- plus the buyer's documented, reasonable costs of buying it and of using this remedy, such as recording, custody and servicing transfer fees, and UPB's buyer premium on that loan;",
  "- less any principal the buyer collected on the loan after the closing. [Counsel to confirm the treatment of interest collected and advances made.]",
].join("\n");

const REPURCHASE_STEPS = `On repurchase, the buyer endorses the note back without recourse, assigns the mortgage back, returns the collateral file and moves servicing back. For a pool, a loan's price is its price on the sale agreement's loan schedule, or its share of the pool price in proportion to unpaid principal when the schedule gives none.`;

const PRORATION = [
  "## Price when the balance moves",
  "The price is set from the unpaid principal balance on the tape as of its cut-off date. If the balance at closing differs, because the borrower paid or for any other reason, the price moves in the same proportion: the tape price times the closing balance, divided by the tape balance. The settlement statement shows the adjusted price before any money moves.",
  "Interest for the days before the closing date belongs to the seller, and for the closing date and after to the buyer. Escrow, suspense and advance balances move with the loan, and the settlement statement credits each to the side that funded it. [Counsel to confirm the proration of interest and escrow.]",
];

const DEPOSIT_CASES = [
  "- the seller fails to close, or breaches the sale agreement;",
  "- the sale ends with neither side at fault, such as a loan paying off, a court order, or the desk ending the sale; or",
  "- the buyer walks away, for any reason, inside the diligence window the sale agreement gives.",
].join("\n");

const DEPOSIT_RELEASE = "The desk records which case applies on the closing, and a second desk member approves a refund or a forfeit before the money moves.";

const SIGNATURES = [
  "## Electronic signatures and records",
  "You agree to sign and receive this agreement, each sale agreement and every notice under them electronically, under the federal E-SIGN Act and the state laws based on the Uniform Electronic Transactions Act. Typing your name with the agreement box ticked is your signature, and it binds you as ink would.",
  "UPB keeps the record of each acceptance: the version, the signer's name and title, the entity, the time, the network address and the device. A copy of that record is evidence of the agreement. Original notes, allonges and recordable assignments are still signed and delivered on paper, or as the recording office requires.",
  "## Notices",
  "Notices under this agreement go on the sale's closing thread on UPB, or to the email on your account, and take effect when sent.",
];

const ENDING = [
  "## New versions and ending",
  "UPB may publish a new version of this agreement. It applies only to sale agreements made after you accept it. Until every party to a sale has accepted the current versions, that sale agreement's own articles govern it.",
  "Either side may end this agreement by writing the other. A sale already awarded closes under the terms that applied to it. The repurchase remedy, the fee tail and confidentiality continue after it ends, and after your account closes.",
  "## Governing law",
  "This agreement, and each sale under it, is governed by the laws of [State], set by counsel, without regard to its conflict-of-law rules. The law of the state where the collateral sits governs the recording and enforcement of each mortgage. [Counsel to decide on arbitration and venue.]",
];

const PURCHASE_V1: MasterText = {
  version: "1",
  effective: "2026-11-08",
  title: "Master purchase agreement",
  body: [
    MASTER_DRAFT_NOTE,
    "## What this agreement is",
    "This master purchase agreement sets the standing terms for every mortgage loan you buy on UPB Capital. \"UPB\" and \"the desk\" mean UPB Capital. \"The buyer\" and \"you\" mean the member who accepts it and every buying entity the member bids through on UPB. You accept it once, and it covers each purchase until a new version replaces it.",
    ROLE_NOTE("seller"),
    "## Which document governs",
    GOVERNS,
    "## As-is sale",
    "Each loan is sold as is, where is, and with all faults. The only promises about a loan are the seller's warranty and representations in its master sale agreement, which you may rely on.",
    "You buy on your own diligence of the tape, the data room and the collateral. UPB's reviews, price ranges, value estimates, comps and scores are tools, not promises. UPB is not the seller, and makes no promise about any loan.",
    "## What the seller warrants",
    "For each loan, the seller warrants as of the closing date that:",
    [
      "- it owns the note and the mortgage and may sell them, free of any other interest except what it disclosed and releases at closing;",
      "- the chain of title from the original lender to the seller is complete, through endorsements or allonges and recorded assignments, or the seller completes it at closing, with a lost note affidavit where an original note is lost;",
      "- the mortgage is a lien on the collateral the tape describes, in the lien position the tape states.",
    ].join("\n"),
    "The seller also represents that the tape and the files are true in all material respects as of the tape's cut-off date, and that it disclosed every bankruptcy, foreclosure, modification, forbearance and lawsuit on the loan it knows of. The master sale agreement sets these terms out in full.",
    "## Your representations",
    "You represent, when you accept this agreement and again at each closing, that:",
    [
      "- you are who your buyer file says, and the signer may bind you and each buying entity;",
      "- your buyer file is true and current, including the accredited-investor certification and proof of funds;",
      "- the money you pay is yours or your entity's, from lawful sources;",
      "- neither you nor anyone you act for is on a sanctions list;",
      "- you, or your servicer, hold any license a state requires to own or collect the loans you buy [Counsel to confirm the licensing wording by state];",
      "- you are experienced in buying mortgage loans, made your own decision with your own advisers, and do not rely on anything outside the papers.",
    ].join("\n"),
    "## The repurchase remedy",
    `If you find a breach of the seller's warranty or representations that materially and adversely affects a loan's value or your interest in it, write the seller through the desk within [${REPURCHASE_DAYS}] days after the closing date. Say what the breach is and include what shows it.`,
    `The seller then has [${CURE_DAYS}] days to cure it. If the breach is not cured, the seller repurchases the loan within [15] days after the cure period ends, at the repurchase price:`,
    REPURCHASE_PRICE,
    REPURCHASE_STEPS,
    `Repurchase is your only remedy for a breach of a representation, except for the seller's fraud. A notice sent after the [${REPURCHASE_DAYS}] days is not a claim under this remedy.`,
    ...PRORATION,
    "## Deposit",
    "You wire the deposit the sale agreement names by its due date, to the account in the closing instructions. It is applied to the price at closing. [Counsel to confirm who holds deposits, and on what terms.]",
    "Your deposit is refunded in full when:",
    DEPOSIT_CASES,
    "Your deposit is forfeited to the seller when you fail to close after the diligence window ends, for a reason that is not the seller's fault. The forfeited deposit is the seller's only remedy for that failure, as liquidated damages, since the seller's real loss would be hard to measure. [Counsel to confirm enforceability by state.]",
    DEPOSIT_RELEASE,
    "## No going around the desk",
    `If UPB introduces you to a note or to its seller, and you buy that note anywhere else within [${FEE_TAIL_MONTHS}] months of the introduction, you owe UPB the fees it would have charged on the desk. This covers the same loan with the same seller, including a trade through a related company or someone acting for you. Until a sale closes, you reach the seller about it through the desk. [Counsel to confirm the term and its enforceability by state.]`,
    "## Confidentiality",
    "Street addresses, borrower information, data-room files, bids and sale terms are confidential. You use them only to evaluate and close a purchase on UPB. You share them only with your counsel, lenders, auditors and servicer working on the purchase, who keep them confidential too.",
    "Until you own a loan, you do not contact the borrower, the occupants or the servicer. When a listing goes to someone else, you destroy its files and say so when the desk asks. These duties continue after a bid ends. UPB may still publish anonymised, aggregate market data under the terms of use.",
    ...SIGNATURES,
    ...ENDING,
  ].join("\n\n"),
};

const SALE_V1: MasterText = {
  version: "1",
  effective: "2026-11-08",
  title: "Master sale agreement",
  body: [
    MASTER_DRAFT_NOTE,
    "## What this agreement is",
    "This master sale agreement sets the standing terms for every mortgage loan you sell on UPB Capital. \"UPB\" and \"the desk\" mean UPB Capital. \"The seller\" and \"you\" mean the member who accepts it and the entity named in the acceptance. You accept it once, and it covers each sale until a new version replaces it.",
    ROLE_NOTE("buyer"),
    "## Which document governs",
    GOVERNS,
    "## As-is sale",
    "You sell each loan as is, where is, and with all faults, except for the warranty and the representations below. They are the only promises you make about a loan. You make no promise that a borrower will pay, or about the collateral's value.",
    "## Your warranty on title and collateral",
    "For each loan you sell, you warrant as of the closing date that:",
    [
      "- you are the sole owner and holder of the note and the mortgage, and may sell them;",
      "- no one else holds a lien, pledge, participation or other interest in them, except what you disclosed and release at closing;",
      "- the chain of title is complete: every endorsement or allonge on the note, and every recorded assignment of the mortgage, runs from the original lender to you, or you deliver what is missing at closing;",
      "- where an original note is lost, you give the desk's lost note affidavit, with its indemnity;",
      "- the mortgage is a valid lien on the collateral the tape describes, in the lien position the tape states;",
      "- you have not released, satisfied, subordinated or modified the loan, except as the file shows.",
    ].join("\n"),
    "## Your representations",
    "You represent, when you accept this agreement and again at each closing, that:",
    [
      "- you are who your seller file says, and the signer may bind you;",
      "- the tape and the files are true and complete in all material respects as of the tape's cut-off date, including the balance, rate, payment history, next due date and status;",
      "- you disclosed every bankruptcy, foreclosure, modification, forbearance, loss mitigation request, lawsuit and borrower complaint on the loan you know of;",
      "- while you owned the loan, you and your servicer serviced it in material compliance with the law that applies, and to your knowledge it was originated in compliance too [Counsel to confirm the scope];",
      "- neither you nor anyone you act for is on a sanctions list;",
      "- nothing you gave the desk or a buyer about a loan is false, or leaves out something that makes it misleading.",
    ].join("\n"),
    "## The repurchase remedy",
    `If the buyer finds a breach of your warranty or representations that materially and adversely affects a loan's value or the buyer's interest in it, and writes you through the desk within [${REPURCHASE_DAYS}] days after the closing date, you have [${CURE_DAYS}] days to cure it.`,
    "If you do not cure it, you repurchase the loan within [15] days after the cure period ends, at the repurchase price:",
    REPURCHASE_PRICE,
    REPURCHASE_STEPS,
    `Repurchase is the buyer's only remedy for a breach of a representation, except for your fraud. A notice sent after the [${REPURCHASE_DAYS}] days is not a claim under this remedy.`,
    ...PRORATION,
    "## Deposit",
    "The buyer wires the deposit the sale agreement names by its due date, to the account in the closing instructions, and it is applied to the price at closing. [Counsel to confirm who holds deposits, and on what terms.]",
    "The buyer's deposit is refunded in full when:",
    DEPOSIT_CASES,
    "The deposit is forfeited to you when the buyer fails to close after the diligence window ends, for a reason that is not your fault. It is your only remedy for that failure, as liquidated damages, since your real loss would be hard to measure. [Counsel to confirm enforceability by state.]",
    "When you fail to close, the buyer's deposit is refunded, and the buyer keeps its other remedies under the sale agreement. [Counsel to confirm the buyer's remedies for a seller's failure.]",
    DEPOSIT_RELEASE,
    "## What you deliver at closing",
    "For each loan, within [5] business days after the buyer's funds arrive:",
    [
      "- the original note, endorsed to the buyer or with an allonge, or the lost note affidavit;",
      "- an assignment of the mortgage in recordable form;",
      "- the collateral file and the servicing file;",
      "- your servicer's notice of the servicing transfer to the borrower, sent on time.",
    ].join("\n"),
    "[Counsel to confirm the delivery list and its timing.]",
    "## Fees",
    "UPB's commission comes off your proceeds, at the fee schedule at /fees that was in force when the desk approved the listing. A closing keeps the fees it opened with.",
    "## No going around the desk",
    `If UPB introduces you to a buyer, and you sell that buyer the same loan anywhere else within [${FEE_TAIL_MONTHS}] months of the introduction, you owe UPB the fees it would have charged on the desk. This covers a trade through a related company or someone acting for you. Until a sale closes, you reach the buyer about it through the desk. [Counsel to confirm the term and its enforceability by state.]`,
    "## Confidentiality",
    "Bidders' identities, their bids and each sale's terms are confidential. You use them only to run your sales on UPB, and share them only with your counsel, lenders, auditors and servicer working on the sale, who keep them confidential too.",
    "Borrower information stays under the law that protects it, and you share it with buyers only through the data room. These duties continue after a sale ends. UPB may still publish anonymised, aggregate market data under the terms of use.",
    ...SIGNATURES,
    ...ENDING,
  ].join("\n\n"),
};

// Oldest first. The last entry is the version members accept now.
export const MASTER_VERSIONS: Record<MasterKind, MasterText[]> = {
  MASTER_PURCHASE: [PURCHASE_V1],
  MASTER_SALE: [SALE_V1],
};

export function isMasterKind(value: unknown): value is MasterKind {
  return typeof value === "string" && (MASTER_KINDS as readonly string[]).includes(value);
}

export function currentVersion(kind: MasterKind) {
  const versions = MASTER_VERSIONS[kind];
  return versions[versions.length - 1].version;
}

// A version's text, or null for one no longer kept.
export function masterText(kind: MasterKind, version = currentVersion(kind)) {
  return MASTER_VERSIONS[kind].find((text) => text.version === version) ?? null;
}

const SELLER_ROLES = ["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER"];

// Buyers sign the purchase agreement and sellers the sale agreement. A buyer who relists a holding sells too, so
// signs both. The desk and brokers sign neither: UPB is not a party to the sale, and a broker files for a seller.
export async function masterApplies(user: { id: string; role: string }, kind: MasterKind) {
  if (kind === "MASTER_PURCHASE") return user.role === "BUYER";
  if (SELLER_ROLES.includes(user.role)) return true;
  if (user.role !== "BUYER") return false;
  return Boolean(await prisma.listing.findFirst({ where: { sellerId: user.id }, select: { id: true } }));
}

export async function masterKindsFor(user: { id: string; role: string }) {
  const applies = await Promise.all(MASTER_KINDS.map((kind) => masterApplies(user, kind)));
  return MASTER_KINDS.filter((_kind, index) => applies[index]);
}

// The acceptance at the current version, or null when the member hasn't accepted it.
export async function currentAcceptance(userId: string, kind: MasterKind) {
  return prisma.agreementAcceptance.findFirst({ where: { userId, kind, version: currentVersion(kind) }, orderBy: { acceptedAt: "desc" } });
}

export async function acceptanceHistory(userId: string, kind: MasterKind) {
  return prisma.agreementAcceptance.findMany({ where: { userId, kind }, orderBy: { acceptedAt: "desc" } });
}

// What the form starts with: the last acceptance, so a new version is one click, or else the files the desk holds.
export async function masterPrefill(user: { id: string; name: string; companyName?: string | null }, kind: MasterKind) {
  const last = await prisma.agreementAcceptance.findFirst({ where: { userId: user.id, kind }, orderBy: { acceptedAt: "desc" } });
  if (last) return { signerName: last.signerName, signerTitle: last.signerTitle, entityName: last.entityName };
  const company = user.companyName?.trim() || "";
  const seller = await prisma.sellerProfile.findUnique({ where: { userId: user.id }, select: { signerName: true, signerTitle: true, entityName: true } });
  if (kind === "MASTER_SALE") {
    return { signerName: seller?.signerName.trim() || user.name, signerTitle: seller?.signerTitle.trim() || "", entityName: seller?.entityName.trim() || company || user.name };
  }
  const [profile, entity] = await Promise.all([
    prisma.buyerProfile.findUnique({ where: { userId: user.id }, select: { entityName: true } }),
    prisma.buyerEntity.findFirst({ where: { userId: user.id, status: "APPROVED" }, orderBy: { createdAt: "asc" }, select: { name: true } }),
  ]);
  return { signerName: user.name, signerTitle: seller?.signerTitle.trim() || "", entityName: profile?.entityName.trim() || entity?.name.trim() || company || user.name };
}

function field(value: unknown, max: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export function masterLabel(kind: MasterKind) {
  return MASTER_LABELS[kind].toLowerCase();
}

// Signing records who signed, for which entity, at which version, and the request it came from. Signing the
// version already accepted changes nothing.
export async function acceptMaster(
  user: { id: string; role: string },
  input: { kind: unknown; signerName: unknown; signerTitle?: unknown; entityName?: unknown; agreed: unknown; ip: string; userAgent: string },
  now = new Date(),
) {
  if (!isMasterKind(input.kind)) return { error: "Choose an agreement to sign." } as const;
  const kind = input.kind;
  if (!(await masterApplies(user, kind))) return { error: `Your account doesn't sign the ${masterLabel(kind)}.` } as const;
  if (input.agreed !== "yes") return { error: "Tick the box to sign." } as const;
  const signerName = field(input.signerName, 120);
  if (signerName.length < 2) return { error: "Type the name you are signing with." } as const;
  const signerTitle = field(input.signerTitle, 120);
  // An individual signs for themselves.
  const entityName = field(input.entityName, 160) || signerName;
  const existing = await currentAcceptance(user.id, kind);
  if (existing) return { error: null, kind, acceptance: existing, already: true } as const;
  const version = currentVersion(kind);
  const acceptance = await prisma.agreementAcceptance.create({
    data: { userId: user.id, kind, version, signerName, signerTitle, entityName, ip: input.ip.slice(0, 100), userAgent: input.userAgent.slice(0, 300), acceptedAt: now },
  });
  await audit(user.id, "MASTER_ACCEPTED", "agreement", acceptance.id, `Accepted the ${masterLabel(kind)}, version ${version}, as ${signerName}${signerTitle ? `, ${signerTitle}` : ""}, for ${entityName}.`);
  return { error: null, kind, acceptance, already: false } as const;
}

// Where the accept page may send someone back to: their own desk pages, never a link someone else wrote.
export function agreementBack(value: unknown) {
  return typeof value === "string" && /^\/(?:closings\/[A-Za-z0-9_-]{1,40}|buyer\/offers|seller)$/.test(value) ? value : null;
}

// ---------------------------------------------------------------------------------------------------------------
// A closing's parties and the masters they accepted, for the purchase agreement and the closing page.

type Acceptance = { version: string; signerName: string; signerTitle: string; entityName: string; acceptedAt: Date };

export type MasterParty = {
  side: "SELLER" | "BUYER";
  userId: string;
  name: string;
  // How the purchase agreement names this party: "the seller", "the buyer", or a group seat's entity.
  label: string;
  kind: MasterKind;
  version: string;
  acceptance: Acceptance | null;
};

export type MasterStatus = { parties: MasterParty[]; complete: boolean; deskPurchase: boolean };

// The seller signs the sale agreement. The buyer signs the purchase agreement, or every seat does for a group. The
// desk buying for its own book signs nothing, so only the seller's counts then.
export async function masterStatus(input: {
  seller: { userId: string; name: string };
  buyers: { userId: string; name: string }[];
  deskPurchase: boolean;
}): Promise<MasterStatus> {
  const group = input.buyers.length > 1;
  const wanted = [
    { side: "SELLER" as const, ...input.seller, label: "the seller", kind: "MASTER_SALE" as const },
    ...(input.deskPurchase ? [] : input.buyers.map((buyer) => ({ side: "BUYER" as const, ...buyer, label: group ? buyer.name : "the buyer", kind: "MASTER_PURCHASE" as const }))),
  ];
  const rows = await prisma.agreementAcceptance.findMany({
    where: { userId: { in: [...new Set(wanted.map((party) => party.userId))] }, kind: { in: [...MASTER_KINDS] } },
    orderBy: { acceptedAt: "desc" },
  });
  const parties = wanted.map((party) => {
    const version = currentVersion(party.kind);
    const row = rows.find((acceptance) => acceptance.userId === party.userId && acceptance.kind === party.kind && acceptance.version === version);
    return { ...party, version, acceptance: row ? { version: row.version, signerName: row.signerName, signerTitle: row.signerTitle, entityName: row.entityName, acceptedAt: row.acceptedAt } : null };
  });
  const buyerSide = input.deskPurchase || parties.some((party) => party.side === "BUYER");
  return { parties, complete: buyerSide && parties.every((party) => party.acceptance), deskPurchase: input.deskPurchase };
}

export async function closingMasterStatus(closingId: string) {
  const closing = await prisma.closing.findUnique({
    where: { id: closingId },
    select: {
      deskBidId: true,
      inquiryId: true,
      listing: { select: { seller: { select: { id: true, name: true, companyName: true } } } },
      funders: { select: { userId: true, entityName: true, user: { select: { name: true, companyName: true } } }, orderBy: { percent: "desc" } },
    },
  });
  if (!closing) return null;
  const inquiry = closing.inquiryId ? await prisma.inquiry.findUnique({ where: { id: closing.inquiryId }, select: { buyer: { select: { id: true, name: true, companyName: true } } } }) : null;
  const seller = closing.listing.seller;
  const buyers = closing.funders.length
    ? closing.funders.map((funder) => ({ userId: funder.userId, name: funder.entityName || funder.user.companyName || funder.user.name }))
    : inquiry ? [{ userId: inquiry.buyer.id, name: inquiry.buyer.companyName || inquiry.buyer.name }] : [];
  return masterStatus({ seller: { userId: seller.id, name: seller.companyName || seller.name }, buyers, deskPurchase: Boolean(closing.deskBidId) });
}

const day = (value: Date) => value.toISOString().slice(0, 10);

function possessive(label: string) {
  return label.endsWith("s") ? `${label}'` : `${label}'s`;
}

// The purchase agreement's paragraph on the masters: incorporated, with versions and dates, when every party has
// accepted the current version, and otherwise a plain statement that the agreement's own articles govern.
export function masterTermsText(status: MasterStatus) {
  if (status.complete) {
    const list = status.parties
      .map((party) => {
        const accepted = party.acceptance!;
        return `${possessive(party.label)} ${masterLabel(party.kind)}, version ${accepted.version}, accepted on ${day(accepted.acceptedAt)} by ${accepted.signerName}${accepted.signerTitle ? `, ${accepted.signerTitle}` : ""}, for ${accepted.entityName}`;
      })
      .join("; ");
    return [
      `This sale is made under the master agreements its parties accepted on UPB Capital, which are incorporated into this agreement by reference: ${list}.`,
      status.deskPurchase ? "UPB Capital buys for its own book, and the buyer's terms are the articles above." : "",
      "The articles above summarise them. Where they differ, the master agreements govern, except for the price, the loans, the deposit and the dates, which this agreement sets.",
    ].filter(Boolean).join(" ");
  }
  const missing = status.parties
    .filter((party) => !party.acceptance)
    .map((party) => `${party.label} has not accepted version ${party.version} of the ${masterLabel(party.kind)}`);
  if (!status.deskPurchase && !status.parties.some((party) => party.side === "BUYER")) missing.push("no buyer is named");
  return `No master agreement is incorporated, because not every party has accepted the current version on UPB Capital: ${missing.join("; ")}. The articles above govern this sale on their own.`;
}

// One line for each side, for forms that name the masters without the whole paragraph.
export function masterLines(status: MasterStatus) {
  const line = (parties: MasterParty[], kind: MasterKind) => {
    const version = currentVersion(kind);
    if (!parties.length) return `${MASTER_LABELS[kind]} version ${version}, not accepted`;
    if (parties.every((party) => party.acceptance)) {
      return parties.length > 1
        ? `${MASTER_LABELS[kind]} version ${version}, accepted by every seat`
        : `${MASTER_LABELS[kind]} version ${version}, accepted ${day(parties[0].acceptance!.acceptedAt)}`;
    }
    return `${MASTER_LABELS[kind]} version ${version}, not accepted${parties.length > 1 ? " by every seat" : ""}`;
  };
  return {
    sellerMaster: line(status.parties.filter((party) => party.side === "SELLER"), "MASTER_SALE"),
    buyerMaster: status.deskPurchase ? "UPB Capital buys for its own book" : line(status.parties.filter((party) => party.side === "BUYER"), "MASTER_PURCHASE"),
  };
}
