import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { audit } from "@/lib/audit";
import { stepLabel } from "@/lib/closing";
import { isReleaseBuild } from "@/lib/deploy";
import { money, prettyDate } from "@/lib/format";
import { labelOf } from "@/lib/labels";
import {
  chainOfTitle,
  collateralLines,
  collateralStatusLabel,
  completeness,
  completenessLine,
  displayValue,
  endorsementLabel,
  fieldState,
  groupByNote,
  latestChecks,
  LOAN_FIELDS,
  RISK_KINDS,
  riskResultLabel,
  sourcePhrase,
  tapeValue,
  type Chain,
  type CollateralRow,
  type RiskRow,
} from "@/lib/loan-file";
import { pdfSafe, wrap } from "@/lib/memo-pdf";
import { prisma } from "@/lib/prisma";

// The lender-ready file: one PDF a holder can hand a note-on-note lender. It restates what is on UPB's record, with
// each figure marked desk-verified or seller-stated, and adds an advance band that is only an estimate.

// ---------------------------------------------------------------------------------------------------------------
// The advance estimate

// Counsel: an estimate band from one published note-on-note programme (Gelt, 2026: 65–80% of balance performing,
// 40–60% non-performing; sub-performing sits between), not a lender's quote, an offer of credit or a referral. No
// lender has confirmed it. A partner-confirmed badge or any referral fee needs counsel before it ships.
export const ADVANCE_BANDS: Record<string, [number, number]> = {
  PERFORMING: [65, 80],
  SUB_PERFORMING: [55, 70],
  NON_PERFORMING: [40, 60],
};

export const ADVANCE_CAVEAT = "Indicative, lender decides.";

export type AdvanceEstimate = { lowPct: number; highPct: number; low: number; high: number; basis: string };

// A pool's band is weighted by each loan's UPB, so a mostly performing pool reads close to the performing band.
export function advanceEstimate(loans: { upb: number; paymentStatus: string }[], balance: number): AdvanceEstimate | null {
  const priced = loans.filter((loan) => loan.upb > 0 && ADVANCE_BANDS[loan.paymentStatus]);
  const total = priced.reduce((sum, loan) => sum + loan.upb, 0);
  if (!priced.length || !(total > 0) || !(balance > 0)) return null;
  const share = (edge: 0 | 1) => priced.reduce((sum, loan) => sum + loan.upb * ADVANCE_BANDS[loan.paymentStatus][edge], 0) / total;
  const lowPct = Math.round(share(0) * 10) / 10;
  const highPct = Math.round(share(1) * 10) / 10;
  const statuses = [...new Set(priced.map((loan) => loan.paymentStatus))];
  return {
    lowPct,
    highPct,
    low: Math.round((balance * lowPct) / 100),
    high: Math.round((balance * highPct) / 100),
    basis: statuses.length === 1 ? labelOf("payment", statuses[0]).toLowerCase() : "mixed-performance",
  };
}

