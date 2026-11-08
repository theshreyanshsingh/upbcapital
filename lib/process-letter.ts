import type { SaleEvent } from "@prisma/client";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { fold, icsText, icsTime } from "@/lib/calendar-feed";
import { depositTerms } from "@/lib/closing-clock";
import { diligenceDays } from "@/lib/closing-service";
import { prisma } from "@/lib/prisma";
import { listingScope } from "@/lib/private-listings";
import { EVENT_STATUS_LABEL, milestones, when } from "@/lib/sale-events";
import { getSettings } from "@/lib/settings";
import { deskContact } from "@/lib/staff";

// The process letter and calendar for a sale event: what an advisor sends bidders before a dated sale. The listings,
// every date in UTC, the bid rules, the deposit and diligence terms, the desk's notes, and who to call.

const DAY = 24 * 60 * 60 * 1000;
// Listings a buyer could see on the book. A withdrawn or declined file never shows in an event's papers.
const ON_BOOK = ["APPROVED", "PENDING", "SOLD"];

type Viewer = { id: string; role: string; accountStatus: string };
type EventListing = { id: string; title: string; status: string; kind: string; sellerId: string; brokerId: string | null; loans: number };

// Who may read an event's letter and calendar: the desk, any approved buyer, and the seller or filing broker of a
// listing in the event. Null means no.
export async function eventPapers(eventId: string, viewer: Viewer) {
  const event = await prisma.saleEvent.findUnique({ where: { id: eventId } });
  if (!event) return { status: 404 as const };
  // A buyer's letter leaves out what the book hides from them: private listings they weren't invited to, and every
  // listing of a seller who excludes them (lib/private-listings.ts).
  const rows = await prisma.listing.findMany({
    where: { saleEventId: event.id, AND: [await listingScope(viewer)] },
    select: { id: true, title: true, status: true, kind: true, sellerId: true, brokerId: true, _count: { select: { notes: true } } },
    orderBy: { approvedAt: "asc" },
  });
  const listings: EventListing[] = rows.map((row) => ({ id: row.id, title: row.title, status: row.status, kind: row.kind, sellerId: row.sellerId, brokerId: row.brokerId, loans: row._count.notes }));
  const desk = viewer.role === "ADMIN";
  const buyer = viewer.role === "BUYER" && viewer.accountStatus === "APPROVED";
  const own = (listing: EventListing) => listing.sellerId === viewer.id || listing.brokerId === viewer.id;
  const seller = listings.some(own);
  if (!desk && !buyer && !seller) return { status: 403 as const };
  const shown = listings.filter((listing) => desk || own(listing) || ON_BOOK.includes(listing.status));
  // A seller sees their own listings by name and the rest as a count, since the book isn't theirs to browse.
  const named = desk || buyer ? shown : shown.filter(own);
  return { status: 200 as const, event, listings: named, others: shown.length - named.length };
}

