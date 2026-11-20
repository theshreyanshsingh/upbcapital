import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { subprocessors, type Subprocessor } from "@/app/security/subprocessors";
import { modelReadingAllowed, readingModeOf } from "@/lib/ai-reading";
import { API_LIMIT } from "@/lib/api-limit";
import { API_LOG_DAYS } from "@/lib/api-log";
import { audit } from "@/lib/audit";
import { toCsv } from "@/lib/csv";
import { aiMode } from "@/lib/desk-ai";
import { isReleaseBuild, secureCookies } from "@/lib/deploy";
import { DESK_ROLE_HINTS, DESK_ROLE_LABELS, DESK_ROLES, type Staff } from "@/lib/desk-roles";
import { prettyDate } from "@/lib/format";
import { currentLegalVersion, fillLegal, legalBlocks, legalContact, loadLegal } from "@/lib/legal";
import { pdfSafe, wrap } from "@/lib/memo-pdf";
import { SANCTIONS_RECORD_YEARS, ofacMode } from "@/lib/ofac";
import { participationFaq, participationsOpen } from "@/lib/participation";
import { prisma } from "@/lib/prisma";
import { SEAT_ROLE_HINTS, SEAT_ROLE_LABELS, SEAT_ROLES } from "@/lib/seats";
import { clearSettingsCache, getSettings } from "@/lib/settings";

// The vendor pack: what a bank's or credit union's third-party risk review asks of UPB, as one dated PDF and a
// questionnaire CSV. Every line is read from the code and the configuration the site runs with, or from the facts the
// desk keeps by hand in PlatformSettings.securityPack. A missing fact says "Not yet in place" or "Not set by the desk";
// nothing is assumed. It is UPB's own statement, not an audit, and counsel and the reader's security team review it.

export const PACK_VERSION = "1";
export const NOT_IN_PLACE = "Not yet in place";
export const NOT_SET = "Not set by the desk";

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------------------------
// The facts the desk keeps by hand

export type SecurityPack = {
  penTestDate: string | null;
  penTestFirm: string | null;
  cyberInsurer: string | null;
  rtoHours: number | null;
  rpoHours: number | null;
  incidentContact: string | null;
};

export const EMPTY_SECURITY_PACK: SecurityPack = { penTestDate: null, penTestFirm: null, cyberInsurer: null, rtoHours: null, rpoHours: null, incidentContact: null };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HOURS = 720;

