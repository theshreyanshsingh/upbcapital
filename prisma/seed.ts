import bcrypt from "bcryptjs";
import fs from "fs/promises";
import path from "path";
import {
  PrismaClient,
  type ForeclosureStatus,
  type LienPosition,
  type Occupancy,
  type PaymentStatus,
  type PropertyType,
} from "@prisma/client";
import { assessBrokerFees } from "../lib/broker-fees";
import { assertDemoSeedAllowed, assertMongoUrl } from "../lib/deploy";
import { syncIndexes } from "../lib/mongo-indexes";
import { feeBreakdown } from "../lib/money";
import { buildNdaPdf } from "../lib/nda-pdf";
import { ACCREDITATION_TEXT } from "../lib/verification";
import { CLOSING_STEPS } from "../lib/closing";

const prisma = new PrismaClient();

function daysAgo(days: number) {
  return new Date(Date.now() - days * 86400000);
}

function daysAhead(days: number) {
  return new Date(Date.now() + days * 86400000);
}

function payment(upb: number, rate: number) {
  const monthlyRate = rate / 100 / 12;
  return Math.round((upb * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -360)));
}

type Loan = {
  street: string;
  city: string;
  state: string;
  zip: string;
  propertyType?: PropertyType;
  lien?: LienPosition;
  upb: number;
  rate?: number;
  pi?: number;
  status?: PaymentStatus;
  delinquent?: number;
  value: number;
  ask: number;
  occupancy?: Occupancy;
  foreclosure?: ForeclosureStatus;
  borrower?: string;
  memo?: string;
  lastPaid?: string;
  originated?: string;
  maturity?: string;
};

function loan(input: Loan) {
  const rate = input.rate ?? 6.5;
  return {
    streetAddress: input.street,
    city: input.city,
    state: input.state,
    zip: input.zip,
    propertyType: input.propertyType ?? "SFR",
    lienPosition: input.lien ?? "FIRST",
    upb: input.upb,
    interestRate: rate,
    monthlyPi: input.pi ?? payment(input.upb, rate),
    paymentStatus: input.status ?? "PERFORMING",
    monthsDelinquent: input.delinquent ?? (input.status === "NON_PERFORMING" ? 9 : input.status === "SUB_PERFORMING" ? 2 : 0),
    lastPaidDate: new Date(input.lastPaid ?? (input.status === "PERFORMING" ? "2026-09-01" : "2025-08-01")),
    originationDate: new Date(input.originated ?? "2019-06-15"),
    maturityDate: new Date(input.maturity ?? "2049-06-15"),
    estimatedValue: input.value,
    askingPrice: input.ask,
    occupancy: input.occupancy ?? "OWNER_OCCUPIED",
    foreclosureStatus: input.foreclosure ?? "NONE",
    borrowerName: input.borrower ?? "FICTIONAL BORROWER",
    memo: input.memo ?? "Fictional sample loan for the UPB Capital demo.",
  };
}