export type LetterContent = {
  name: string;
  status: string;
  summary: string;
  listings: string[];
  others: number;
  dates: [string, string][];
  rules: string[];
  notes: string;
  contact: string;
  issued: string;
};

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// The letter's words, apart from the page, so the content can be checked without reading a PDF.
export function letterContent(input: {
  event: Pick<SaleEvent, "name" | "status" | "summary" | "indicationsAt" | "bestFinalAt" | "ndaDueAt" | "qaCutoffAt" | "awardTargetAt" | "closingTargetAt" | "processNotes">;
  listings: Pick<EventListing, "title" | "kind" | "loans">[];
  others: number;
  settings: { depositBps?: number | null; depositDays?: number | null; diligenceDays?: number | null };
  contact: string;
  now?: Date;
}): LetterContent {
  const { event } = input;
  const deposit = depositTerms(input.settings);
  const diligence = diligenceDays(input.settings.diligenceDays);
  const gap = Math.round((event.bestFinalAt.getTime() - event.indicationsAt.getTime()) / DAY);
  const rules = [
    event.ndaDueAt
      ? `Sign each listing's NDA by ${when(event.ndaDueAt)}, so its data room is open to you in time to bid.`
      : "Each listing's data room opens once you sign its NDA.",
    event.qaCutoffAt
      ? `Ask the seller questions in each listing's data room until ${when(event.qaCutoffAt)}. Each answer goes to every bidder in the room, and never says who asked. No new questions go to the seller after that.`
      : "Ask the seller questions in each listing's data room. Each answer goes to every bidder in the room, and never says who asked.",
    `Indications are sealed bids, due by ${when(event.indicationsAt)}. No other bidder and not the seller sees an amount before the deadline.`,
    `At the indications date each indication is released, and every buyer who can bid places one best-and-final bid by ${when(event.bestFinalAt)}, ${plural(gap, "day")} later. A bid placed after the indications date already counts as that buyer's best and final. A withdrawn bid still counts as the one bid.`,
    "Every bid passes the checks any bid on UPB Capital does: an approved buyer file, and verified funds that cover the all-in price with the buyer premium. The premium is on each listing's page and the fee schedule. It is added to the price, not part of the bid.",
    "A bid stands until you withdraw it or the desk decides it. A good-until date has to fall on or after the best-and-final date. Once that date passes, bids bind until the desk decides them.",
    `The desk awards after the best-and-final date${event.awardTargetAt ? `, aiming for ${when(event.awardTargetAt)}` : ""}. Nothing sells without the seller's agreement on the price: their reserve, their approval, or their pick of a bid.`,
    deposit.bps > 0
      ? `The winning buyer wires a deposit of ${deposit.bps / 100}% of the price within ${plural(deposit.days, "day")} of the award. It counts toward the price.`
      : "No deposit is due at award.",
    diligence
      ? `After an award the buyer has ${plural(diligence, "day")} of diligence, in which they can walk away for a finding. A walk-away in that window is never a strike.`
      : "There is no diligence window after an award, so do your diligence in the data room before you bid.",
    event.closingTargetAt ? `Closings aim to finish by ${when(event.closingTargetAt)}.` : "Each closing runs on the desk's usual schedule after its award.",
  ];
  return {
    name: event.name,
    status: EVENT_STATUS_LABEL[event.status] ?? event.status,
    summary: event.summary,
    listings: input.listings.map((listing) => `${listing.title} · ${listing.kind === "POOL" ? plural(listing.loans, "loan") : "one note"}`),
    others: input.others,
    dates: milestones(event).map((milestone) => [milestone.label, when(milestone.at)]),
    rules,
    notes: event.processNotes.trim(),
    contact: input.contact,
    issued: (input.now ?? new Date()).toISOString().slice(0, 10),
  };
}

// The desk member who set up the event, or the desk's address.
export async function letterContact(event: Pick<SaleEvent, "createdById">) {
  const owner = await deskContact(event.createdById);
  if (owner) return `${owner.name}, ${owner.email}`;
  return process.env.DESK_EMAIL?.trim() || "The desk, through the help link on UPB Capital";
}

export async function loadLetter(papers: { event: SaleEvent; listings: EventListing[]; others: number }, now = new Date()) {
  const [settings, contact] = await Promise.all([getSettings(), letterContact(papers.event)]);
  return letterContent({ event: papers.event, listings: papers.listings, others: papers.others, settings, contact, now });
}