export function advanceLine(estimate: AdvanceEstimate | null, balance: number) {
  // Counsel: the only advance figure UPB shows. It must stay a band, labelled indicative, with the lender deciding.
  if (!estimate) return `Advance estimate: none, because there is no loan record on UPB to read the performance from. ${ADVANCE_CAVEAT}`;
  return `Advance estimate: ${estimate.lowPct}–${estimate.highPct}% of the ${money(balance)} balance at purchase, about ${money(estimate.low)} to ${money(estimate.high)}, for ${estimate.basis} paper. ${ADVANCE_CAVEAT}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Who may download it

export type PackViewer = { id: string; role: string };
export type PackHolder = { kind: "buyer"; userId: string } | { kind: "desk" };

// The holder of a buyer holding, and the desk for any holding. Nobody else learns the holding exists.
export function lenderPackRole(viewer: PackViewer, holding: PackHolder): "holder" | "desk" | null {
  if (holding.kind === "buyer" && holding.userId === viewer.id) return "holder";
  if (viewer.role === "ADMIN") return "desk";
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The content

export type PackNote = { id: string; city: string; state: string; lienPosition: string; paymentStatus: string; upb: number; verifiedFields?: unknown };

export type PackInput = {
  kind: "buyer" | "desk";
  title: string;
  heldBy: string;
  acquiredAt: Date;
  costBasis: number;
  balance: number;
  sharePercent: number | null;
  status: string;
  // The seller named on the listing, which the chain of title should end with.
  sellerOnFile: string | null;
  listedAt: Date | null;
  loans: { note: PackNote; collateral: CollateralRow[]; risks: RiskRow[] }[];
  payments: { paidOn: Date; amount: number; memo: string }[];
  closing: { closedAt: Date | null; files: { name: string; step: string; at: Date }[] } | null;
  generatedAt: Date;
  demo: boolean;
};

export type PackLine = { text: string; soft?: boolean; strong?: boolean; indent?: boolean };
export type PackSection = { heading: string; lines: PackLine[] };

export const PACK_HEADINGS = [
  "Holding",
  "Loan record",
  "Collateral checklist",
  "Chain of title",
  "Risk card",
  "Payments logged",
  "Closing documents on file",
  "Advance estimate",
] as const;

const PAYMENT_LINES = 36;

// How the desk's record stands on one field, in words a lender reads without the app.
export function fieldMark(note: PackNote, field: string) {
  const state = fieldState(note, field);
  const spec = LOAN_FIELDS.find((row) => row.field === field);
  if (state.state === "verified") return `Desk-verified against ${sourcePhrase(state.source)}, ${prettyDate(state.at)}`;
  // A servicer's report is a third party's record; the holder's own software is the holder's. Neither is a desk check.
  if (state.state === "sourced") {
    const from = state.origin === "servicer" ? `From the servicer's report, ${state.source}` : `Holder-stated, from the holder's servicing software, ${state.source}`;
    return `${from}, ${prettyDate(state.at)}. Not checked by the desk`;
  }
  if (state.state === "disputed") {
    const read = spec ? displayValue(spec, state.document) : state.document;
    const where = !state.origin
      ? `The desk read ${read} in ${sourcePhrase(state.source)}`
      : `${state.origin === "servicer" ? "The servicer's report" : "The holder's servicing software"}, ${state.source}, reads ${read}`;
    return `Seller-stated. ${where}, ${prettyDate(state.at)}`;
  }
  if (state.changed) return `Seller-stated. Changed after the check of ${prettyDate(state.changed.at)}`;
  return "Seller-stated";
}

function loanHeading(note: PackNote, index: number, count: number): PackLine {
  return { text: count > 1 ? `Loan ${index + 1} of ${count}: ${note.city}, ${note.state}` : `${note.city}, ${note.state}`, strong: true };
}

function chainLines(chain: Chain): PackLine[] {
  const lines: PackLine[] = [{ text: chain.label, strong: true, indent: true }];
  if (!chain.links.length) {
    lines.push({ text: chain.waived != null ? `Marked not required${chain.waived ? `: ${chain.waived}` : "."}` : "Nothing on file yet.", indent: true });
    return lines;
  }
  for (const link of chain.links) {
    const parts = [`${link.position}. ${link.from || "Party not named"} to ${link.to || "party not named"}`, collateralStatusLabel(link.status)];
    if (chain.kind === "ALLONGE") {
      const endorsement = endorsementLabel(link.endorsement);
      if (endorsement) parts.push(endorsement.toLowerCase());
      parts.push(link.datedOn ? `dated ${prettyDate(link.datedOn)}` : "undated");
      parts.push(link.attachedAt ? `fixed to the note, confirmed ${prettyDate(link.attachedAt)}` : "attachment not confirmed");
    } else {
      if (link.recordedAt) parts.push(`recorded ${prettyDate(link.recordedAt)}`);
      if (link.recording) parts.push(link.recording);
    }
    lines.push({ text: parts.join(" · "), indent: true });
  }
  if (chain.endsInBlank) lines.push({ text: "Ends in blank: the note is bearer paper.", indent: true });
  for (const item of chain.breaks) lines.push({ text: `Break: ${item.message}`, indent: true });
  for (const caution of chain.cautions) lines.push({ text: `Caution: ${caution}`, indent: true });
  return lines;
}

export function lenderPackSections(pack: PackInput): PackSection[] {
  const count = pack.loans.length;
  const noLoans: PackLine[] = [{ text: "This note was added by hand, so UPB holds no loan record for it.", soft: true }];
  const holding: PackLine[] = [
    { text: `Holder: ${pack.heldBy}` },
    { text: `Acquired ${prettyDate(pack.acquiredAt)} · cost basis ${money(pack.costBasis)} · balance at purchase ${money(pack.balance)}` },
    ...(pack.sharePercent != null && pack.sharePercent < 99.9 ? [{ text: `Position: ${pack.sharePercent.toFixed(1)}% of the note` }] : []),
    { text: `Status on UPB: ${pack.status.toLowerCase()}` },
    { text: `Prepared ${prettyDate(pack.generatedAt)}. Seller-stated means the desk has not checked the figure against a document.`, soft: true },
  ];

  const record: PackLine[] = [];
  const collateral: PackLine[] = [];
  const chain: PackLine[] = [];
  const risk: PackLine[] = [];
  pack.loans.forEach(({ note, collateral: items, risks }, index) => {
    const heading = loanHeading(note, index, count);
    record.push(heading, { text: completenessLine(completeness(note, items, risks, { holder: pack.sellerOnFile })), soft: true });
    for (const spec of LOAN_FIELDS) {
      const value = tapeValue(note, spec.field);
      if (spec.optional && value == null) continue;
      record.push({ text: value == null ? `${spec.label}: not on the tape` : `${spec.label}: ${displayValue(spec, value)} · ${fieldMark(note, spec.field)}`, indent: true });
    }

    collateral.push(heading);
    for (const line of collateralLines(note.lienPosition, items)) {
      if (!line.items.length) {
        collateral.push({ text: `${line.label}: ${line.required ? "not yet reviewed" : "not reviewed, not required for this lien"}`, indent: true });
        continue;
      }
      line.items.forEach((item, position) => {
        const cure = item.status === "MISSING" || item.status === "DEFECTIVE"
          ? `${item.cureBy ? ` · cure by ${prettyDate(item.cureBy)}` : ""}${item.cureOwner ? ` · ${item.cureOwner}` : ""}`
          : "";
        collateral.push({ text: `${line.label}${line.items.length > 1 ? ` ${position + 1}` : ""}: ${collateralStatusLabel(item.status).toLowerCase()}${cure}`, indent: true });
      });
    }

    const title = chainOfTitle(items, pack.sellerOnFile, { listedAt: pack.listedAt });
    chain.push(heading, ...chainLines(title.endorsements), ...chainLines(title.assignments));
    for (const caution of title.cautions) chain.push({ text: `Caution: ${caution}`, indent: true });

    const latest = latestChecks(risks);
    risk.push(heading);
    for (const { kind, label } of RISK_KINDS) {
      const row = latest[kind];
      risk.push({
        text: row
          ? `${label}: ${riskResultLabel(row.result)} · ${row.source || "source not named"} · ${prettyDate(row.checkedAt)}${row.detail ? ` · ${row.detail}` : ""}`
          : `${label}: not checked`,
        indent: true,
      });
    }
  });
  if (count) {
    chain.push({ text: `The chain runs to the seller on file.${pack.closing ? " The assignment and allonge to the buyer are with the closing documents." : ""}`, soft: true });
  }

  const received = pack.payments.reduce((sum, payment) => sum + payment.amount, 0);
  const payments: PackLine[] = pack.payments.length
    ? [
        { text: `${pack.payments.length} payment${pack.payments.length === 1 ? "" : "s"} logged, ${money(received, 2)} in all.` },
        ...pack.payments.slice(0, PAYMENT_LINES).map((payment) => ({ text: `${prettyDate(payment.paidOn)} · ${money(payment.amount, 2)}${payment.memo ? ` · ${payment.memo}` : ""}`, indent: true })),
        ...(pack.payments.length > PAYMENT_LINES ? [{ text: `and ${pack.payments.length - PAYMENT_LINES} earlier`, indent: true }] : []),
        { text: "Logged on UPB from the servicer's reports. UPB is not the servicer.", soft: true },
      ]
    : [{ text: "No payments are logged on this holding yet." }];

  const documents: PackLine[] = !pack.closing
    ? [{ text: "No UPB closing is on file for this holding." }]
    : [
        { text: pack.closing.closedAt ? `Closed on UPB on ${prettyDate(pack.closing.closedAt)}.` : "The closing on UPB is not marked complete." },
        ...(pack.closing.files.length
          ? pack.closing.files.map((file) => ({ text: `${stepLabel(file.step)}: ${file.name}, filed ${prettyDate(file.at)}`, indent: true }))
          : [{ text: "No files are on the closing record.", indent: true }]),
      ];

  const estimate = advanceEstimate(pack.loans.map(({ note }) => note), pack.balance);
  const advance: PackLine[] = [
    { text: advanceLine(estimate, pack.balance) },
    { text: "A band from published note-on-note terms, not a quote. A lender sets its own advance after its own review of the file.", soft: true },
  ];

  return [
    { heading: "Holding", lines: holding },
    { heading: "Loan record", lines: count ? record : noLoans },
    { heading: "Collateral checklist", lines: count ? collateral : noLoans },
    { heading: "Chain of title", lines: count ? chain : noLoans },
    { heading: "Risk card", lines: count ? risk : noLoans },
    { heading: "Payments logged", lines: payments },
    { heading: "Closing documents on file", lines: documents },
    { heading: "Advance estimate", lines: advance },
  ];
}

export function packFooter(pack: Pick<PackInput, "generatedAt" | "demo">) {
  return `Prepared on UPB Capital from the desk's records on ${prettyDate(pack.generatedAt)}. Not an appraisal, legal advice or an offer of credit.${pack.demo ? " This file is from a demo server and is fictional." : ""}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Loading and auditing

type Opened = { ok: true; role: "holder" | "desk"; pack: PackInput } | { ok: false; status: 404 };

// A loan-level closing or desk holding covers one loan of the listing; otherwise the holding is the whole listing.
async function loanFile(listingId: string | null, only: string | null) {
  if (!listingId) return { listing: null, loans: [] as PackInput["loans"] };
  const listing = await prisma.listing.findUnique({
    where: { id: listingId },
    select: { submittedAt: true, clientSellerName: true, seller: { select: { name: true, companyName: true } }, notes: true },
  });
  if (!listing) return { listing: null, loans: [] as PackInput["loans"] };
  const notes = only ? listing.notes.filter((note) => note.id === only) : listing.notes;
  const noteIds = notes.map((note) => note.id);
  const [items, risks] = await Promise.all([
    prisma.collateralItem.findMany({ where: { noteId: { in: noteIds } } }),
    prisma.riskCheck.findMany({ where: { noteId: { in: noteIds } } }),
  ]);
  const itemsBy = groupByNote(items);
  const risksBy = groupByNote(risks);
  return {
    listing,
    loans: notes.map((note) => ({ note: { ...note, upb: Number(note.upb) }, collateral: itemsBy.get(note.id) ?? [], risks: risksBy.get(note.id) ?? [] })),
  };
}

async function closingRecord(closingId: string | null) {
  if (!closingId) return null;
  return prisma.closing.findUnique({
    where: { id: closingId },
    select: { listingId: true, noteId: true, status: true, closedAt: true, steps: { select: { key: true, files: { select: { originalName: true, createdAt: true } } } } },
  });
}

function closingOf(closing: Awaited<ReturnType<typeof closingRecord>>): PackInput["closing"] {
  if (!closing) return null;
  const files = closing.steps
    .flatMap((step) => step.files.map((file) => ({ name: file.originalName, step: step.key, at: file.createdAt })))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  return { closedAt: closing.status === "COMPLETE" ? (closing.closedAt ?? null) : null, files };
}

const sellerName = (listing: { clientSellerName: string; seller: { name: string; companyName: string } } | null) =>
  listing ? listing.clientSellerName || listing.seller.companyName || listing.seller.name || null : null;

async function buyerPack(id: string, now: Date): Promise<PackInput | null> {
  const holding = await prisma.buyerHolding.findUnique({
    where: { id },
    include: { payments: { orderBy: { paidOn: "desc" } }, user: { select: { name: true, companyName: true } } },
  });
  if (!holding) return null;
  const closing = await closingRecord(holding.closingId);
  const { listing, loans } = await loanFile(closing?.listingId ?? holding.listingId, closing?.noteId ?? null);
  return {
    kind: "buyer",
    title: holding.title,
    heldBy: holding.user.companyName || holding.user.name,
    acquiredAt: holding.acquiredAt,
    costBasis: Number(holding.costBasis),
    balance: Number(holding.upb),
    sharePercent: holding.sharePercent == null ? null : Number(holding.sharePercent),
    status: holding.status,
    sellerOnFile: sellerName(listing),
    listedAt: listing?.submittedAt ?? null,
    loans,
    payments: holding.payments.map((payment) => ({ paidOn: payment.paidOn, amount: Number(payment.amount), memo: payment.memo })),
    closing: closingOf(closing),
    generatedAt: now,
    demo: !isReleaseBuild(process.env),
  };
}

async function deskPack(id: string, now: Date): Promise<PackInput | null> {
  const holding = await prisma.deskHolding.findUnique({ where: { id }, include: { payments: { orderBy: { paidOn: "desc" } } } });
  if (!holding) return null;
  const closing = await closingRecord(holding.closingId);
  const { listing, loans } = await loanFile(holding.listingId, holding.noteId ?? closing?.noteId ?? null);
  return {
    kind: "desk",
    title: holding.title,
    heldBy: "UPB Capital desk book",
    acquiredAt: holding.acquiredAt,
    costBasis: Number(holding.costBasis),
    balance: Number(holding.upb),
    sharePercent: null,
    status: holding.status,
    sellerOnFile: sellerName(listing),
    listedAt: listing?.submittedAt ?? null,
    loans,
    payments: holding.payments.map((payment) => ({ paidOn: payment.paidOn, amount: Number(payment.amount), memo: payment.memo })),
    closing: closingOf(closing),
    generatedAt: now,
    demo: !isReleaseBuild(process.env),
  };
}

// Checks who is asking before anything is read, then loads the pack and records the download.
export async function openLenderPack(id: string, viewer: PackViewer, now = new Date()): Promise<Opened> {
  const missing = { ok: false, status: 404 } as const;
  if (!id || id.length > 64) return missing;
  const buyer = await prisma.buyerHolding.findUnique({ where: { id }, select: { userId: true } });
  const desk = buyer ? null : await prisma.deskHolding.findUnique({ where: { id }, select: { id: true } });
  if (!buyer && !desk) return missing;
  const role = lenderPackRole(viewer, buyer ? { kind: "buyer", userId: buyer.userId } : { kind: "desk" });
  if (!role) return missing;
  const pack = buyer ? await buyerPack(id, now) : await deskPack(id, now);
  if (!pack) return missing;
  await audit(viewer.id, "LENDER_PACK_DOWNLOAD", buyer ? "buyerHolding" : "deskHolding", id, `${role === "holder" ? "Holder" : "Desk"} downloaded the lender pack for ${pack.title}`);
  return { ok: true, role, pack };
}

// ---------------------------------------------------------------------------------------------------------------
// The PDF, in the memo's style, over as many pages as the file needs

const PAGE: [number, number] = [612, 792];
const MARGIN = 48;
const WIDTH = 516;
const BOTTOM = 64;

// A long unbroken string, such as a pasted link, would run off the page; it breaks every 60 characters.
const breakLong = (text: string) => text.replace(/\S{70,}/g, (word) => word.replace(/(\S{60})/g, "$1 "));

export async function buildLenderPackPdf(pack: PackInput, sections = lenderPackSections(pack)) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Lender pack: ${pack.title}`);
  pdf.setProducer("UPB Capital");
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const italic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const gold = rgb(0.776, 0.643, 0.431);
  const ink = rgb(0.12, 0.11, 0.09);
  const soft = rgb(0.4, 0.38, 0.34);
  const safe = (text: string, face: PDFFont) => breakLong(pdfSafe(text, face));

  let page: PDFPage = pdf.addPage(PAGE);
  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: rgb(0.03, 0.03, 0.04) });
  page.drawText("UPB CAPITAL  ·  LENDER PACK", { x: MARGIN, y: 762, size: 11, font, color: gold });
  let y = 704;
  for (const line of wrap(safe(pack.title, font), font, 20, WIDTH).slice(0, 2)) {
    page.drawText(line, { x: MARGIN, y, size: 20, font, color: ink });
    y -= 24;
  }
  page.drawText(safe(`${pack.heldBy}  ·  prepared ${prettyDate(pack.generatedAt)}`, italic), { x: MARGIN, y: y - 2, size: 12, font: italic, color: soft });
  y -= 34;

  const turn = () => {
    page = pdf.addPage(PAGE);
    page.drawText(safe(`UPB Capital  ·  Lender pack  ·  ${pack.title}`.slice(0, 110), font), { x: MARGIN, y: 760, size: 9, font, color: soft });
    y = 732;
  };
  const write = (line: PackLine) => {
    const face = line.strong ? bold : font;
    const size = line.soft ? 9 : 10;
    const indent = line.indent ? 12 : 0;
    for (const row of wrap(safe(line.text, face), face, size, WIDTH - indent)) {
      if (y < BOTTOM) turn();
      page.drawText(row, { x: MARGIN + indent, y, size, font: face, color: line.soft ? soft : ink });
      y -= size + 4;
    }
    if (line.soft) y -= 2;
  };
  for (const section of sections) {
    // A heading never sits alone at the foot of a page.
    if (y < BOTTOM + 60) turn();
    page.drawText(section.heading, { x: MARGIN, y, size: 13, font, color: gold });
    y -= 20;
    for (const line of section.lines) write(line);
    y -= 12;
  }

  const footer = wrap(safe(packFooter(pack), font), font, 8, WIDTH - 60);
  const pages = pdf.getPages();
  pages.forEach((sheet, index) => {
    footer.slice(0, 2).forEach((line, row) => sheet.drawText(line, { x: MARGIN, y: 36 - row * 10, size: 8, font, color: soft }));
    sheet.drawText(`${index + 1} of ${pages.length}`, { x: 612 - MARGIN - 30, y: 36, size: 8, font, color: soft });
  });
  return Buffer.from(await pdf.save());
}