async function main() {
  assertDemoSeedAllowed();
  // The seed starts by dropping the database, so it must be UPB's own.
  assertMongoUrl(process.env.DATABASE_URL);
  await prisma.$runCommandRaw({ dropDatabase: 1 });
  await syncIndexes(prisma);

  const storage = path.join(process.cwd(), "storage");
  await fs.rm(storage, { recursive: true, force: true });
  await fs.mkdir(path.join(storage, "uploads"), { recursive: true });

  await prisma.platformSettings.create({
    data: {
      id: "default",
      buyerPremiumBps: 250,
      sellerCommissionBps: 300,
      proMonthlyPriceCents: 24900,
      earlyAccessHours: 48,
      freeBrowseLimit: 4,
      wireInstructions: "Fictional receiving bank\nUPB Capital Desk Escrow\nAccount 0001847001\nReference the closing id on the wire.",
    },
  });

  const passwordHash = await bcrypt.hash("Desk1847!", 10);
  const [iris, maya, harbor, jordan, camille, avery, southshore] = await Promise.all([
    prisma.user.create({
      data: { email: "iris@upbcapital.test", name: "Iris Calder", role: "ADMIN", accountStatus: "APPROVED", passwordHash, phone: "(305) 555-0100" },
    }),
    prisma.user.create({
      data: { email: "maya.ellison@upbcapital.test", name: "Maya Ellison", role: "INDIVIDUAL_SELLER", accountStatus: "APPROVED", passwordHash, phone: "(305) 555-0148" },
    }),
    prisma.user.create({
      data: { email: "desk@harborline.test", name: "Harborline Desk", role: "INSTITUTIONAL_SELLER", accountStatus: "APPROVED", passwordHash, companyName: "Harborline Credit Partners", companyType: "FUND", phone: "(305) 555-0172" },
    }),
    prisma.user.create({
      data: { email: "jordan.hale@upbcapital.test", name: "Jordan Hale", role: "BUYER", accountStatus: "APPROVED", passwordHash, subscriptionTier: "FREE" },
    }),
    prisma.user.create({
      data: {
        email: "camille.ortiz@upbcapital.test",
        name: "Camille Ortiz",
        role: "BUYER",
        accountStatus: "APPROVED",
        passwordHash,
        subscriptionTier: "PRO",
        subscriptionStatus: "ACTIVE",
        subscriptionCurrentPeriodEnd: daysAhead(20),
      },
    }),
    prisma.user.create({
      data: { email: "avery.chen@upbcapital.test", name: "Avery Chen", role: "BUYER", accountStatus: "PENDING", passwordHash },
    }),
    prisma.user.create({
      data: { email: "credit@southshore.test", name: "Southshore Credit", role: "INSTITUTIONAL_SELLER", accountStatus: "PENDING", passwordHash, companyName: "Southshore Community Bank", companyType: "BANK" },
    }),
  ]);

  async function single(opts: {
    sellerId: string;
    title: string;
    summary: string;
    status: "SUBMITTED" | "UNDER_REVIEW" | "APPROVED" | "REJECTED" | "CHANGES_REQUESTED" | "PENDING" | "SOLD";
    approvedDaysAgo?: number | null;
    soldDaysAgo?: number;
    salePrice?: number;
    loan: Loan;
  }) {
    const fees = opts.salePrice ? feeBreakdown(opts.salePrice, 250, 300) : null;
    return prisma.listing.create({
      data: {
        kind: "SINGLE",
        sellerId: opts.sellerId,
        status: opts.status,
        title: opts.title,
        summary: opts.summary,
        approvedAt: opts.approvedDaysAgo == null ? null : daysAgo(opts.approvedDaysAgo),
        soldAt: opts.soldDaysAgo != null ? daysAgo(opts.soldDaysAgo) : null,
        salePrice: opts.salePrice,
        buyerPremiumCents: fees?.premiumCents,
        sellerCommissionCents: fees?.commissionCents,
        buyerTotalCents: fees?.buyerTotalCents,
        netToSellerCents: fees?.netToSellerCents,
        notes: { create: loan(opts.loan) },
        reviews: opts.status === "CHANGES_REQUESTED"
          ? { create: { authorId: iris.id, action: "REQUEST_CHANGES", comment: "Please attach a BPO and confirm the months delinquent. The pay history in the file is blank." } }
          : undefined,
      },
    });
  }

  const coral = await single({
    sellerId: maya.id,
    title: "First-lien performing · Coral Gables",
    summary: "Owner-occupied single family. Current, seasoned, and priced inside a wide equity cushion. Fictional file.",
    status: "APPROVED",
    approvedDaysAgo: 10,
    loan: { street: "418 SAMPLE Candela Avenue", city: "Coral Gables", state: "FL", zip: "33134", upb: 312400, rate: 5.875, value: 640000, ask: 224900, borrower: "FICTIONAL BORROWER A" },
  });
  const fort = await single({
    sellerId: maya.id,
    title: "Second-lien NPL · Fort Lauderdale",
    summary: "Vacant collateral, lis pendens on the second. First appears current from the seller's notes. Fictional file.",
    status: "APPROVED",
    approvedDaysAgo: 9,
    loan: { street: "77 SAMPLE Las Olas Circle", city: "Fort Lauderdale", state: "FL", zip: "33301", lien: "SECOND", upb: 96500, rate: 9.5, value: 575000, ask: 31000, status: "NON_PERFORMING", delinquent: 16, occupancy: "VACANT", foreclosure: "LIS_PENDENS", borrower: "FICTIONAL BORROWER B" },
  });
  const tampa = await single({
    sellerId: maya.id,
    title: "First-lien sub-performing · Tampa",
    summary: "Tenant-occupied condo, two months behind, borrower still answering the servicer. Fictional file.",
    status: "APPROVED",
    approvedDaysAgo: 8,
    loan: { street: "1502 SAMPLE Harbour Island", city: "Tampa", state: "FL", zip: "33602", propertyType: "CONDO", upb: 186200, rate: 7.125, value: 265000, ask: 142000, status: "SUB_PERFORMING", delinquent: 2, occupancy: "TENANT", borrower: "FICTIONAL BORROWER C" },
  });
  const orlando = await single({
    sellerId: maya.id,
    title: "First-lien performing · Orlando",
    summary: "In contract. Offer accepted and a closing checklist is open. Fictional file.",
    status: "PENDING",
    approvedDaysAgo: 7,
    loan: { street: "880 SAMPLE Lake Ivanhoe", city: "Orlando", state: "FL", zip: "32804", upb: 241000, rate: 6.25, value: 390000, ask: 175000, borrower: "FICTIONAL BORROWER D" },
  });
  await single({
    sellerId: maya.id,
    title: "First-lien performing · Sarasota",
    summary: "Seasoned waterfront-adjacent SFR. Fictional file, included so the free desk can show its browse limit.",
    status: "APPROVED",
    approvedDaysAgo: 6,
    loan: { street: "22 SAMPLE Osprey Avenue", city: "Sarasota", state: "FL", zip: "34236", upb: 402000, rate: 6.0, value: 810000, ask: 289000, borrower: "FICTIONAL BORROWER E" },
  });
  await single({
    sellerId: maya.id,
    title: "First-lien performing · Miami Beach",
    summary: "Just approved. Free members see it after the early-access window. Fictional file.",
    status: "APPROVED",
    approvedDaysAgo: 0,
    loan: { street: "901 SAMPLE Collins Walk", city: "Miami Beach", state: "FL", zip: "33139", propertyType: "CONDO", upb: 510000, rate: 6.75, value: 890000, ask: 365000, occupancy: "TENANT", borrower: "FICTIONAL BORROWER F" },
  });
  await single({
    sellerId: maya.id,
    title: "First-lien performing · Key West",
    summary: "Fresh submission. Waiting on the desk. Fictional file.",
    status: "SUBMITTED",
    loan: { street: "14 SAMPLE Duval Court", city: "Key West", state: "FL", zip: "33040", upb: 288000, rate: 6.4, value: 720000, ask: 210000, borrower: "FICTIONAL BORROWER G" },
  });
  await single({
    sellerId: maya.id,
    title: "First-lien commercial · Jacksonville",
    summary: "Small retail condo. In review. Fictional file.",
    status: "UNDER_REVIEW",
    loan: { street: "400 SAMPLE Bay Street", city: "Jacksonville", state: "FL", zip: "32202", propertyType: "COMMERCIAL", upb: 640000, rate: 7.5, value: 980000, ask: 470000, occupancy: "TENANT", borrower: "FICTIONAL BORROWER H" },
  });
  await single({
    sellerId: maya.id,
    title: "First-lien NPL land · Cape Coral",
    summary: "Vacant lot, non-performing. The desk asked for a better value opinion. Fictional file.",
    status: "CHANGES_REQUESTED",
    loan: { street: "0 SAMPLE Southwest 12th Terrace", city: "Cape Coral", state: "FL", zip: "33991", propertyType: "LAND", upb: 74000, rate: 8, value: 110000, ask: 29000, status: "NON_PERFORMING", delinquent: 22, occupancy: "VACANT", foreclosure: "PRE_FORECLOSURE", borrower: "FICTIONAL BORROWER I" },
  });
  await single({
    sellerId: maya.id,
    title: "Second-lien · Ocala",
    summary: "Declined: value support was a printout with no date. Fictional file.",
    status: "REJECTED",
    loan: { street: "6 SAMPLE Silver Springs", city: "Ocala", state: "FL", zip: "34470", lien: "SECOND", upb: 42000, rate: 10, value: 180000, ask: 9000, status: "NON_PERFORMING", delinquent: 30, borrower: "FICTIONAL BORROWER J" },
  });

  async function sold(title: string, city: string, salePrice: number, days: number, loanInput: Loan) {
    const listing = await single({
      sellerId: maya.id,
      title,
      summary: "Closed on the desk. Fictional trade, included so the revenue ledger has a history.",
      status: "SOLD",
      approvedDaysAgo: days + 12,
      soldDaysAgo: days,
      salePrice,
      loan: loanInput,
    });
    const fees = feeBreakdown(salePrice, 250, 300);
    await prisma.revenueEvent.createMany({
      data: [
        { type: "BUYER_PREMIUM", amountCents: fees.premiumCents, listingId: listing.id, description: `Buyer premium on ${title}`, occurredAt: daysAgo(days) },
        { type: "SELLER_COMMISSION", amountCents: fees.commissionCents, listingId: listing.id, description: `Seller commission on ${title}`, occurredAt: daysAgo(days) },
      ],
    });
  }

  await sold("First-lien performing · West Palm Beach", "West Palm Beach", 162000, 35, {
    street: "310 SAMPLE Clematis", city: "West Palm Beach", state: "FL", zip: "33401", upb: 228000, value: 455000, ask: 168000, borrower: "FICTIONAL BORROWER K",
  });
  await sold("First-lien performing · Savannah", "Savannah", 210000, 70, {
    street: "18 SAMPLE Jones Street", city: "Savannah", state: "GA", zip: "31401", upb: 276000, value: 490000, ask: 214000, borrower: "FICTIONAL BORROWER L",
  });
  await sold("First-lien performing · Naples", "Naples", 98000, 12, {
    street: "5 SAMPLE Gulf Shore", city: "Naples", state: "FL", zip: "34102", lien: "SECOND", upb: 121000, value: 860000, ask: 104000, borrower: "FICTIONAL BORROWER M",
  });

  const poolLoans: Loan[] = [
    { street: "901 SAMPLE Banyan Street", city: "Miami", state: "FL", zip: "33130", upb: 428000, value: 710000, ask: 312000, borrower: "FICTIONAL BORROWER 01" },
    { street: "14 SAMPLE Palm Avenue", city: "Hialeah", state: "FL", zip: "33010", propertyType: "CONDO", lien: "SECOND", upb: 72000, rate: 9.25, value: 260000, ask: 24000, status: "NON_PERFORMING", delinquent: 14, occupancy: "VACANT", foreclosure: "NOTICE_OF_DEFAULT", borrower: "FICTIONAL BORROWER 02" },
    { street: "88 SAMPLE Tyler Street", city: "Hollywood", state: "FL", zip: "33020", propertyType: "TOWNHOUSE", upb: 214000, rate: 6.875, value: 340000, ask: 158000, status: "SUB_PERFORMING", delinquent: 1, occupancy: "TENANT", borrower: "FICTIONAL BORROWER 03" },
    { street: "640 SAMPLE Royal Palm Way", city: "Boca Raton", state: "FL", zip: "33432", upb: 536000, rate: 5.75, value: 980000, ask: 398000, borrower: "FICTIONAL BORROWER 04" },
    { street: "220 SAMPLE Pines Boulevard", city: "Pembroke Pines", state: "FL", zip: "33024", upb: 301000, value: 465000, ask: 226000, borrower: "FICTIONAL BORROWER 05" },
    { street: "0 SAMPLE Allapattah Road", city: "Homestead", state: "FL", zip: "33030", propertyType: "LAND", upb: 88000, rate: 8.5, value: 140000, ask: 36000, status: "NON_PERFORMING", delinquent: 18, occupancy: "VACANT", foreclosure: "PRE_FORECLOSURE", borrower: "FICTIONAL BORROWER 06" },
    { street: "19 SAMPLE Bull Street", city: "Savannah", state: "GA", zip: "31401", upb: 255000, value: 410000, ask: 189000, borrower: "FICTIONAL BORROWER 07" },
    { street: "702 SAMPLE Broad Street", city: "Augusta", state: "GA", zip: "30901", upb: 143000, rate: 7.25, value: 210000, ask: 101000, status: "SUB_PERFORMING", delinquent: 3, borrower: "FICTIONAL BORROWER 08" },
    { street: "55 SAMPLE Peachtree Place", city: "Atlanta", state: "GA", zip: "30308", propertyType: "CONDO", upb: 198000, rate: 7.5, value: 275000, ask: 79000, status: "NON_PERFORMING", delinquent: 10, occupancy: "VACANT", foreclosure: "LIS_PENDENS", borrower: "FICTIONAL BORROWER 09" },
    { street: "1400 SAMPLE McKinney", city: "Dallas", state: "TX", zip: "75201", upb: 367000, value: 590000, ask: 274000, borrower: "FICTIONAL BORROWER 10" },
    { street: "800 SAMPLE Travis Street", city: "Houston", state: "TX", zip: "77002", propertyType: "COMMERCIAL", upb: 720000, rate: 7.875, value: 1100000, ask: 540000, status: "SUB_PERFORMING", delinquent: 2, occupancy: "TENANT", borrower: "FICTIONAL BORROWER 11" },
    { street: "310 SAMPLE Tryon Street", city: "Charlotte", state: "NC", zip: "28202", propertyType: "TOWNHOUSE", upb: 246000, value: 365000, ask: 184000, borrower: "FICTIONAL BORROWER 12" },
    { street: "90 SAMPLE Hillsborough", city: "Raleigh", state: "NC", zip: "27603", upb: 173000, rate: 6.9, value: 290000, ask: 68000, status: "NON_PERFORMING", delinquent: 12, foreclosure: "PRE_FORECLOSURE", borrower: "FICTIONAL BORROWER 13" },
    { street: "44 SAMPLE Meeting Street", city: "Charleston", state: "SC", zip: "29401", propertyType: "CONDO", upb: 289000, rate: 6.1, value: 470000, ask: 214000, occupancy: "TENANT", borrower: "FICTIONAL BORROWER 14" },
    { street: "1200 SAMPLE 2nd Avenue", city: "Birmingham", state: "AL", zip: "35203", upb: 132000, rate: 7.4, value: 185000, ask: 94000, status: "SUB_PERFORMING", delinquent: 2, borrower: "FICTIONAL BORROWER 15" },
    { street: "600 SAMPLE Broadway", city: "Nashville", state: "TN", zip: "37203", upb: 354000, rate: 6.35, value: 560000, ask: 262000, borrower: "FICTIONAL BORROWER 16" },
  ];

  const pool = await prisma.listing.create({
    data: {
      kind: "POOL",
      sellerId: harbor.id,
      status: "APPROVED",
      approvedAt: daysAgo(5),
      title: "Gulfstream 2024-1",
      summary: "Sixteen fictional loans from a sample Harborline tape. Florida heavy, with a Georgia, Texas, and Carolinas sleeve. Performing, sub-performing, and NPL mixed. Not a real offering.",
      notes: { create: poolLoans.map((item) => loan(item)) },
    },
  });

  await prisma.listing.create({
    data: {
      kind: "POOL",
      sellerId: harbor.id,
      status: "SUBMITTED",
      title: "Palm Intake 2026-A",
      summary: "A short fictional tape waiting on the desk. Four loans, not yet live.",
      notes: {
        create: [
          loan({ street: "1 SAMPLE Atlantic", city: "Delray Beach", state: "FL", zip: "33444", upb: 260000, value: 430000, ask: 190000, borrower: "FICTIONAL BORROWER 21" }),
          loan({ street: "2 SAMPLE Atlantic", city: "Boynton Beach", state: "FL", zip: "33435", upb: 99000, value: 240000, ask: 41000, status: "NON_PERFORMING", lien: "SECOND", borrower: "FICTIONAL BORROWER 22" }),
          loan({ street: "3 SAMPLE Flagler", city: "West Palm Beach", state: "FL", zip: "33401", upb: 188000, value: 310000, ask: 140000, status: "SUB_PERFORMING", borrower: "FICTIONAL BORROWER 23" }),
          loan({ street: "4 SAMPLE Las Olas", city: "Fort Lauderdale", state: "FL", zip: "33301", propertyType: "CONDO", upb: 221000, value: 340000, ask: 166000, borrower: "FICTIONAL BORROWER 24" }),
        ],
      },
    },
  });

  const orlandoOffer = await prisma.inquiry.create({
    data: {
      listingId: orlando.id,
      buyerId: camille.id,
      type: "OFFER",
      amount: 168000,
      status: "ACCEPTED",
      message: "All-in bid, subject to the data room matching the tape. Proof of funds on request. Fictional offer.",
    },
  });
  await prisma.listing.update({ where: { id: orlando.id }, data: { acceptedInquiryId: orlandoOffer.id } });
  const orlandoFees = feeBreakdown(168000, 250, 300);
  await prisma.closing.create({
    data: {
      listingId: orlando.id,
      inquiryId: orlandoOffer.id,
      salePrice: 168000,
      buyerPremiumCents: orlandoFees.premiumCents,
      sellerCommissionCents: orlandoFees.commissionCents,
      buyerTotalCents: orlandoFees.buyerTotalCents,
      netToSellerCents: orlandoFees.netToSellerCents,
      provider: "manual",
      wireInstructions: "Fictional receiving bank\nUPB Capital Desk Escrow\nAccount 0001847001\nReference the Orlando closing.",
      steps: {
        create: CLOSING_STEPS.map((step) => ({
          key: step.key,
          status: step.key === "PURCHASE_AGREEMENT" || step.key === "BUYER_DEPOSIT" ? "COMPLETE" : "PENDING",
          completedAt: step.key === "PURCHASE_AGREEMENT" || step.key === "BUYER_DEPOSIT" ? daysAgo(2) : null,
          note: step.key === "BUYER_DEPOSIT" ? "Fictional deposit noted by the desk." : "",
        })),
      },
    },
  });
  await prisma.offerMessage.create({
    data: { inquiryId: orlandoOffer.id, authorId: camille.id, kind: "OFFER", amount: 168000, body: "All-in bid, subject to the data room matching the tape.", createdAt: daysAgo(4) },
  });
  const tampaOffer = await prisma.inquiry.create({
    data: { listingId: tampa.id, buyerId: jordan.id, type: "OFFER", amount: 136500, message: "Looking at this as a re-performer. Please send the last twelve months. Fictional offer." },
  });
  await prisma.offerMessage.create({
    data: { inquiryId: tampaOffer.id, authorId: jordan.id, kind: "OFFER", amount: 136500, body: "Looking at this as a re-performer.", createdAt: daysAgo(3) },
  });
  await prisma.offerMessage.create({
    data: { inquiryId: tampaOffer.id, authorId: iris.id, kind: "COUNTER", amount: 141000, body: "The desk can work at 141,000, subject to the file.", createdAt: daysAgo(1) },
  });
  const gulfNote = await prisma.note.findFirst({ where: { listingId: pool.id, city: "Miami" } });
  if (gulfNote) {
    const loanBid = await prisma.inquiry.create({
      data: { listingId: pool.id, noteId: gulfNote.id, buyerId: camille.id, type: "OFFER", amount: 300000, message: "Loan-level bid on the Miami first. Fictional." },
    });
    await prisma.offerMessage.create({
      data: { inquiryId: loanBid.id, authorId: camille.id, kind: "OFFER", amount: 300000, body: "Loan-level bid on the Miami first." },
    });
  }
  await prisma.inquiry.create({
    data: { listingId: coral.id, buyerId: camille.id, type: "DATA_ROOM", message: "Requesting the note, mortgage, and BPO." },
  });
  await prisma.inquiry.create({
    data: { listingId: fort.id, buyerId: camille.id, type: "INFO_REQUEST", message: "Is the lis pendens only on the second, or is the first also in default?" },
  });

  await prisma.favorite.createMany({
    data: [
      { userId: camille.id, listingId: coral.id },
      { userId: camille.id, listingId: pool.id },
      { userId: jordan.id, listingId: tampa.id },
    ],
  });
  const signedAt = daysAgo(9);
  const ndaPdf = await buildNdaPdf({
    listingTitle: "First-lien performing · Coral Gables",
    listingId: coral.id,
    signerName: "Camille Ortiz",
    signerEmail: camille.email,
    method: "TYPED",
    signedAt,
    ipAddress: "127.0.0.1",
    userAgent: "UPB Capital seed",
  });
  const ndaKey = `ndas/${camille.id}/${coral.id}.pdf`;
  await fs.mkdir(path.join(storage, "uploads", "ndas", camille.id), { recursive: true });
  await fs.writeFile(path.join(storage, "uploads", ndaKey), ndaPdf);
  const ndaDoc = await prisma.document.create({
    data: { listingId: coral.id, type: "NDA", originalName: "NDA-Camille-Ortiz.pdf", storedName: ndaKey, mime: "application/pdf", size: ndaPdf.length },
  });
  await prisma.ndaAcknowledgment.create({
    data: {
      userId: camille.id,
      listingId: coral.id,
      acknowledgedAt: signedAt,
      signerName: "Camille Ortiz",
      method: "TYPED",
      ipAddress: "127.0.0.1",
      userAgent: "UPB Capital seed",
      pdfKey: ndaKey,
      documentId: ndaDoc.id,
    },
  });

  const proof = "FICTIONAL PROOF OF FUNDS\nOrtiz Capital LLC\nNot a real bank letter.\n";
  await fs.mkdir(path.join(storage, "uploads", "verification"), { recursive: true });
  await fs.writeFile(path.join(storage, "uploads", "verification", "camille-proof.txt"), proof);
  await fs.writeFile(path.join(storage, "uploads", "verification", "jordan-proof.txt"), "FICTIONAL PROOF OF FUNDS\nJordan Hale\nNot a real bank letter.\n");
  await fs.writeFile(path.join(storage, "uploads", "verification", "avery-proof.txt"), "FICTIONAL PROOF OF FUNDS\nAvery Chen\nWaiting on the desk.\n");
  await prisma.buyerProfile.createMany({
    data: [
      { userId: camille.id, entityType: "LLC", entityName: "Ortiz Capital LLC", jurisdiction: "Florida", accredited: true, certificationText: ACCREDITATION_TEXT, proofKey: "verification/camille-proof.txt", proofName: "ortiz-proof.txt", proofMime: "text/plain", status: "APPROVED", submittedAt: daysAgo(20), reviewedAt: daysAgo(18) },
      { userId: jordan.id, entityType: "INDIVIDUAL", entityName: "Jordan Hale", jurisdiction: "Florida", accredited: true, certificationText: ACCREDITATION_TEXT, proofKey: "verification/jordan-proof.txt", proofName: "hale-proof.txt", proofMime: "text/plain", status: "APPROVED", submittedAt: daysAgo(15), reviewedAt: daysAgo(14) },
      { userId: avery.id, entityType: "TRUST", entityName: "Chen Family Trust", jurisdiction: "Florida", accredited: true, certificationText: ACCREDITATION_TEXT, proofKey: "verification/avery-proof.txt", proofName: "chen-proof.txt", proofMime: "text/plain", status: "SUBMITTED", submittedAt: daysAgo(2) },
    ],
  });

  await prisma.savedSearch.create({
    data: {
      userId: camille.id,
      name: "Florida performing firsts",
      filters: { state: "FL", paymentStatus: "PERFORMING", lienPosition: "FIRST" },
    },
  });

  await prisma.revenueEvent.create({
    data: {
      type: "SUBSCRIPTION",
      amountCents: 24900,
      userId: camille.id,
      mock: true,
      description: "Pro membership · Camille Ortiz (simulated)",
      externalId: "mock_camille_seed",
      occurredAt: daysAgo(12),
    },
  });

  const noteFile = "FICTIONAL SAMPLE\nUPB Capital demo note.\nBorrower: FICTIONAL BORROWER A\nThis is not a real promissory note.\n";
  const files = [
    ["coral-note.txt", "NOTE", noteFile],
    ["coral-mortgage.txt", "MORTGAGE", "FICTIONAL SAMPLE MORTGAGE\nSecurity instrument for the Coral Gables demo.\n"],
    ["coral-bpo.txt", "BPO", "FICTIONAL BPO\nAs-is opinion $640,000. Not an appraisal.\n"],
  ] as const;
  for (const [name, type, body] of files) {
    const storedName = `seed-${name}`;
    await fs.writeFile(path.join(storage, "uploads", storedName), body);
    await prisma.document.create({
      data: { listingId: coral.id, type, originalName: name, storedName, mime: "text/plain", size: Buffer.byteLength(body) },
    });
  }
  const tape = "street_address,city,state,upb\nFictional tape stored with the pool.\n";
  await fs.writeFile(path.join(storage, "uploads", "seed-gulfstream.csv"), tape);
  await prisma.document.create({
    data: { listingId: pool.id, type: "TAPE", originalName: "gulfstream-2024-1.csv", storedName: "seed-gulfstream.csv", mime: "text/csv", size: Buffer.byteLength(tape) },
  });

  await prisma.notification.createMany({
    data: [
      { toEmail: "iris@upbcapital.test", subject: "Pool submitted · Gulfstream 2024-1", body: "Sample notice from the original tape intake." },
      { toEmail: camille.email, subject: "New paper matches “Florida performing firsts”", body: "Coral Gables went live and matched your saved search." },
      { toEmail: avery.email, subject: "Account pending", body: "Avery Chen is waiting on the desk." },
      { toEmail: southshore.email, subject: "Account pending", body: "Southshore Community Bank is waiting on the desk." },
    ],
  });

  const nora = await prisma.user.create({
    data: {
      email: "nora.vale@upbcapital.test",
      name: "Nora Vale",
      role: "BROKER",
      accountStatus: "APPROVED",
      passwordHash,
      phone: "(904) 555-0184",
      companyName: "Vale Note Advisors",
      referralCode: "NORAVALE",
      brokerProfile: {
        create: {
          company: "Vale Note Advisors",
          licenseType: "Mortgage broker",
          licenseNumber: "FL BK-184721",
          states: "FL, GA, SC",
          payoutNote: "ACH to the operating account named on the W-9. No account number is stored here.",
          bio: "I bring seasoned Florida and Georgia notes to a desk that already knows how to close them. Sellers keep the relationship. Buyers get a file that has been read.",
          portraitKey: "/brokers/nora-vale.jpg",
          w9Key: "seed-nora-w9.txt",
          w9Name: "Vale-Note-Advisors-W9.txt",
        },
      },
    },
  });
  await prisma.user.update({ where: { id: camille.id }, data: { referredById: nora.id } });
  const w9 = "FICTIONAL W-9\nVale Note Advisors\nThis is not a real tax form.\n";
  await fs.writeFile(path.join(storage, "uploads", "seed-nora-w9.txt"), w9);

  const brokerDeals: Array<{
    title: string;
    city: string;
    client: string;
    relationship: string;
    sale?: number;
    ask: number;
    upb: number;
    value: number;
    when: Date;
    fee?: "OWED" | "PAID";
    role: "SELLER_BROKER" | "AFFILIATE";
    listingStatus: "SOLD" | "APPROVED" | "SUBMITTED" | "PENDING";
    zip: string;
    state: string;
  }> = [
    { title: "First-lien performing · St. Augustine", city: "St. Augustine", state: "FL", zip: "32084", client: "Irene Cole", relationship: "Engagement letter on file.", sale: 96000, ask: 96000, upb: 188000, value: 340000, when: new Date(Date.UTC(2026, 6, 15)), fee: "PAID", role: "SELLER_BROKER", listingStatus: "SOLD" },
    { title: "First-lien performing · Savannah", city: "Savannah", state: "GA", zip: "31401", client: "Patrick Nguyen", relationship: "Long-time seller client.", sale: 140000, ask: 140000, upb: 255000, value: 410000, when: new Date(Date.UTC(2026, 7, 15)), fee: "PAID", role: "SELLER_BROKER", listingStatus: "SOLD" },
    { title: "First-lien performing · Charleston", city: "Charleston", state: "SC", zip: "29401", client: "Lila Brooks", relationship: "Introduced by her counsel.", sale: 210000, ask: 210000, upb: 360000, value: 590000, when: new Date(Date.UTC(2026, 8, 15)), fee: "PAID", role: "SELLER_BROKER", listingStatus: "SOLD" },
    { title: "First-lien performing · Jacksonville", city: "Jacksonville", state: "FL", zip: "32204", client: "Helen Marsh", relationship: "Engaged to sell the note.", sale: 120000, ask: 120000, upb: 214000, value: 365000, when: new Date(Date.UTC(2026, 9, 20)), fee: "OWED", role: "SELLER_BROKER", listingStatus: "SOLD" },
    { title: "First-lien performing · Daytona Beach", city: "Daytona Beach", state: "FL", zip: "32118", client: "Owen Price", relationship: "Listing agreement signed last week.", ask: 188000, upb: 276000, value: 430000, when: new Date(Date.UTC(2026, 9, 18)), role: "SELLER_BROKER", listingStatus: "APPROVED" },
    { title: "Second-lien NPL · Palatka", city: "Palatka", state: "FL", zip: "32177", client: "Oak Street Holdings", relationship: "Referral from the seller's servicer.", ask: 42000, upb: 91000, value: 240000, when: new Date(Date.UTC(2026, 9, 22)), role: "AFFILIATE", listingStatus: "SUBMITTED" },
  ];

  for (const deal of brokerDeals) {
    const fees = deal.sale ? feeBreakdown(deal.sale, 250, 300) : null;
    const listing = await prisma.listing.create({
      data: {
        kind: "SINGLE",
        sellerId: nora.id,
        brokerId: nora.id,
        brokerRole: deal.role,
        clientSellerName: deal.client,
        clientRelationship: deal.relationship,
        authorizationName: `${deal.client.replaceAll(" ", "-")}-engagement.txt`,
        status: deal.listingStatus,
        title: deal.title,
        summary: `Fictional file brought by Nora Vale for ${deal.client}.`,
        submittedAt: deal.when,
        approvedAt: deal.listingStatus === "SUBMITTED" ? null : deal.when,
        soldAt: deal.listingStatus === "SOLD" ? deal.when : null,
        salePrice: deal.sale,
        buyerPremiumCents: fees?.premiumCents,
        sellerCommissionCents: fees?.commissionCents,
        buyerTotalCents: fees?.buyerTotalCents,
        netToSellerCents: fees?.netToSellerCents,
        notes: {
          create: loan({
            street: `18 SAMPLE ${deal.city} Street`,
            city: deal.city,
            state: deal.state,
            zip: deal.zip,
            upb: deal.upb,
            value: deal.value,
            ask: deal.ask,
            lien: deal.role === "AFFILIATE" ? "SECOND" : "FIRST",
            status: deal.role === "AFFILIATE" ? "NON_PERFORMING" : "PERFORMING",
            borrower: "FICTIONAL BORROWER",
          }),
        },
      },
    });
    if (!deal.sale || !fees || !deal.fee) continue;
    const offer = await prisma.inquiry.create({
      data: {
        listingId: listing.id,
        buyerId: jordan.id,
        type: "OFFER",
        amount: deal.sale,
        status: "ACCEPTED",
        message: "Fictional bid on a brokered file.",
      },
    });
    const assessed = assessBrokerFees({
      premiumCents: fees.premiumCents,
      commissionCents: fees.commissionCents,
      sellerId: nora.id,
      buyerId: jordan.id,
      clientSellerName: deal.client,
      brokerName: nora.name,
      deal: { brokerId: nora.id, role: deal.role, terms: null },
      referrer: null,
      brokerSchedule: { basis: "PERCENT", bps: 2000, cents: 50000 },
      affiliateSchedule: { basis: "PERCENT", bps: 1000, cents: 25000 },
    });
    const fee = assessed.fees[0];
    const closing = await prisma.closing.create({
      data: {
        listingId: listing.id,
        inquiryId: offer.id,
        salePrice: deal.sale,
        buyerPremiumCents: fees.premiumCents,
        sellerCommissionCents: fees.commissionCents,
        buyerTotalCents: fees.buyerTotalCents,
        netToSellerCents: fees.netToSellerCents,
        status: "COMPLETE",
        closedAt: deal.when,
        openedAt: deal.when,
        provider: "manual",
        wireInstructions: "Fictional receiving bank\nUPB Capital Desk Escrow\nReference the broker closing.",
        steps: { create: CLOSING_STEPS.map((step) => ({ key: step.key, status: "COMPLETE", completedAt: deal.when })) },
      },
    });
    if (!fee) continue;
    await prisma.brokerFee.create({
      data: {
        closingId: closing.id,
        brokerId: nora.id,
        role: fee.role,
        amountCents: fee.amountCents,
        basis: fee.basis,
        status: deal.fee,
        paidAt: deal.fee === "PAID" ? deal.when : null,
        createdAt: deal.when,
      },
    });
    await prisma.revenueEvent.create({
      data: {
        type: "BROKER_FEE",
        amountCents: fee.amountCents,
        listingId: listing.id,
        userId: nora.id,
        description: `Broker fee owed to ${nora.name}`,
        externalId: `closing:${closing.id}:broker:${nora.id}:${fee.role}`,
        occurredAt: deal.when,
      },
    });
  }

  console.log("Seeded UPB Capital demo desk.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