function wrap(text: string, font: PDFFont, size: number, width: number) {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

// Styled like the settlement statement: a quiet header, a bold title, plain sections. It runs onto more pages as
// the notes and listings need.
export async function buildLetterPdf(content: LetterContent) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.1, 0.12);
  const quiet = rgb(0.42, 0.42, 0.46);
  // The standard fonts carry Latin-1 only, so anything else prints as a plain stand-in.
  const clean = (text: string) => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[·–—]/g, "-").replace(/[^\x20-\x7E]/g, "-");
  const left = 48;
  const width = 516;
  let page: PDFPage = pdf.addPage([612, 792]);
  let y = 744;
  const room = (needed: number) => {
    if (y - needed >= 72) return;
    page = pdf.addPage([612, 792]);
    y = 744;
  };
  const write = (text: string, options: { size?: number; font?: PDFFont; color?: typeof ink; indent?: number; gap?: number } = {}) => {
    const size = options.size ?? 10;
    const indent = options.indent ?? 0;
    for (const line of wrap(clean(text), options.font ?? font, size, width - indent)) {
      room(size + 4);
      page.drawText(line, { x: left + indent, y, size, font: options.font ?? font, color: options.color ?? ink });
      y -= size + 4;
    }
    y -= options.gap ?? 0;
  };
  const heading = (text: string) => {
    room(40);
    y -= 8;
    write(text, { size: 12, font: bold, gap: 4 });
  };

  write("UPB CAPITAL  -  SALE PROCESS LETTER", { size: 10, font: bold, color: quiet, gap: 14 });
  write(content.name, { size: 18, font: bold, gap: 2 });
  write(`${content.status}  -  issued ${content.issued}  -  all times UTC`, { size: 9, color: quiet, gap: 10 });
  if (content.summary) write(content.summary, { gap: 6 });

  heading("Calendar");
  for (const [label, at] of content.dates) {
    room(16);
    page.drawText(clean(label), { x: left + 12, y, size: 10, font, color: ink });
    page.drawText(clean(at), { x: left + width - font.widthOfTextAtSize(clean(at), 10), y, size: 10, font, color: ink });
    y -= 16;
  }

  heading("Listings");
  if (!content.listings.length && !content.others) write("Listings join before indications are due. The desk adds each one on the seller's agreement.", { indent: 12 });
  for (const listing of content.listings) write(`- ${listing}`, { indent: 12, gap: 2 });
  if (content.others) write(`${plural(content.others, content.listings.length ? "more listing" : "listing")} from other sellers.`, { indent: 12, color: quiet });

  heading("How bids work");
  content.rules.forEach((rule, index) => write(`${index + 1}. ${rule}`, { indent: 12, gap: 4 }));

  if (content.notes) {
    heading("Notes from the desk");
    write(content.notes, { indent: 12, gap: 4 });
  }

  heading("Desk contact");
  write(content.contact, { indent: 12, gap: 8 });

  const footer = [
    "Prepared by the UPB Capital desk from the event record. Dates can move before bids are in; the event page and its",
    "calendar file carry the current dates. Nothing here is an offer to sell: each sale needs the seller's agreement.",
  ];
  room(40);
  footer.forEach((line) => {
    page.drawText(line, { x: left, y, size: 8, font, color: quiet });
    y -= 12;
  });
  return pdf.save();
}

// ---------------------------------------------------------------------------------------------------------------
// The calendar file: one entry per date the event has set, so a buyer's calendar carries the whole sale.

export function buildCalendar(event: Pick<SaleEvent, "id" | "name" | "status" | "indicationsAt" | "bestFinalAt" | "ndaDueAt" | "qaCutoffAt" | "awardTargetAt" | "closingTargetAt" | "createdAt" | "updatedAt">, options: { appUrl?: string; now?: Date } = {}) {
  const base = (options.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  const stamp = icsTime(options.now ?? new Date());
  // Each save raises the sequence, so a calendar that imported the file takes moved dates.
  const sequence = Math.max(0, Math.floor((event.updatedAt.getTime() - event.createdAt.getTime()) / 1000));
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//UPB Capital//Sale events//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(event.name)}`,
  ];
  for (const milestone of milestones(event)) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.id}-${milestone.key}@upbcapital`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsTime(milestone.at)}`,
      `DTEND:${icsTime(new Date(milestone.at.getTime() + 30 * 60 * 1000))}`,
      `SEQUENCE:${sequence}`,
      `SUMMARY:${icsText(`${milestone.label}: ${event.name}`)}`,
      `DESCRIPTION:${icsText(`${milestone.label} in the UPB Capital sale event ${event.name}, at ${when(milestone.at)}.${base ? ` Process letter: ${base}/api/events/${event.id}/letter` : ""}`)}`,
      ...(base ? [`URL:${base}/events#${event.id}`] : []),
      ...(event.status === "CANCELED" ? ["STATUS:CANCELLED"] : []),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