function cleanText(value: unknown) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function realDate(value: string) {
  if (!DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function hours(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_HOURS ? value : null;
}

// The stored facts, as typed. A row from before the field, or one written by hand, reads as nothing set.
export function readSecurityPack(value: unknown): SecurityPack {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...EMPTY_SECURITY_PACK };
  const row = value as Record<string, unknown>;
  const text = (field: string, max: number) => {
    const cleaned = typeof row[field] === "string" ? cleanText(row[field]).slice(0, max) : "";
    return cleaned || null;
  };
  const date = text("penTestDate", 10);
  return {
    penTestDate: date && realDate(date) ? date : null,
    penTestFirm: text("penTestFirm", 120),
    cyberInsurer: text("cyberInsurer", 120),
    rtoHours: hours(row.rtoHours),
    rpoHours: hours(row.rpoHours),
    incidentContact: text("incidentContact", 160),
  };
}

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE = /(\d[\s().-]*){7,}/;

// The desk's form, checked. Blank clears a fact. A test needs both its date and its firm.
export function securityPackFrom(input: Record<string, unknown>, now = new Date()): { error: string } | { error: null; pack: SecurityPack } {
  const field = (name: string) => cleanText(input[name]);
  const penTestDate = field("penTestDate");
  const penTestFirm = field("penTestFirm");
  const cyberInsurer = field("cyberInsurer");
  const incidentContact = field("incidentContact");
  if (penTestDate) {
    const date = realDate(penTestDate);
    if (!date || date.getTime() > now.getTime() || date.getUTCFullYear() < 2000) return { error: "Enter the test's date as YYYY-MM-DD, no later than today." };
  }
  if (penTestDate && !penTestFirm) return { error: "Name the firm that ran the penetration test." };
  if (penTestFirm && !penTestDate) return { error: "Enter the date of the penetration test." };
  if (penTestFirm.length > 120) return { error: "Keep the firm's name under 120 characters." };
  if (cyberInsurer.length > 120) return { error: "Keep the insurer's name under 120 characters." };
  const target = (name: string): number | null | undefined => {
    const raw = field(name).replace(/\s*(hours?|hrs?|h)$/i, "");
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 && value <= MAX_HOURS ? Math.round(value * 100) / 100 : undefined;
  };
  const rtoHours = target("rtoHours");
  const rpoHours = target("rpoHours");
  if (rtoHours === undefined || rpoHours === undefined) return { error: `Recovery targets are hours, more than 0 and at most ${MAX_HOURS}.` };
  if (incidentContact.length > 160) return { error: "Keep the incident contact under 160 characters." };
  if (incidentContact && !EMAIL.test(incidentContact) && !PHONE.test(incidentContact)) return { error: "Give an email address or a phone number for incidents." };
  return {
    error: null,
    pack: {
      penTestDate: penTestDate || null,
      penTestFirm: penTestFirm || null,
      cyberInsurer: cyberInsurer || null,
      rtoHours,
      rpoHours,
      incidentContact: incidentContact || null,
    },
  };
}

const PACK_LABELS: Record<keyof SecurityPack, string> = {
  penTestDate: "pen test date",
  penTestFirm: "pen test firm",
  cyberInsurer: "cyber insurer",
  rtoHours: "RTO hours",
  rpoHours: "RPO hours",
  incidentContact: "incident contact",
};

// Saves the desk's facts and writes what changed, old and new, to the audit log.
export async function saveSecurityPack(actor: { id: string }, input: Record<string, unknown>, now = new Date()) {
  const checked = securityPackFrom(input, now);
  if (checked.error !== null) return { error: checked.error } as const;
  // Read fresh, not from the settings cache, so the log's "before" is what was stored.
  const before = readSecurityPack((await prisma.platformSettings.findUnique({ where: { id: "default" }, select: { securityPack: true } }))?.securityPack);
  const changed = (Object.keys(PACK_LABELS) as (keyof SecurityPack)[]).filter((key) => before[key] !== checked.pack[key]);
  if (!changed.length) return { error: null, changed: false } as const;
  await prisma.platformSettings.upsert({
    where: { id: "default" },
    update: { securityPack: checked.pack },
    create: { id: "default", securityPack: checked.pack },
  });
  clearSettingsCache();
  const shown = (value: string | number | null) => (value == null ? "blank" : String(value));
  await audit(
    actor.id,
    "SECURITY_PACK",
    "settings",
    "default",
    `Vendor pack facts: ${changed.map((key) => `${PACK_LABELS[key]} ${shown(before[key])} to ${shown(checked.pack[key])}`).join("; ")}.`,
  );
  return { error: null, changed: true } as const;
}

// ---------------------------------------------------------------------------------------------------------------
// The facts the pack is built from

type Env = Record<string, string | undefined>;

type LegalFacts = { version: string; updatedAt: Date | null; draft: boolean };

export type PackFacts = {
  asOf: Date;
  pack: SecurityPack;
  services: Subprocessor[];
  release: boolean;
  twoStepForAll: boolean;
  retentionYears: number;
  https: boolean;
  secureCookies: boolean;
  modelReadsFiles: boolean;
  sanctions: { mode: ReturnType<typeof ofacMode>; realList: boolean; lastVersion: string | null; lastScreenedAt: Date | null };
  terms: LegalFacts;
  privacy: LegalFacts;
  // The terms' "What UPB is, and is not" section, the privacy policy's "What we collect" section and its sentence on
  // breaches, as the site publishes them today. Empty when the desk's text has no such section.
  whatUpbIs: string[];
  dataHeld: string[];
  breachLine: string | null;
  fundAnswer: string;
  securityContact: string;
};

function section(body: string, heading: string) {
  const blocks = legalBlocks(body);
  const start = blocks.findIndex((block) => block.kind === "heading" && block.text.toLowerCase() === heading.toLowerCase());
  if (start < 0) return [];
  const lines: string[] = [];
  for (const block of blocks.slice(start + 1)) {
    if (block.kind === "heading") break;
    if (block.kind === "list") lines.push(...block.items);
    else lines.push(block.text);
  }
  return lines;
}

export async function packFacts(options: { now?: Date; env?: Env } = {}): Promise<PackFacts> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const [settings, version, terms, privacy, lastScreen] = await Promise.all([
    getSettings(),
    currentLegalVersion(),
    loadLegal("TERMS"),
    loadLegal("PRIVACY"),
    prisma.ofacCheck.findFirst({ where: { listVersion: { isSet: true, not: null } }, orderBy: { createdAt: "desc" }, select: { listVersion: true, createdAt: true } }),
  ]);
  const services = subprocessors(settings, env);
  const vars = { retentionYears: settings.retentionYears, contact: legalContact(env) };
  const termsBody = fillLegal(terms.body, vars);
  const privacyBody = fillLegal(privacy.body, vars);
  const draft = (body: string) => legalBlocks(body).some((block) => block.kind === "note" && /draft/i.test(block.text));
  const sentences = legalBlocks(privacyBody).flatMap((block) => (block.kind === "list" ? block.items : block.kind === "heading" ? [] : [block.text]).flatMap((text) => text.split(/(?<=\.)\s+/)));
  const breach = sentences.find((sentence) => /\bbreach/i.test(sentence)) ?? null;
  return {
    asOf: now,
    pack: readSecurityPack(settings.securityPack),
    services,
    release: isReleaseBuild(env),
    twoStepForAll: settings.requireTwoStep !== false,
    retentionYears: settings.retentionYears,
    // next.config.ts sends Strict-Transport-Security only when the site's address is https.
    https: /^https:\/\//i.test((env.NEXT_PUBLIC_APP_URL || "").trim()),
    secureCookies: secureCookies(env),
    modelReadsFiles: aiMode(env) === "live" && modelReadingAllowed(env) && readingModeOf(settings.aiReading) !== "OFF",
    sanctions: {
      mode: ofacMode(env),
      realList: services.find((service) => service.category === "Sanctions list")?.inUse ?? false,
      lastVersion: lastScreen?.listVersion ?? null,
      lastScreenedAt: lastScreen?.createdAt ?? null,
    },
    terms: { version, updatedAt: terms.updatedAt, draft: draft(termsBody) },
    privacy: { version, updatedAt: privacy.updatedAt, draft: draft(privacyBody) },
    whatUpbIs: section(termsBody, "What UPB is, and is not"),
    dataHeld: section(privacyBody, "What we collect"),
    breachLine: breach ? breach.replace(/\s+/g, " ").trim() : null,
    fundAnswer: participationFaq(participationsOpen(env)).fund,
    securityContact: env.SECURITY_EMAIL?.trim() || env.DESK_EMAIL?.trim() || "",
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The pack's text

const day = (date: Date) => date.toISOString().slice(0, 10);
const hoursText = (value: number) => `${value} ${value === 1 ? "hour" : "hours"}`;

// A service's name inside a sentence: "A MongoDB server" reads "a MongoDB server".
function inline(name: string) {
  return /^(A|An) /.test(name) ? `${name.charAt(0).toLowerCase()}${name.slice(1)}` : name;
}

function service(facts: PackFacts, category: string) {
  return facts.services.find((row) => row.category === category);
}

// Neither the code nor the configuration takes backups, so what exists is whatever the database's host keeps.
function backupLine(facts: PackFacts) {
  return service(facts, "Database")?.name === "MongoDB Atlas"
    ? "per the database provider's defaults (MongoDB Atlas). UPB's configuration doesn't record a backup schedule."
    : "UPB's configuration doesn't record backups. They depend on whoever runs the database.";
}

function penTestRecent(facts: PackFacts) {
  const date = facts.pack.penTestDate ? realDate(facts.pack.penTestDate) : null;
  return Boolean(date && facts.asOf.getTime() - date.getTime() <= 366 * DAY);
}

// The /security page's audits line and the pack's say the same thing.
export function auditStatement(pack: SecurityPack) {
  const test = pack.penTestDate && pack.penTestFirm
    ? `The last outside penetration test was on ${pack.penTestDate}, by ${pack.penTestFirm}.`
    : "No outside firm has tested these controls.";
  return `UPB Capital has no SOC 2 report yet. ${test} We answer vendor questionnaires plainly, including when the answer is no.`;
}

export const API_LOG_LINE = `Each call made with an API key is logged for ${API_LOG_DAYS} days: the time, the method, the path with the query's values left out, the status the call was answered with (the route's own answer, or the key check's refusal: 401, 403 or 429) and a keyed hash of the caller's address, never the address. Past a key's allowance, or with a revoked key, the first refusal each minute is logged. The key's owner and the desk can read it.`;

export type PackSection = { heading: string; lines: string[] };

export function packSections(facts: PackFacts): PackSection[] {
  const { pack } = facts;
  const hosting = service(facts, "Hosting");
  const database = service(facts, "Database");
  const storage = service(facts, "File storage");
  const sanctions = facts.sanctions;
  const listLine = !sanctions.realList
    ? `Sanctions list: ${NOT_IN_PLACE}. A short built-in list stands in, and that is not real screening.`
    : sanctions.mode === "treasury"
      ? "Sanctions list: the US Treasury SDN list with its aliases, downloaded and matched on UPB's servers. No names are sent out."
      : "Sanctions list: a screening vendor, which receives the names screened.";
  return [
    {
      heading: "Who UPB is",
      lines: [
        ...(facts.whatUpbIs.length ? facts.whatUpbIs : ["The terms of use at /terms say what UPB does and does not do."]),
        `Is UPB a fund? ${facts.fundAnswer}`,
      ],
    },
    {
      heading: "Data held and where",
      lines: [
        ...(facts.dataHeld.length ? ["What the privacy policy says UPB collects, in its own words:", ...facts.dataHeld] : ["The privacy policy at /privacy says what UPB collects."]),
        `API calls: the time, the method, the path without the query's values, the status it was answered with and a keyed hash of the caller's address, for ${API_LOG_DAYS} days.`,
        `Servers: ${hosting && hosting.name !== "Not named" ? inline(hosting.name) : "a host the configuration doesn't name"}. Records: ${database?.inUse ? inline(database.name) : "a database on the application's own server"}. Files: ${storage?.inUse ? inline(storage.name) : "the application server's own disk"}.`,
        "UPB's configuration doesn't record the region where the servers, records and files are held.",
      ],
    },
    {
      heading: "Access controls",
      lines: [
        "Passwords are stored as bcrypt hashes. Desk staff must use an authenticator app for a second step at sign-in, with one-time recovery codes.",
        ...(facts.release ? [] : ["This site runs as a demo desk, where the seeded demo seats are exempt from the second step."]),
        facts.twoStepForAll
          ? "Every approved account that can see borrower data must set up the second step too."
          : "Other accounts can turn on the second step from their security page. The desk does not require it of them today.",
        "A session lives on the server for up to 14 days, and each signed-in device can be seen and ended from the account's security page. Sign-in, sign-up, password resets, codes and the API are rate limited.",
        `Desk staff each hold one role: ${DESK_ROLES.map((role) => `${DESK_ROLE_LABELS[role]} (${DESK_ROLE_HINTS[role].replace(/\.$/, "")})`).join("; ")}.`,
        "The sealed-bid wall: on a sealed or best-and-final listing, a bid's amount before the deadline is only for desk staff whose role reads sealed bids. Staff who buy for UPB's own book stay behind the wall until the listing leaves the market. A seller sees who bid on a sealed listing, not the amount, until the deadline.",
        "New wire instructions take effect only when a second desk member who approves wires approves them. The person who proposed a change can't approve it.",
        `Firm seats: each person at a firm signs in with their own seat, password and second factor, under one of four roles: ${SEAT_ROLES.map((role) => `${SEAT_ROLE_LABELS[role]} (${SEAT_ROLE_HINTS[role].replace(/\.$/, "")})`).join("; ")}. The audit log names the seat that acted.`,
        "A buyer signs the listing's NDA before the street address, the borrower and the data-room files open. Once a listing is under contract, its room closes to every bidder but the deal's own buyers.",
        `API keys are stored only as hashes, carry scopes, and each may make ${API_LIMIT.requests} requests a minute.`,
      ],
    },
    {
      heading: "Encryption",
      lines: [
        facts.https
          ? "In transit: the site's address is https, and every response tells browsers to use https for a year (Strict-Transport-Security)."
          : "In transit: the site's configured address is not https, so the site doesn't tell browsers to insist on https. Encryption in transit depends on the host in front of it.",
        facts.secureCookies ? "Session cookies are sent over https only." : "In this configuration, session cookies are not limited to https.",
        "At rest: per the hosting and database provider's defaults. UPB's own configuration doesn't set encryption at rest.",
        "Webhooks are signed with HMAC-SHA256 and go only to public https addresses.",
      ],
    },
    {
      heading: "Logging and audit",
      lines: [
        `Sign-ins, failed sign-ins, approvals, sanctions decisions, wire changes, closing steps, downloads and exports are written to an audit log the desk keeps for ${facts.retentionYears} years. Each event names the person who acted.`,
        "Every download from a data room is logged, and the seller, the broker and the desk can download the room's access log.",
        API_LOG_LINE,
        "There is no automated security monitoring. The desk reads the logs and is emailed when a sanctions screen needs review.",
      ],
    },
    {
      heading: "Sanctions screening",
      lines: [
        "The desk screens names against the OFAC sanctions list at sign-up, on a buyer file, when a tape arrives, and again at approval, covering sellers, buyers, brokers' clients and named borrowers.",
        "A possible match stops approval, awards and closing steps until a person decides it, with a reason that stays on the record.",
        listLine,
        sanctions.lastVersion && sanctions.lastScreenedAt
          ? `List version: the last screen, on ${day(sanctions.lastScreenedAt)}, ran against "${sanctions.lastVersion}". Each screen stores the copy of the list it ran against.`
          : "List version: no screen is on record yet. Each screen stores the copy of the list it ran against.",
      ],
    },
    {
      heading: "Retention and deletion",
      lines: [
        `Deal records are kept for ${facts.retentionYears} years: closings, signed papers, NDAs, the ledger and the audit log. Site visit logs and read notices are removed after that.`,
        `Sanctions screening records are kept for at least ${SANCTIONS_RECORD_YEARS} years, whatever period applies to deal records. That is UPB's reading of OFAC's recordkeeping rule, for counsel to confirm.`,
        `API calls are removed after ${API_LOG_DAYS} days by a daily job.`,
        "An account holder can ask for deletion from their security page. The desk removes the name, email, phone, company and second factor, signs out every device, and deletes saved searches, buy boxes, API keys and webhooks. Deal records stay, under an account with no name.",
        "A deletion waits while the account has an open bid, an open closing, a live listing, an unfunded group seat, or an open or confirmed sanctions match.",
      ],
    },
    {
      heading: "Incidents",
      lines: [
        `Incident contact: ${pack.incidentContact ?? NOT_SET}.`,
        facts.breachLine ? `The privacy policy says: "${facts.breachLine}"` : "The privacy policy makes no statement about breaches.",
        `A written incident response plan, and a notice period promised to institutions: ${NOT_IN_PLACE}.`,
        facts.securityContact
          ? `Security problems can be reported to ${facts.securityContact}, as the /security page says.`
          : "No address for reporting security problems is configured. The /security page points to the privacy policy's contact.",
      ],
    },
    {
      heading: "Business continuity",
      lines: [
        `Recovery time objective: ${pack.rtoHours != null ? `${hoursText(pack.rtoHours)}, as set by the desk` : NOT_SET}.`,
        `Recovery point objective: ${pack.rpoHours != null ? `${hoursText(pack.rpoHours)}, as set by the desk` : NOT_SET}.`,
        `Backups: ${backupLine(facts)}`,
        `A written business continuity and disaster recovery plan, and a recorded restore test: ${NOT_IN_PLACE}.`,
      ],
    },
    {
      heading: "Outside testing and audits",
      lines: [
        pack.penTestDate && pack.penTestFirm
          ? `Penetration test: the last outside test was on ${pack.penTestDate}, by ${pack.penTestFirm}, as recorded by the desk. The report itself isn't part of this pack.`
          : `Penetration test: ${NOT_IN_PLACE}. No outside firm has tested these controls.`,
        `SOC 2 report: ${NOT_IN_PLACE}.`,
        `A written information security programme: ${NOT_IN_PLACE}. The /security page and this pack state the controls in plain words.`,
      ],
    },
    {
      heading: "Insurance",
      lines: [`Cyber insurance: ${pack.cyberInsurer ? `${pack.cyberInsurer}, as recorded by the desk` : NOT_SET}.`],
    },
    {
      heading: "Document versions",
      lines: [
        `Terms of use and privacy policy: version ${facts.terms.version}, which every account accepts.`,
        `Terms of use text: ${facts.terms.updatedAt ? `last changed ${day(facts.terms.updatedAt)}` : "the built-in text"}${facts.terms.draft ? ", marked as a draft under counsel review" : ""}.`,
        `Privacy policy text: ${facts.privacy.updatedAt ? `last changed ${day(facts.privacy.updatedAt)}` : "the built-in text"}${facts.privacy.draft ? ", marked as a draft under counsel review" : ""}.`,
        `This pack: format ${PACK_VERSION}, read on ${facts.asOf.toISOString().slice(0, 16).replace("T", " ")} UTC.`,
      ],
    },
  ];
}

export function packFooter(facts: PackFacts) {
  return `UPB Capital's own statement, ${prettyDate(facts.asOf)}, read from the code and configuration it runs with. Not an audit or a certification. For counsel and security review.`;
}

// Everything the PDF says, as plain text, for a check that nothing was invented.
export function packText(facts: PackFacts) {
  const services = facts.services.map((row) => `${row.category}: ${row.inUse ? `In use. ${row.name}.` : "Not in use."} ${row.detail}`);
  return [
    ...packSections(facts).flatMap((part) => [part.heading, ...part.lines]),
    "Outside services",
    ...services,
    packFooter(facts),
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// The questionnaire: common vendor-review questions in UPB's own words, each answered Yes, No or Partial from the
// same facts as the pack. A Yes only ever comes from a control the code has or a fact the desk recorded.

export type Answer = "Yes" | "No" | "Partial";
export type QuestionRow = { id: string; area: string; question: string; answer: Answer; explanation: string };

export function questionnaire(facts: PackFacts): QuestionRow[] {
  const { pack } = facts;
  const inUse = facts.services.filter((row) => row.inUse);
  const hosting = service(facts, "Hosting");
  const rows: [string, string, Answer, string][] = [];
  const area = (name: string, items: [string, Answer, string][]) => items.forEach(([question, answer, explanation]) => rows.push([name, question, answer, explanation]));

  area("Access control", [
    ["Are user passwords stored only as one-way hashes?", "Yes", "Passwords are stored as bcrypt hashes."],
    [
      "Must staff with administrative access use a second sign-in factor?",
      facts.release ? "Yes" : "Partial",
      `Desk staff must use an authenticator app at sign-in, with one-time recovery codes.${facts.release ? "" : " On this demo desk the seeded demo seats are exempt."}`,
    ],
    [
      "Must client accounts that can see borrower data use a second sign-in factor?",
      facts.twoStepForAll ? "Yes" : "Partial",
      facts.twoStepForAll ? "Every approved account that can see borrower data must set up an authenticator." : "It is available on every account, but the desk does not require it today.",
    ],
    ["Is staff access granted by role, with each role limited to its work?", "Yes", `Desk roles: ${DESK_ROLES.map((role) => DESK_ROLE_LABELS[role]).join(", ")}. Only an owner sets them.`],
    [
      "Are conflicting duties kept apart?",
      "Yes",
      "Staff who buy for UPB's own book never read sealed bids. A wire-instruction change needs a second desk member's approval, and its proposer can't approve it.",
    ],
    ["Can a client firm give each of its people their own login with limited rights?", "Yes", `Firm seats, each with its own password and second factor, under the roles ${SEAT_ROLES.map((role) => SEAT_ROLE_LABELS[role]).join(", ")}.`],
    ["Are sessions time-limited, and can a user end them?", "Yes", "A session lasts up to 14 days on the server. Each signed-in device can be ended from the account's security page."],
    ["Are sign-in, password-reset and API attempts rate limited?", "Yes", `Sign-in, sign-up, password resets and codes are rate limited, and each API key may make ${API_LIMIT.requests} requests a minute.`],
    ["Is confidential loan data held back until a confidentiality agreement is signed?", "Yes", "Street addresses, borrowers and data-room files open only after the listing's NDA. The room closes to other bidders once the listing is under contract."],
    ["Are API credentials stored only as hashes and limited by scope?", "Yes", "Keys are stored as SHA-256 hashes. Each carries the scopes picked when it was minted."],
    [
      "Are staff and client access rights reviewed on a schedule?",
      "Partial",
      "Buyer files are re-certified each year. There is no scheduled review of desk staff roles; an owner sets them on the staff page.",
    ],
  ]);

  area("Encryption", [
    [
      "Is data encrypted in transit over public networks?",
      facts.https && facts.secureCookies ? "Yes" : "Partial",
      [
        facts.https ? "The site's address is https and it sends Strict-Transport-Security." : "The configured address is not https, so encryption in transit depends on the host in front of the site.",
        facts.secureCookies ? "Session cookies are https-only." : "Session cookies are not limited to https in this configuration.",
      ].join(" "),
    ],
    ["Is data encrypted at rest?", "Partial", "Per the hosting and database provider's defaults. UPB's own configuration doesn't set encryption at rest."],
    ["Are outgoing webhooks signed?", "Yes", "Signed with HMAC-SHA256 in x-upb-signature, and sent only to public https addresses."],
    [
      "Are browser security headers set on every response?",
      "Partial",
      `nosniff, a referrer policy, frame-ancestors 'none' and a permissions policy are sent${facts.https ? ", with Strict-Transport-Security" : ""}. There is no script Content-Security-Policy yet.`,
    ],
  ]);

  area("Logging", [
    ["Are sign-ins, failed sign-ins and administrative actions logged, with who acted?", "Yes", "They go to the desk's audit log, which names the account and, for a firm, the seat."],
    ["Are downloads of confidential files logged?", "Yes", "Every data-room download is logged, and the seller, the broker and the desk can download that log."],
    ["Are API calls logged one by one?", "Yes", API_LOG_LINE],
    ["Are audit records kept for a set period?", "Yes", `The audit log is kept for ${facts.retentionYears} years with the other deal records.`],
    ["Are logs watched by automated alerting or a SIEM?", "No", "There is no automated security monitoring. The desk reads the logs and is emailed when a sanctions screen needs review."],
  ]);

  area("Incident response", [
    ["Is there a written incident response plan?", "No", `${NOT_IN_PLACE}.`],
    [
      "Will clients be told of a breach that affects them?",
      facts.breachLine ? "Partial" : "No",
      facts.breachLine ? `The privacy policy says: "${facts.breachLine}" No notice period is promised.` : "The privacy policy makes no statement about breaches.",
    ],
    ["Is a notice period for incidents promised to institutional clients?", "No", `${NOT_IN_PLACE}.`],
    ["Is there a named contact for security incidents?", pack.incidentContact ? "Yes" : "No", pack.incidentContact ? `${pack.incidentContact}, as recorded by the desk.` : `${NOT_SET}.`],
    [
      "Can anyone report a security problem?",
      facts.securityContact ? "Yes" : "Partial",
      facts.securityContact ? `At ${facts.securityContact}, as the /security page says.` : "The /security page asks for reports but no reporting address is configured.",
    ],
  ]);

  area("Business continuity", [
    ["Is there a written business continuity and disaster recovery plan?", "No", `${NOT_IN_PLACE}.`],
    ["Is a recovery time objective set?", pack.rtoHours != null ? "Yes" : "No", pack.rtoHours != null ? `${hoursText(pack.rtoHours)}, as set by the desk.` : `${NOT_SET}.`],
    ["Is a recovery point objective set?", pack.rpoHours != null ? "Yes" : "No", pack.rpoHours != null ? `${hoursText(pack.rpoHours)}, as set by the desk.` : `${NOT_SET}.`],
    [
      "Are the platform's records backed up?",
      "Partial",
      `${backupLine(facts).charAt(0).toUpperCase()}${backupLine(facts).slice(1)}`,
    ],
    ["Have recovery procedures been tested?", "No", `No restore test is on record. ${NOT_IN_PLACE}.`],
  ]);

  area("Vendors", [
    [
      "Is there a current list of outside services that handle client data?",
      "Yes",
      `Read from the live configuration on /security and in the vendor pack. In use: ${inUse.map((row) => `${row.category} (${row.name})`).join(", ") || "none"}. The region where data is held isn't recorded.`,
    ],
    ["Is the hosting provider named?", hosting && hosting.name !== "Not named" ? "Yes" : "No", hosting && hosting.name !== "Not named" ? `${hosting.name}.` : "The configuration doesn't name the host (HOSTING_PROVIDER)."],
    ["Does each listed service say what data it receives?", "Yes", "Each row on /security and in the pack says what the service receives."],
    [
      "Do loan files go to an AI model provider?",
      facts.modelReadsFiles ? "Yes" : "No",
      facts.modelReadsFiles ? `The document reader sends loan files to ${service(facts, "AI")?.name ?? "the model provider"}.` : "No loan file leaves UPB for an AI provider in this configuration.",
    ],
    [
      "Is screening done against a real sanctions list?",
      facts.sanctions.realList ? "Yes" : "No",
      facts.sanctions.realList ? (facts.sanctions.mode === "treasury" ? "The US Treasury SDN list with its aliases." : "A screening vendor's list.") : "A short built-in list stands in. That is not real screening.",
    ],
  ]);

  area("Data retention", [
    ["Is there a set retention period for deal records?", "Yes", `${facts.retentionYears} years for closings, signed papers, NDAs, the ledger and the audit log.`],
    [`Are sanctions screening records kept for at least ${SANCTIONS_RECORD_YEARS} years?`, "Yes", `A floor of ${SANCTIONS_RECORD_YEARS} years whatever the deal-record period. UPB's reading of 31 CFR 501.601, for counsel to confirm.`],
    [
      "Can a client ask for their data to be deleted?",
      "Yes",
      "From the account's security page. Personal details are removed and deal records stay under an account with no name. A deletion waits on an open bid, closing, live listing, unfunded group seat or sanctions match.",
    ],
    ["Are routine logs removed on a schedule?", "Yes", `A daily job removes site visit logs and read notices after ${facts.retentionYears} years, and API calls after ${API_LOG_DAYS} days.`],
    ["Are bidders asked to destroy confidential files when a sale ends?", "Yes", "Each bidder whose room opened is asked to certify they destroyed the files, and the seller gets a certificate."],
    ["Is the caller's network address kept in the API log?", "No", "Only a keyed hash of the address is kept."],
  ]);

  area("Assurance", [
    ["Does UPB have a SOC 2 report?", "No", `${NOT_IN_PLACE}.`],
    [
      "Has an outside firm run a penetration test in the last 12 months?",
      pack.penTestDate && pack.penTestFirm ? (penTestRecent(facts) ? "Yes" : "Partial") : "No",
      pack.penTestDate && pack.penTestFirm
        ? `On ${pack.penTestDate}, by ${pack.penTestFirm}, as recorded by the desk.${penTestRecent(facts) ? "" : " That is more than a year ago."}`
        : `${NOT_IN_PLACE}. No outside firm has tested these controls.`,
    ],
    ["Does UPB carry cyber insurance?", pack.cyberInsurer ? "Yes" : "No", pack.cyberInsurer ? `${pack.cyberInsurer}, as recorded by the desk.` : `${NOT_SET}.`],
    ["Is there a written information security programme?", "Partial", `The /security page and this pack state the controls in plain words. A written programme: ${NOT_IN_PLACE}.`],
    [
      "Are the terms of use and privacy policy published and versioned?",
      "Yes",
      `Version ${facts.terms.version}, which every account accepts.${facts.terms.draft || facts.privacy.draft ? " The text is marked as a draft under counsel review." : ""}`,
    ],
  ]);

  const prefix: Record<string, string> = {
    "Access control": "AC",
    Encryption: "EN",
    Logging: "LG",
    "Incident response": "IR",
    "Business continuity": "BC",
    Vendors: "VM",
    "Data retention": "DR",
    Assurance: "AS",
  };
  const counts = new Map<string, number>();
  return rows.map(([name, question, answer, explanation]) => {
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    return { id: `${prefix[name]}-${String(count).padStart(2, "0")}`, area: name, question, answer, explanation };
  });
}

export function questionnaireCsv(facts: PackFacts) {
  const asOf = day(facts.asOf);
  return toCsv(questionnaire(facts).map((row) => ({ id: row.id, area: row.area, question: row.question, answer: row.answer, explanation: row.explanation, as_of: asOf, source: "UPB Capital's own statement, for counsel and security review" })));
}

// ---------------------------------------------------------------------------------------------------------------
// The PDF, made as the board pack's is.

export async function vendorPackPdf(facts: PackFacts) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const gold = rgb(0.776, 0.643, 0.431);
  const ink = rgb(0.12, 0.11, 0.09);
  const soft = rgb(0.4, 0.38, 0.34);
  const left = 48;
  const width = 516;
  let page: PDFPage = pdf.addPage([612, 792]);
  let y = 0;
  const fresh = () => {
    page = pdf.addPage([612, 792]);
    y = 744;
  };
  const room = (needed: number) => {
    if (y - needed < 56) fresh();
  };
  const para = (value: string, size = 9.5, face: PDFFont = font, color = ink, indent = 0) => {
    const lines = wrap(pdfSafe(value, face), face, size, width - indent);
    for (const line of lines) {
      room(size + 4);
      page.drawText(line, { x: left + indent, y, size, font: face, color });
      y -= size + 3.5;
    }
  };
  const heading = (value: string) => {
    room(44);
    y -= 6;
    page.drawText(pdfSafe(value, bold), { x: left, y, size: 12, font: bold, color: gold });
    y -= 17;
  };

  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: rgb(0.03, 0.03, 0.04) });
  page.drawText("UPB CAPITAL  ·  VENDOR PACK", { x: left, y: 762, size: 11, font, color: gold });
  y = 704;
  para("Security and third-party risk review", 20, bold);
  y -= 4;
  para(`As of ${prettyDate(facts.asOf)}. Read from the code and the configuration UPB Capital runs with, and from the facts the desk records. Where a fact is missing, the pack says so.`, 10, font, soft);
  y -= 6;

  const sections = packSections(facts);
  const [who, ...rest] = sections;
  // A dash at the margin, with the text and its wrapped lines indented under it.
  const bullet = (value: string) => {
    room(14);
    page.drawText("-", { x: left, y, size: 9.5, font, color: soft });
    para(value, 9.5, font, ink, 10);
    y -= 2;
  };
  const draw = (part: PackSection) => {
    heading(part.heading);
    part.lines.forEach(bullet);
  };
  draw(who);
  heading("Outside services");
  para("Read from the configuration this site runs with today. A service marked not in use receives nothing.", 9, font, soft);
  y -= 4;
  for (const row of facts.services) {
    room(30);
    para(`${row.category}: ${row.inUse ? `in use, ${inline(row.name)}` : "not in use"}`, 9.5, bold);
    para(row.detail, 9, font, soft, 10);
    y -= 3;
  }
  rest.forEach(draw);

  const pages = pdf.getPages();
  const footer = packFooter(facts);
  pages.forEach((each, index) => {
    const lines = wrap(pdfSafe(`${footer} Page ${index + 1} of ${pages.length}.`, font), font, 8, width);
    lines.forEach((line, row) => each.drawText(line, { x: left, y: 34 - row * 10, size: 8, font, color: soft }));
  });
  return Buffer.from(await pdf.save());
}

// ---------------------------------------------------------------------------------------------------------------
// Who may download it, and the download itself

type PackReader = Staff & { id: string; accountStatus: string; deletedAt?: Date | null };

export const PACK_REQUEST = "Banks and credit unions reviewing UPB can ask the desk for the vendor pack.";

// Approved institutional sellers, approved buyers and the desk. Everyone else asks the desk.
export function packRefusal(user: PackReader | null): { status: 401 | 403; error: string } | null {
  if (!user) return { status: 401, error: `Sign in to download the vendor pack. ${PACK_REQUEST}` };
  if (user.deletedAt) return { status: 403, error: PACK_REQUEST };
  if (user.role === "ADMIN") return null;
  if ((user.role === "BUYER" || user.role === "INSTITUTIONAL_SELLER") && user.accountStatus === "APPROVED") return null;
  return { status: 403, error: `The vendor pack is for approved institutions and buyers. ${PACK_REQUEST}` };
}

export type PackFormat = "pdf" | "csv";

// The route's answer. Each download is audited with its format and date.
export async function packDownload(user: PackReader | null, format: string | null, options: { now?: Date; env?: Env } = {}) {
  const refused = packRefusal(user);
  if (refused || !user) return new Response(refused?.error ?? PACK_REQUEST, { status: refused?.status ?? 401, headers: { "Cache-Control": "private, no-store" } });
  const kind = (format || "pdf").toLowerCase();
  if (kind !== "pdf" && kind !== "csv") return new Response("Ask for format=pdf or format=csv.", { status: 400 });
  const facts = await packFacts(options);
  const name = `upb-vendor-pack-${day(facts.asOf)}`;
  await audit(user.id, "VENDOR_PACK_DOWNLOAD", "settings", "vendor-pack", `${kind === "csv" ? "Questionnaire CSV" : "PDF"}, as of ${day(facts.asOf)}`);
  if (kind === "csv") {
    return new Response(questionnaireCsv(facts), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}-questionnaire.csv"`, "Cache-Control": "private, no-store" },
    });
  }
  return new Response(new Uint8Array(await vendorPackPdf(facts)), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}.pdf"`, "Cache-Control": "private, no-store" },
  });
}
