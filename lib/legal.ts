import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { clearSettingsCache, getSettings } from "@/lib/settings";

// The terms of use and the privacy policy. They are DocumentTemplate rows like the closing forms, under keys of their
// own, so the closing packet never reads them and the forms page never offers them as closing paper.
export const LEGAL_KEYS = ["TERMS", "PRIVACY"] as const;
export type LegalKey = (typeof LEGAL_KEYS)[number];

// The version every account accepts until the desk raises it. PlatformSettings.legalVersion overrides it once raised.
export const LEGAL_VERSION = "1";

export const LEGAL_PATHS: Record<LegalKey, string> = { TERMS: "/terms", PRIVACY: "/privacy" };

const DRAFT_NOTE = "> Draft under counsel review. This text is not final, and it may change before UPB Capital opens to the public. Figures in square brackets are placeholders for counsel.";

export const DEFAULT_LEGAL: Record<LegalKey, { title: string; body: string }> = {
  TERMS: {
    title: "Terms of use",
    body: [
      DRAFT_NOTE,
      "## Who these terms cover",
      "These terms apply to everyone who opens an account on UPB Capital or uses its site, desk or API. \"UPB\", \"we\" and \"the desk\" mean UPB Capital. \"You\" means the person or company using it. By creating an account or using the desk, you agree to these terms and to the privacy policy at /privacy.",
      "## Who may use UPB",
      "You must be at least 18 and able to sign a binding contract. If you sign up for a company, you confirm you may bind it.",
      "The desk approves every buyer, institution and broker account before it can bid, upload a tape or file for someone else. The desk may decline an account. [Counsel to confirm the discretion wording.]",
      "To make an offer, a buyer needs an approved buyer file: the buying entity, proof of funds, and the accredited-investor certification. You confirm that what you put in your files is true, and you tell the desk when it changes.",
      "Nobody on a sanctions list, and nobody acting for someone who is, may use UPB.",
      "## What UPB is, and is not",
      "UPB is a venue and a desk. It lists mortgage notes, runs bids and the closing checklist, and keeps the record of each trade.",
      "UPB is not a lender, a loan servicer, a fund or an investment adviser. It does not make or service loans, pool investors' money, or manage investments. Servicing, foreclosure, licensing and legal advice stay with the parties and their own lawyers. [Counsel to confirm the escrow and money-handling wording.]",
      "## Fees",
      "UPB charges the fees on its fee schedule at /fees: a buyer premium added on top of the accepted price, and a seller commission taken from the seller's proceeds. Pro membership is billed monthly.",
      "The fees on a listing are shown before you bid. A listing keeps the fees in force when the desk approved it, and a closing keeps the fees it opened with.",
      "Fees are due at closing unless the schedule says otherwise. Taxes and third-party costs, such as recording or a servicer's boarding fee, are yours.",
      "## No going around the desk",
      "If UPB introduces you to a note or to the other side of a trade, and that trade closes anywhere else within [12] months of the introduction, you owe UPB the fees it would have charged on the desk.",
      "This covers the same loan with the same seller or buyer, including a trade through a related company or someone acting for you. [Counsel to confirm the term and its enforceability by state.]",
      "## Confidential files and borrowers",
      "Street addresses, borrower names and data-room files open only after you sign the listing's confidentiality agreement. You use them only to evaluate a possible purchase of that listing.",
      "You do not contact the borrower, the occupants or the servicer. You do not copy or forward the file, except to your counsel or a lender working on your bid. These duties continue after a bid ends and after your account closes.",
      "The desk logs every file opened and downloaded.",
      "## The law on collecting and transferring loans",
      "Each party follows the laws that apply to owning, collecting and transferring mortgage loans. These include the Fair Debt Collection Practices Act, the notice rules for a servicing transfer under RESPA and the Truth in Lending Act, state licensing and foreclosure law, and sanctions law. [Counsel to confirm the list.]",
      "The buyer, or its servicer, sends the borrower the notices the law requires when a loan changes hands. Draft notices on UPB are a convenience, not legal advice.",
      "## Market data and results",
      "UPB may publish anonymised, aggregate market data drawn from activity on the desk, such as price ranges, volumes, times to close, and results by state or loan type. Published data never names a borrower, a street address or a party, unless that party agreed.",
      "## No investment advice",
      "Nothing on UPB is investment, legal, tax or accounting advice. Price ranges, yields, value estimates, comps and scores are tools, not recommendations. You make your own decision with your own advisers, and you do your own diligence.",
      "## Information as it is",
      "Listings, tapes and documents come from sellers and third parties. The desk reviews them but does not promise that any of them are complete or correct, or that a loan will perform. The site, the desk and its data are provided as they are, without warranties, as far as the law allows.",
      "UPB is not liable for indirect losses or lost profits. Its total liability to you for any claim is limited to the fees you paid UPB in the [12] months before the claim. [Counsel to confirm the limit and its exceptions.]",
      "## Suspension and termination",
      "The desk may pause bidding on an account, suspend it or close it for a breach of these terms, a sanctions match, missed closings, or a risk to other users or to UPB. The desk tells you why, unless the law forbids it.",
      "You may close your account at any time by writing the desk. Fees already owed, the confidentiality duties and the no-circumvention clause continue after an account closes.",
      "## Changes",
      "The desk may change these terms. When a change needs your consent, you are asked to accept the new version the next time you use the desk.",
      "## Governing law",
      "These terms are governed by the laws of [state], without regard to its conflict-of-law rules. Disputes go to the courts of [county and state]. [Counsel to decide on arbitration and venue.]",
      "## Contact",
      "Write the desk at {{contact}}.",
    ].join("\n\n"),
  },
  PRIVACY: {
    title: "Privacy policy",
    body: [
      DRAFT_NOTE,
      "## Who we are",
      "UPB Capital runs a desk for buying and selling mortgage notes. This policy says what we collect, why, who handles it for us, and what you can ask for. It covers the site, the desk and the API.",
      "## What we collect",
      [
        "- Account details: your name, email, phone, company and role, your password as a one-way hash, and your sign-in settings.",
        "- Buyer files: the buying entity and where it is formed, the accredited-investor certification, proof of funds, and what the desk verified.",
        "- Seller and broker files: the loans you list, tapes and payment histories, licenses, W-9s and payout notes.",
        "- Documents: files you upload to a data room, a closing or a message, and the agreements you sign.",
        "- Deal records: bids, counters, messages, closings and payments.",
        "- Usage: pages visited, files opened and downloaded, the network address and device you sign in from, and the notices we send you.",
        "- Deal announcements: if you join the list, your email and name. Each announcement carries a tiny image and tracked links, so we learn whether it was opened and which listing links were clicked. We record that against a one-way code made from your address, not the address itself. Turning off images in your mail app stops the open count.",
      ].join("\n"),
      "Loan files also carry details about borrowers who are not UPB users. We hold those to the same rules, and use them only to run the sale.",
      "## Why we use it",
      [
        "- To open and protect your account, and to confirm who you are.",
        "- To screen every party against sanctions lists, as the law requires.",
        "- To review listings and buyer files, run bids and close trades.",
        "- To send the notices, alerts and receipts you asked for or a deal needs.",
        "- To send deal announcements to people who joined the list, and to count how many were opened and clicked.",
        "- To bill fees and memberships.",
        "- To keep the records a trade, an audit or the law requires, and to prevent fraud.",
        "- To publish anonymised, aggregate market data, which never names you.",
      ].join("\n"),
      "We do not sell your personal information.",
      "## Who handles it for us",
      "Service providers process data for us, and only to provide their service:",
      [
        "- hosting and the database;",
        "- email delivery;",
        "- file storage;",
        "- identity and accreditation checks;",
        "- e-signature;",
        "- payments and billing;",
        "- sanctions screening;",
        "- property data and value estimates, which receive a loan's address but not your details;",
        "- AI tools the desk uses to draft summaries and answer questions about listings.",
      ].join("\n"),
      "[Counsel to add the named list of providers and where they hold data.]",
      "## Who else sees it",
      [
        "- The other side of a deal, as far as the deal needs: a seller sees a bidder's entity and bid, and a buyer sees the loan file after signing the confidentiality agreement.",
        "- A broker, on the deals they filed.",
        "- Counsel, auditors, lenders and regulators, when a closing or the law needs it.",
        "- A buyer of UPB's business, under this policy.",
      ].join("\n"),
      "## How long we keep it",
      "We keep account, deal and compliance records for at least {{retentionYears}} years after an account closes or a trade finishes, because tax, sanctions and lending rules require it. Site visit logs and notices you have read are deleted once they are {{retentionYears}} years old.",
      "## How we protect it",
      "Data travels encrypted. Passwords are stored only as a hash. Two-step sign-in is available on every account, and the desk can require it. Data-room files open only to approved parties, and every download is logged. No system is perfectly secure, and we will tell you of a breach that affects you as the law requires.",
      "## Your rights",
      [
        "- See and correct your details on your account pages, or ask the desk.",
        "- Ask for a copy of the data we hold about you.",
        "- Turn alerts and notices off under Notice settings, and leave the deal-announcement list from the link in any announcement.",
        "- Ask us to delete your account and your data.",
      ].join("\n"),
      "Your state may give you more rights. Using them never changes how the desk treats you.",
      "## Asking for deletion",
      "Write to {{contact}} from the email on your account, with the subject \"Delete my account\". We confirm it is you, then delete or anonymise your data within [30] days. We keep only what the law requires or an open deal needs, and we tell you what we kept and why.",
      "## Children",
      "UPB is not for anyone under 18.",
      "## Changes",
      "When this policy changes in a way that needs your consent, you are asked to accept the new version the next time you use the desk.",
      "## Contact",
      "Questions about privacy go to {{contact}}. [Counsel to add a postal address and the person responsible for privacy.]",
    ].join("\n\n"),
  },
};

export function isLegalKey(value: string): value is LegalKey {
  return (LEGAL_KEYS as readonly string[]).includes(value);
}

// The saved text, or the built-in draft. Nothing is written on a read, since the public pages read it on every visit.
export async function loadLegal(key: LegalKey) {
  const row = await prisma.documentTemplate.findUnique({ where: { key } });
  return row ? { ...row, key } : { key, ...DEFAULT_LEGAL[key], updatedAt: null };
}

export async function currentLegalVersion() {
  return (await getSettings()).legalVersion || LEGAL_VERSION;
}

export function legalDue(user: { termsVersion?: string | null }, version: string) {
  return user.termsVersion !== version;
}

// Versions count up. A version someone typed by hand starts the count again above the built-in one.
export function nextLegalVersion(current: string) {
  const value = Number.parseInt(current, 10);
  return String(Number.isFinite(value) && value >= 1 ? value + 1 : Number(LEGAL_VERSION) + 1);
}

// Every account whose accepted version isn't the new one sees the banner until they accept it.
export async function raiseLegalVersion(actorId: string) {
  const version = nextLegalVersion(await currentLegalVersion());
  await prisma.platformSettings.upsert({ where: { id: "default" }, update: { legalVersion: version }, create: { id: "default", legalVersion: version } });
  clearSettingsCache();
  await audit(actorId, "LEGAL_VERSION", "settings", "default", `Terms and privacy policy raised to version ${version}.`);
  return version;
}

export async function acceptTerms(userId: string, now = new Date()) {
  const version = await currentLegalVersion();
  await prisma.user.update({ where: { id: userId }, data: { termsVersion: version, termsAcceptedAt: now } });
  await audit(userId, "TERMS_ACCEPTED", "user", userId, `Accepted the terms of use and privacy policy, version ${version}.`);
  return version;
}

export const CONSENT_REQUIRED = "Agree to the Terms of use and Privacy policy to create an account.";

// Signup records the version the person agreed to, on the account it creates.
export async function signupConsent(value: FormDataEntryValue | null, now = new Date()) {
  if (value !== "yes") return { error: CONSENT_REQUIRED } as const;
  return { error: null, data: { termsVersion: await currentLegalVersion(), termsAcceptedAt: now } } as const;
}

// The tokens a legal text may use, filled from the settings and the desk's address.
export function fillLegal(body: string, vars: { retentionYears: number; contact: string }) {
  return body
    .replace(/\{\{\s*retentionYears\s*\}\}/g, String(vars.retentionYears))
    .replace(/\{\{\s*contact\s*\}\}/g, vars.contact);
}

export function legalContact(env: Record<string, string | undefined> = process.env) {
  return env.DESK_EMAIL?.trim() || "[privacy contact email]";
}

export type LegalBlock =
  | { kind: "heading"; text: string }
  | { kind: "note"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "paragraph"; text: string };

// The desk writes plain text: a blank line between paragraphs, "## " for a heading, "- " for a list item and "> " for
// a callout such as the draft note.
export function legalBlocks(body: string): LegalBlock[] {
  return body
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block): LegalBlock => {
      if (block.startsWith("## ")) return { kind: "heading", text: block.slice(3).trim() };
      if (block.startsWith("> ")) return { kind: "note", text: block.replace(/^>\s?/gm, "").replace(/\s*\n\s*/g, " ").trim() };
      const lines = block.split("\n").map((line) => line.trim());
      if (lines.every((line) => line.startsWith("- "))) return { kind: "list", items: lines.map((line) => line.slice(2).trim()) };
      return { kind: "paragraph", text: lines.join(" ") };
    });
}

// Site paths named in the text, such as /fees, become links.
export function legalLinkParts(text: string) {
  return text.split(/(\/(?:fees|terms|privacy)\b)/).map((part) => ({ text: part, href: /^\/(?:fees|terms|privacy)$/.test(part) ? part : null }));
}
