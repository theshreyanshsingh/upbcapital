import { inflateSync, constants as zlib } from "node:zlib";
import { after } from "next/server";
import Papa from "papaparse";
import { isPrivateDocument } from "@/lib/acl";
import { audit } from "@/lib/audit";
import { unset } from "@/lib/db-filters";
import { llmConfig, modelJson } from "@/lib/desk-ai";
import { answerable, deskResolveDiscrepancy, raiseDiscrepancy } from "@/lib/discrepancies";
import { money, prettyDate } from "@/lib/format";
import { LIEN_POSITIONS } from "@/lib/labels";
import { canonical, exactValue, fieldSpec, markFieldVerified, sameReading, tapeValue, type FieldSpec, type Outcome } from "@/lib/loan-file";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { getBytes, putBytes } from "@/lib/storage";

// The desk's document reader. It reads each file in a listing's data room and loan file, pulls out the loan facts the
// tape claims, and sets each one beside the tape with the words it read. The reader reads; the desk confirms. A
// finding never verifies a field on its own: a person confirms it, and only then is the field marked verified.

const fail = (error: string): Outcome<never> => ({ ok: false, error });

// ---------------------------------------------------------------------------------------------------------
// What the reader looks for

export const READ_FIELDS = [
  "upb",
  "interestRate",
  "monthlyPi",
  "originalBalance",
  "originationDate",
  "maturityDate",
  "lastPaidDate",
  "borrowerName",
  "streetAddress",
  "lienPosition",
  "estimatedValue",
] as const;
export type ReadField = (typeof READ_FIELDS)[number];

export function isReadField(field: string): field is ReadField {
  return (READ_FIELDS as readonly string[]).includes(field);
}

// The original balance isn't a tape column. The reader notes it for the desk and never compares it.
const ORIGINAL_BALANCE: FieldSpec = { field: "originalBalance", label: "Original balance", kind: "money", pro: true, source: "Original note" };

export function readSpec(field: string): FieldSpec | null {
  if (field === "originalBalance") return ORIGINAL_BALANCE;
  return isReadField(field) ? fieldSpec(field) : null;
}

export function readLabel(field: string) {
  return readSpec(field)?.label ?? field;
}

const MONEY_FIELDS = new Set<string>(["upb", "monthlyPi", "originalBalance", "estimatedValue"]);
const DATE_FIELDS = new Set<string>(["originationDate", "maturityDate", "lastPaidDate"]);
// A published answer goes to every bidder in the room, whatever the loan's own access rule, so drafts leave these out.
const IDENTITY_FIELDS = new Set<string>(["borrowerName", "streetAddress"]);

// ---------------------------------------------------------------------------------------------------------
// Reading values out of words

type Hit = { at: number; value: string };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const MONTH_FIRST = new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi");
const DAY_FIRST = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:day\\s+of\\s+)?${MONTH}\\.?,?\\s+(\\d{4})\\b`, "gi");

function isoDay(year: number, month: number, day: number): string | null {
  const full = year < 100 ? year + (year < 70 ? 2000 : 1900) : year;
  if (month < 1 || month > 12 || day < 1 || day > 31 || full < 1900 || full > 2100) return null;
  const date = new Date(Date.UTC(full, month - 1, day));
  // February 30th rolls into March, so it isn't a date.
  return date.getUTCMonth() === month - 1 ? date.toISOString().slice(0, 10) : null;
}

const monthNumber = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;

function dateHits(text: string): Hit[] {
  const hits: Hit[] = [];
  const add = (at: number, value: string | null) => {
    if (value) hits.push({ at, value });
  };
  for (const m of text.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) add(m.index ?? 0, isoDay(Number(m[1]), Number(m[2]), Number(m[3])));
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g)) add(m.index ?? 0, isoDay(Number(m[3]), Number(m[1]), Number(m[2])));
  for (const m of text.matchAll(MONTH_FIRST)) add(m.index ?? 0, isoDay(Number(m[3]), monthNumber(m[1]), Number(m[2])));
  for (const m of text.matchAll(DAY_FIRST)) add(m.index ?? 0, isoDay(Number(m[3]), monthNumber(m[2]), Number(m[1])));
  return hits.sort((a, b) => a.at - b.at);
}

const GROUPED = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

// Amounts in the words: a dollar sign, thousands commas or cents. A bare "2049" or "1" isn't money, and the parts
// of a date or a percent aren't either. `loose` also takes a bare number, for a quote already known to be the value.
function moneyHits(text: string, loose = false): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(/(\$\s?|usd\s?)?(\d[\d,]*(?:\.\d+)?)(\s*%)?/gi)) {
    const at = m.index ?? 0;
    const body = m[2].replace(/[.,]$/, "");
    if (m[3]) continue;
    const before = text[at - 1] ?? "";
    const after = text[at + m[0].length] ?? "";
    if (before === "/" || before === "-" || after === "/" || (after === "-" && /\d/.test(text[at + m[0].length + 1] ?? ""))) continue;
    const marked = Boolean(m[1]);
    const shaped = body.includes(",") ? GROUPED.test(body) : /\.\d{2}$/.test(body);
    if (body.includes(",") && !GROUPED.test(body)) continue;
    if (!marked && !shaped && !loose) continue;
    const value = Number(body.replace(/,/g, ""));
    if (Number.isFinite(value) && value >= 0) hits.push({ at, value: String(Math.round(value * 100) / 100) });
  }
  return hits;
}

function rateHits(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(/(\d{1,2}(?:\.\d+)?|\.\d+)\s*(?:%|percent\b|per cent\b)/gi)) {
    const value = Number(m[1]);
    if (Number.isFinite(value) && value > 0 && value <= 30) hits.push({ at: m.index ?? 0, value: String(Math.round(value * 10000) / 10000) });
  }
  return hits;
}

function lienHits(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const m of text.matchAll(/\b(first|1st|second|2nd|third|3rd)\b/gi)) {
    const word = m[1].toLowerCase();
    hits.push({ at: m.index ?? 0, value: word.startsWith("f") || word === "1st" ? "FIRST" : word.startsWith("s") || word === "2nd" ? "SECOND" : "THIRD" });
  }
  return hits;
}

// A name as the document gives it, without a defined-term tag such as ("Borrower").
function cleanName(text: string) {
  const name = text
    .replace(/\s*\(\s*(?:the\s+)?["“”']?[a-z\s]*["“”']?\s*\)\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:]+$/, "");
  return /[a-z]/i.test(name) && name.length <= 120 ? name : null;
}

// The street alone: the city, state and ZIP after the first comma are other tape columns.
function cleanStreet(text: string) {
  const street = text.split(",")[0].replace(/\s+/g, " ").trim().replace(/[.;:]+$/, "");
  return /^\d/.test(street) && /[a-z]/i.test(street) && street.length >= 3 && street.length <= 120 ? street : null;
}

// How close to the label a value has to start. Further along, the line is a sentence about something else. After a
// colon the line is the label's own, so a deed's "Maturity: This debt is due in full on April 1, 2048" still reads.
const NEAR = 24;
const NEAR_AFTER_COLON = 80;

// The field's value from the words that follow its label, or null when they don't state one.
function valueAfterLabel(field: ReadField, text: string, near = NEAR): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (MONEY_FIELDS.has(field)) {
    if (/^\$?\s?\d[\d,]*(?:\.\d+)?$/.test(trimmed) && (!trimmed.includes(",") || GROUPED.test(trimmed.replace(/^\$\s?/, "")))) {
      return String(Math.round(Number(trimmed.replace(/[$,\s]/g, "")) * 100) / 100);
    }
    const hit = moneyHits(trimmed)[0];
    return hit && hit.at <= near ? hit.value : null;
  }
  if (field === "interestRate") {
    const hit = rateHits(trimmed)[0];
    if (hit) return hit.at <= near ? hit.value : null;
    // A bare rate: 5.875, or 0.05875 written as a decimal.
    const bare = /^(\d{1,2}(?:\.\d+)?|0?\.\d+)(?![\d/,-])/.exec(trimmed);
    if (!bare) return null;
    const number = Number(bare[1]);
    const rate = number < 1 ? number * 100 : number;
    return rate > 0 && rate <= 30 ? String(Math.round(rate * 10000) / 10000) : null;
  }
  if (DATE_FIELDS.has(field)) {
    const hit = dateHits(trimmed)[0];
    return hit && hit.at <= near ? hit.value : null;
  }
  if (field === "lienPosition") {
    const hit = lienHits(trimmed)[0];
    return hit && hit.at <= near ? hit.value : null;
  }
  if (field === "borrowerName") return cleanName(trimmed);
  return cleanStreet(trimmed);
}

// A value given in any spelling, as the reader stores it: a plain number, a percent number, an ISO date, a lien
// position, or the words. Null when it doesn't read as the field's kind.
export function readValue(field: string, raw: unknown): string | null {
  if (!isReadField(field) || raw == null) return null;
  return valueAfterLabel(field, String(raw));
}

// Every value of the field's kind in a stretch of words, for checking that a quote says what a model claims.
function valuesIn(field: ReadField, text: string): string[] {
  if (MONEY_FIELDS.has(field)) return moneyHits(text, true).map((hit) => hit.value);
  if (field === "interestRate") {
    const rates = rateHits(text).map((hit) => hit.value);
    const bare = valueAfterLabel(field, text.replace(/^[^\d]*/, ""));
    return bare ? [...rates, bare] : rates;
  }
  if (DATE_FIELDS.has(field)) return dateHits(text).map((hit) => hit.value);
  if (field === "lienPosition") return lienHits(text).map((hit) => hit.value);
  return [];
}

const STREET_WORDS: Record<string, string> = {
  avenue: "ave", street: "st", road: "rd", drive: "dr", boulevard: "blvd", lane: "ln", court: "ct", circle: "cir", place: "pl",
  terrace: "ter", parkway: "pkwy", highway: "hwy", trail: "trl", square: "sq", apartment: "apt", suite: "ste", unit: "unit",
  north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
};

export function streetKey(text: string) {
  return text
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => STREET_WORDS[word] ?? word)
    .join(" ");
}

export function nameKey(text: string) {
  return text.toLowerCase().replace(/&/g, " and ").replace(/[.,'"’]/g, "").replace(/\s+/g, " ").trim();
}

// Two readings of a field say the same thing: money within a dollar, a rate within a thousandth of a point, a date
// to the day, a lien by position, and words by their letters.
export function sameRead(field: string, a: string | null | undefined, b: string | null | undefined) {
  if (a == null || b == null || a === "" || b === "") return false;
  if (MONEY_FIELDS.has(field)) return Math.abs(Number(a) - Number(b)) <= 1;
  if (field === "interestRate") return Math.abs(Number(a) - Number(b)) <= 0.001 + 1e-9;
  if (DATE_FIELDS.has(field)) return a.slice(0, 10) === b.slice(0, 10);
  if (field === "streetAddress") return streetKey(a) === streetKey(b);
  if (field === "borrowerName") return nameKey(a) === nameKey(b);
  return a.toUpperCase() === b.toUpperCase();
}

// ---------------------------------------------------------------------------------------------------------
// Getting words out of a file

const MAX_TEXT = 400_000;

// A file whose bytes decode cleanly as UTF-8, with almost no control characters, is text whatever its name says.
export function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const sample = text.slice(0, 20_000);
  let control = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    // Tab, line feed, form feed (a page break) and carriage return are text.
    if ((code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13) || code === 127) control += 1;
  }
  if (control > sample.length * 0.01) return null;
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").slice(0, MAX_TEXT);
}

export function isPdfBytes(bytes: Buffer) {
  return bytes.subarray(0, 5).toString("latin1") === "%PDF-";
}

function pdfLiteral(body: string) {
  return body.replace(/\\(\r?\n|[nrtbf()\\]|[0-7]{1,3})/g, (_, code: string) => {
    if (code.startsWith("\n") || code.startsWith("\r")) return "";
    const map: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
    return map[code] ?? String.fromCharCode(parseInt(code, 8));
  });
}

// A hex string is text only when its bytes are printable. An embedded font's glyph numbers aren't words.
function pdfHex(body: string) {
  const hex = body.replace(/\s+/g, "");
  const bytes = Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex");
  for (const byte of bytes) if (byte < 32 || (byte > 126 && byte < 160)) return "";
  return bytes.toString("latin1");
}

// The words a content stream draws, line by line, from its Tj and TJ operators.
function contentText(content: string) {
  let out = "";
  let strings: string[] = [];
  let numbers: number[] = [];
  let inArray = false;
  let lastY: number | null = null;
  const tokens = /\((?:\\[\s\S]|[^\\)])*\)|<[0-9A-Fa-f\s]*>|\[|\]|[-+]?\d*\.?\d+|[A-Za-z'"*]+/g;
  for (const match of content.matchAll(tokens)) {
    const token = match[0];
    if (token === "[") {
      inArray = true;
      strings = [];
    } else if (token === "]") {
      inArray = false;
    } else if (token.startsWith("(")) {
      strings.push(pdfLiteral(token.slice(1, -1)));
    } else if (token.startsWith("<")) {
      strings.push(pdfHex(token.slice(1, -1)));
    } else if (/^[-+]?\d*\.?\d+$/.test(token)) {
      // A wide gap inside a TJ array is a space between words.
      if (inArray && Number(token) < -200) strings.push(" ");
      else numbers.push(Number(token));
    } else {
      if (token === "Tj" || token === "TJ") out += strings.join("");
      else if (token === "'" || token === '"') out += `\n${strings.join("")}`;
      else if (token === "Td" || token === "TD") out += numbers.length >= 2 && numbers[numbers.length - 1] !== 0 ? "\n" : " ";
      else if (token === "Tm") {
        const y = numbers.length >= 6 ? numbers[numbers.length - 1] : null;
        out += y != null && lastY != null && y === lastY ? " " : "\n";
        lastY = y;
      } else if (token === "T*" || token === "ET") out += "\n";
      strings = [];
      numbers = [];
    }
  }
  return out;
}

// Digital PDFs carry their words in content streams. This pulls out what is drawn, so a model's quote can be checked
// against the file. A scan, or a font with its own encoding, gives little or nothing, and then no quote is checked.
export function pdfText(bytes: Buffer): string {
  const raw = bytes.toString("latin1");
  const parts: string[] = [];
  let from = 0;
  for (;;) {
    const start = raw.indexOf("stream", from);
    if (start < 0) break;
    from = start + 6;
    if (raw.slice(start - 3, start) === "end") continue;
    const open = raw[start + 6] === "\r" ? start + 8 : start + 7;
    const end = raw.indexOf("endstream", open);
    if (end < 0) break;
    from = end + 9;
    const header = raw.slice(Math.max(0, raw.lastIndexOf(" obj", start)), start);
    if (/\/(?:Image|FontFile\d?|Length1|XRef|ObjStm|Metadata)\b/.test(header)) continue;
    let content = raw.slice(open, end);
    if (header.includes("/FlateDecode")) {
      try {
        content = inflateSync(Buffer.from(content, "latin1"), { finishFlush: zlib.Z_SYNC_FLUSH }).toString("latin1");
      } catch {
        continue;
      }
    }
    if (content.includes("BT")) parts.push(contentText(content));
  }
  const text = parts
    .join("\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return (text.match(/[a-z]/gi) ?? []).length >= 20 ? text.slice(0, MAX_TEXT) : "";
}

// Quotes are matched on their letters and spacing, so a curly quote or a line break inside one doesn't count against it.
function quoteKey(text: string) {
  return text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
}

export function quoteFound(text: string, quote: string) {
  const key = quoteKey(quote);
  return key.length >= 3 && quoteKey(text).includes(key);
}

// ---------------------------------------------------------------------------------------------------------
// The rules reader: labelled lines, offline

export type Finding = { field: ReadField; value: string; quote: string; page: number | null; confidence: number | null };

const LABELS: [ReadField, string[]][] = [
  ["originalBalance", ["original principal balance", "original principal amount", "original loan amount", "original note amount", "original balance", "original amount", "original upb", "loan amount", "principal amount", "principal sum"]],
  [
    "upb",
    [
      "current unpaid principal balance", "unpaid principal balance", "current principal balance", "outstanding principal balance", "principal balance",
      "unpaid principal", "unpaid balance", "outstanding balance", "current balance", "current upb", "upb",
      // A modification restates the balance it leaves.
      "new unpaid principal balance", "new principal balance", "modified principal balance",
    ],
  ],
  ["interestRate", ["current interest rate", "annual interest rate", "interest rate", "note rate", "current rate", "rate of interest", "coupon rate", "modified interest rate", "new interest rate", "rate"]],
  [
    "monthlyPi",
    [
      "monthly principal and interest payment", "monthly principal & interest payment", "monthly principal and interest", "monthly principal & interest",
      "principal and interest payment", "principal & interest payment", "principal and interest", "principal & interest", "monthly p&i payment",
      "monthly p&i", "p&i payment", "p & i", "p&i", "monthly payment amount", "monthly payment", "monthly installment",
      "new monthly principal and interest payment", "new principal and interest payment", "modified principal and interest payment",
    ],
  ],
  ["originationDate", ["loan origination date", "origination date", "date of origination", "date originated", "date of note", "note date", "originated"]],
  ["maturityDate", ["loan maturity date", "maturity date", "date of maturity", "final payment date", "matures", "maturity", "new maturity date", "modified maturity date"]],
  ["lastPaidDate", ["last payment received date", "last payment received", "date of last payment", "last payment date", "last paid date", "date last paid", "last paid"]],
  ["borrowerName", ["borrower name", "borrower names", "borrowers", "borrower", "mortgagor", "obligor"]],
  ["streetAddress", ["subject property address", "property address", "collateral address", "property location", "address of property", "site address", "subject property", "property"]],
  ["lienPosition", ["lien position", "lien priority", "lien"]],
  ["estimatedValue", ["as-is market value", "as-is value", "as is value", "as-is opinion", "opinion of value", "bpo value", "estimated value"]],
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Longest first, so "original principal balance" is never read as "principal balance".
const LABEL_PATTERNS = LABELS.flatMap(([field, labels]) => labels.map((label) => ({ field, label })))
  .sort((a, b) => b.label.length - a.label.length)
  .map(({ field, label }) => ({ field, pattern: new RegExp(`^(?:the\\s+)?${escape(label).replace(/\s+/g, "\\s+")}(?![a-z0-9])(?:\\s*\\([^)]{0,40}\\))?`, "i") }));

// Words a name or a street needs before it: a colon, a tab, a run of spaces or dot leaders. A number can follow its
// label more loosely ("As-is opinion $640,000"), since it still has to read as the field's kind.
const STRONG = /^\s*(?::|=|\t|\.{2,}|\s{2,}|[-–—]+\s)\s*/;
const LOOSE = /^\s+(?:is\s+|of\s+|was\s+)?(?=[$\d]|[a-z]{3,9}\.?\s+\d)/i;
// A few words may stand between a label and its colon: "Unpaid principal balance as of 10/01/2026: $312,400.00".
const QUALIFIED = /^\s+(?:per|as\s+of|according\s+to|from)\s[^:=\t]{1,40}?(?=\s*[:=])/i;

// A monthly payment that includes escrow isn't principal and interest.
const ESCROWED = /escrow|piti|taxes and insurance|tax(?:es)? & insurance/i;

type Segment = { text: string; quote: string; at: number };

// Lines broken into the cells a form lays out side by side: "Interest rate: 6.250%     Maturity date: 03/01/2051".
function segmentsOf(text: string, csv: boolean): Segment[][] {
  const lines: Segment[][] = [];
  let at = 0;
  // A form feed is a page break, so it ends a line too.
  for (const line of text.split(/[\n\f]/)) {
    const start = at;
    at += line.length + 1;
    const raw = line.replace(/\u00a0/g, " ");
    if (!raw.trim()) {
      lines.push([]);
      continue;
    }
    if (csv) {
      const cells = (Papa.parse<string[]>(raw, { skipEmptyLines: true }).data[0] ?? []).map((cell) => String(cell ?? "").trim());
      const filled = cells.filter(Boolean);
      lines.push(filled.length === 2 ? [{ text: `${filled[0]}: ${filled[1]}`, quote: raw.trim(), at: start }] : []);
      continue;
    }
    const cells = raw.split(/\t+|\s{3,}|\s\|\s/).map((cell) => cell.trim().replace(/^(?:[-*•·]|\d{1,2}[.)])\s+/, "")).filter(Boolean);
    lines.push(cells.map((cell) => ({ text: cell, quote: cell, at: start })));
  }
  return lines;
}

function pageAt(text: string, at: number) {
  let page = 1;
  for (let index = text.indexOf("\f"); index >= 0 && index < at; index = text.indexOf("\f", index + 1)) page += 1;
  return page;
}

// The labelled facts in a text, each with the line it came from. A field read twice with the same value is one
// finding; read with two values, both are kept at low confidence for the desk to settle.
export function extractFindings(text: string, options: { csv?: boolean } = {}): Finding[] {
  const lines = segmentsOf(text, Boolean(options.csv));
  const raw: { field: ReadField; value: string; quote: string; at: number }[] = [];
  for (let row = 0; row < lines.length; row += 1) {
    const cells = lines[row];
    for (let column = 0; column < cells.length; column += 1) {
      const cell = cells[column];
      const label = LABEL_PATTERNS.map(({ field, pattern }) => ({ field, match: pattern.exec(cell.text) })).find((entry) => entry.match);
      if (!label?.match) continue;
      const field = label.field;
      const rest = cell.text.slice(label.match[0].length);
      const kind = MONEY_FIELDS.has(field) || DATE_FIELDS.has(field) || field === "interestRate";
      const qualified = QUALIFIED.exec(rest);
      const after = qualified ? rest.slice(qualified[0].length) : rest;
      const strong = STRONG.exec(after);
      const loose = !strong && !qualified && kind ? LOOSE.exec(after) : null;
      let valueText: string | null = strong ? after.slice(strong[0].length) : loose ? after.slice(loose[0].length) : after.trim() || qualified ? null : "";
      if (valueText == null) continue;
      let quote = cell.quote;
      // A label alone takes its value from the next cell, or from the next line when the line is the label alone.
      if (!valueText.trim()) {
        const nextCell = cells[column + 1];
        const nextLine = lines[row + 1];
        if (nextCell && !LABEL_PATTERNS.some(({ pattern }) => pattern.test(nextCell.text))) {
          valueText = nextCell.text;
          quote = `${cell.quote} ${nextCell.quote}`;
          column += 1;
        } else if (cells.length === 1 && nextLine?.length === 1 && nextLine[0].text.length <= 60) {
          valueText = nextLine[0].text;
          quote = `${cell.quote} ${nextLine[0].quote}`;
        } else {
          continue;
        }
      }
      if (field === "monthlyPi" && ESCROWED.test(cell.text) && !/principal\s*(?:and|&)\s*interest|p\s*&\s*i/i.test(label.match[0])) continue;
      const value = valueAfterLabel(field, valueText, strong && /[:=]/.test(strong[0]) ? NEAR_AFTER_COLON : NEAR);
      if (value) raw.push({ field, value, quote: quote.slice(0, 300), at: cell.at });
    }
  }
  const findings: Finding[] = [];
  for (const field of READ_FIELDS) {
    const reads = raw.filter((entry) => entry.field === field);
    const distinct = reads.filter((entry, index) => reads.findIndex((other) => sameRead(field, other.value, entry.value)) === index);
    for (const entry of distinct) {
      findings.push({ field, value: entry.value, quote: entry.quote, page: pageAt(text, entry.at), confidence: distinct.length === 1 ? 0.9 : 0.5 });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------------------
// Readers

export type ReaderFile = { name: string; mime: string; bytes: Buffer };
export type ReadOutcome = { status: "READ" | "SKIPPED" | "FAILED"; reason: string; text: string; findings: Finding[]; rejected: number };
export type RoomText = { documentId: string; name: string; text: string };
export type DraftSource = { documentId: string; name: string; quote: string };
export type Draft = { answer: string; sources: DraftSource[] };

export type Reader = {
  // "rules", or "model:<name>" for a language model.
  source: string;
  read(file: ReaderFile): Promise<ReadOutcome>;
  draft(question: string, files: RoomText[]): Promise<Draft | null>;
};

export const NEEDS_MODEL = "Needs the model reader.";
const NOT_READABLE = "The reader reads text files and PDFs.";
// A base64 PDF this size is about 13 MB in the request, near what providers take.
const MAX_MODEL_PDF = 10 * 1024 * 1024;

const isCsv = (file: { name: string; mime: string }) => file.mime === "text/csv" || /\.csv$/i.test(file.name);
const isImage = (file: { name: string; mime: string }) => file.mime.startsWith("image/") || /\.(png|jpe?g|webp)$/i.test(file.name);

const skipped = (reason: string): ReadOutcome => ({ status: "SKIPPED", reason, text: "", findings: [], rejected: 0 });

// Why a file was skipped, in words, from what it is. The read stores only the status.
export function skipReason(document: { mime: string; originalName: string; size: number }) {
  if (document.mime === "application/pdf" || /\.pdf$/i.test(document.originalName)) {
    return document.size > MAX_MODEL_PDF ? "The file is too large for the reader." : NEEDS_MODEL;
  }
  if (isImage({ name: document.originalName, mime: document.mime })) return "The reader doesn't read images.";
  return NOT_READABLE;
}

export function rulesReader(): Reader {
  return {
    source: "rules",
    async read(file) {
      if (isPdfBytes(file.bytes)) return skipped(NEEDS_MODEL);
      const text = decodeText(file.bytes);
      if (text == null) return skipped(isImage(file) ? "The reader doesn't read images." : NOT_READABLE);
      return { status: "READ", reason: "", text, findings: extractFindings(text, { csv: isCsv(file) }), rejected: 0 };
    },
    async draft(question, files) {
      return rulesDraft(question, files);
    },
  };
}

const FIELD_HINTS = [
  "upb: the current unpaid principal balance, as a number such as 312400.00",
  "interestRate: the current note rate in percent, such as 5.875",
  "monthlyPi: the monthly principal and interest payment, without escrow, as a number",
  "originalBalance: the original principal amount of the loan, as a number",
  "originationDate: the note or origination date, as YYYY-MM-DD",
  "maturityDate: the maturity date, as YYYY-MM-DD",
  "lastPaidDate: the date the last payment was received, as YYYY-MM-DD",
  "borrowerName: the borrower's name as written",
  "streetAddress: the property's street address, without city, state or ZIP",
  "lienPosition: FIRST, SECOND or THIRD",
  "estimatedValue: an as-is value or opinion of value, as a number",
];

const READ_SYSTEM =
  "You read mortgage loan documents for a note-trading desk. Report only what the document states. Never infer, compute or guess a value. " +
  "For each value, copy the exact words of the document that state it into quote. Leave out any field the document doesn't state. Answer with one JSON object and nothing else.";

const MAX_PROMPT_TEXT = 60_000;

function readPrompt(name: string, text: string | null) {
  return [
    `File: ${name}`,
    "Find these fields where the document states them:",
    ...FIELD_HINTS.map((hint) => `- ${hint}`),
    'Answer as {"findings":[{"field":"upb","value":"312400.00","quote":"Unpaid principal balance: $312,400.00","page":1}]}.',
    "Copy quote exactly from the document, at most 200 characters. page is the page it is on, or 1 for a text file.",
    text == null ? "The document is attached." : `Document text:\n${text.slice(0, MAX_PROMPT_TEXT)}`,
  ].join("\n");
}

// Keeps a model's finding only when its field is one the reader reads, its value reads as that field's kind, and its
// quote is in the file and says that value. A value with no quote behind it is how a model invents a figure.
export function checkModelFindings(json: unknown, text: string | null): { findings: Finding[]; rejected: number } {
  const list = json && typeof json === "object" && Array.isArray((json as { findings?: unknown }).findings) ? ((json as { findings: unknown[] }).findings) : [];
  const findings: Finding[] = [];
  let rejected = 0;
  for (const item of list) {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const field = String(row.field ?? "");
    const quote = typeof row.quote === "string" ? row.quote.replace(/\s+/g, " ").trim() : "";
    const value = readValue(field, row.value);
    const page = Number.isInteger(row.page) && Number(row.page) >= 1 && Number(row.page) <= 5000 ? Number(row.page) : null;
    if (!isReadField(field) || value == null || quote.length < 3 || quote.length > 300) {
      rejected += 1;
      continue;
    }
    const inFile = text ? quoteFound(text, quote) : true;
    const says =
      field === "borrowerName"
        ? nameKey(quote).includes(nameKey(value))
        : field === "streetAddress"
          ? streetKey(quote).includes(streetKey(value))
          : valuesIn(field, quote).some((found) => sameRead(field, found, value));
    if (!inFile || !says) {
      rejected += 1;
      continue;
    }
    if (findings.some((finding) => finding.field === field && sameRead(field, finding.value, value))) continue;
    findings.push({ field, value, quote, page, confidence: text ? 0.8 : 0.5 });
  }
  return { findings, rejected };
}

export function modelReader(env: Record<string, string | undefined> = process.env): Reader {
  const { model } = llmConfig(env);
  return {
    source: `model:${model}`,
    async read(file) {
      const pdf = isPdfBytes(file.bytes);
      const text = pdf ? pdfText(file.bytes) : decodeText(file.bytes);
      if (!pdf && text == null) return skipped(isImage(file) ? "The reader doesn't read images." : NOT_READABLE);
      if (pdf && file.bytes.length > MAX_MODEL_PDF) return skipped("The file is too large for the reader.");
      const answer = await modelJson(
        {
          system: READ_SYSTEM,
          prompt: readPrompt(file.name, pdf ? null : text),
          file: pdf ? { name: file.name, mime: "application/pdf", bytes: file.bytes } : undefined,
        },
        env,
      );
      if (!answer.ok) return { status: "FAILED", reason: answer.error, text: text ?? "", findings: [], rejected: 0 };
      const checked = checkModelFindings(answer.json, text || null);
      return { status: "READ", reason: "", text: text ?? "", findings: checked.findings, rejected: checked.rejected };
    },
    async draft(question, files) {
      return modelDraft(question, files, env);
    },
  };
}

// Loan files carry borrowers' names and addresses, so they go to a model only when the desk has decided to send them:
// AI_READING_MODEL=1 and a key, ideally on UPB's own account with a data-processing agreement. A key alone, such as
// one the desk assistant uses, keeps the reader on the offline rules.
export function modelReadingAllowed(env: Record<string, string | undefined> = process.env) {
  return env.AI_READING_MODEL === "1" && Boolean(llmConfig(env).key);
}

export function activeReader(env: Record<string, string | undefined> = process.env): Reader {
  return modelReadingAllowed(env) ? modelReader(env) : rulesReader();
}

export function sourceLabel(source: string) {
  return source === "rules" ? "Rules reader, offline" : source.startsWith("model:") ? `Model reader, ${source.slice(6)}` : source;
}

// ---------------------------------------------------------------------------------------------------------
// Draft answers to bidder questions

const QUESTION_FIELDS: [ReadField, RegExp][] = [
  ["originalBalance", /\boriginal\s+(?:principal\s+)?(?:balance|amount|loan\s+amount)\b|\boriginal\s+loan\s+amount\b|\bloan\s+amount\b/i],
  ["upb", /\bupb\b|\bunpaid\s+(?:principal\s+)?balance\b|\bprincipal\s+balance\b|\bcurrent\s+balance\b/i],
  ["monthlyPi", /\bp\s?&\s?i\b|\bp\s+and\s+i\b|\bprincipal\s+and\s+interest\b|\bmonthly\s+payment\b|\bpayment\s+amount\b/i],
  ["interestRate", /\binterest\s+rate\b|\bnote\s+rate\b|\bcoupon\b/i],
  ["maturityDate", /\bmatur(?:e|es|ity)\b/i],
  ["originationDate", /\boriginat(?:ed|ion)\b|\bnote\s+date\b/i],
  ["lastPaidDate", /\blast\s+(?:paid|payment)\b|\bpaid\s+last\b|\bmost\s+recent\s+payment\b/i],
  ["lienPosition", /\blien\b/i],
  ["estimatedValue", /\bbpo\b|\bas[-\s]is\s+value\b|\bproperty\s+value\b|\bvalue\s+of\s+the\s+property\b|\bwhat\s+is\s+it\s+worth\b/i],
];

// "What's the rate?" asks for the note rate. "What's the default rate?" doesn't.
const OTHER_RATES = new Set(["default", "late", "tax", "cap", "vacancy", "prepayment", "exchange", "escrow", "floor"]);

// The tape fields a question names, in the order asked. A phrase counts once: "original balance" isn't also "balance".
export function fieldsAsked(question: string): ReadField[] {
  let text = ` ${question.toLowerCase()} `;
  const found: ReadField[] = [];
  for (const [field, pattern] of QUESTION_FIELDS) {
    const match = pattern.exec(text);
    if (!match) continue;
    found.push(field);
    text = text.replace(new RegExp(pattern.source, "gi"), " ");
  }
  if (!found.includes("interestRate")) {
    for (const match of text.matchAll(/(\w+)?\s+rate\b/g)) {
      if (!OTHER_RATES.has(match[1] ?? "")) {
        found.push("interestRate");
        break;
      }
    }
  }
  return found;
}

function shown(field: string, value: string) {
  if (MONEY_FIELDS.has(field)) return money(Number(value), Number(value) % 1 ? 2 : 0);
  if (field === "interestRate") return `${value}%`;
  if (DATE_FIELDS.has(field)) return prettyDate(value);
  if (field === "lienPosition") return (LIEN_POSITIONS.find((row) => row.value === value)?.label ?? value).toLowerCase();
  return value;
}

export function shownValue(field: string, value: string | null) {
  return value == null || value === "" ? "—" : field === "lienPosition" ? LIEN_POSITIONS.find((row) => row.value === value)?.label ?? value : shown(field, value);
}

const PHRASES: Record<ReadField, (value: string) => string> = {
  upb: (value) => `an unpaid principal balance of ${value}`,
  interestRate: (value) => `a note rate of ${value}`,
  monthlyPi: (value) => `a monthly principal and interest payment of ${value}`,
  originalBalance: (value) => `an original balance of ${value}`,
  originationDate: (value) => `an origination date of ${value}`,
  maturityDate: (value) => `a maturity date of ${value}`,
  lastPaidDate: (value) => `a last payment on ${value}`,
  borrowerName: (value) => `the borrower as ${value}`,
  streetAddress: (value) => `the property at ${value}`,
  lienPosition: (value) => `a ${value} lien`,
  estimatedValue: (value) => `a value of ${value}`,
};

const joinNames = (names: string[]) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

// The rules reader drafts only when the question names a field it finds in the room's files, and says what each
// file shows. Anything else is left for the seller to write.
export function rulesDraft(question: string, files: RoomText[]): Draft | null {
  const fields = fieldsAsked(question).filter((field) => !IDENTITY_FIELDS.has(field));
  if (!fields.length) return null;
  const sentences: string[] = [];
  const sources: DraftSource[] = [];
  for (const field of fields) {
    const reads = files.flatMap((file) =>
      extractFindings(file.text, { csv: /\.csv$/i.test(file.name) })
        .filter((finding) => finding.field === field)
        .map((finding) => ({ file, finding })),
    );
    const values = reads.filter((read, index) => reads.findIndex((other) => sameRead(field, other.finding.value, read.finding.value)) === index);
    for (const { finding } of values) {
      const agree = reads.filter((read) => sameRead(field, read.finding.value, finding.value));
      const names = [...new Set(agree.map((read) => read.file.name))];
      sentences.push(`${joinNames(names)} ${names.length === 1 ? "shows" : "show"} ${PHRASES[field](shown(field, finding.value))}.`);
      for (const read of agree) sources.push({ documentId: read.file.documentId, name: read.file.name, quote: read.finding.quote });
    }
  }
  return sentences.length ? { answer: sentences.join(" "), sources } : null;
}

const DRAFT_SYSTEM =
  "You draft answers to bidders' questions about a mortgage note, for the seller to check before publishing. Use only the files given. " +
  "Quote the exact words you rely on. If the files don't answer the question, return an empty answer. Never include the borrower's name, " +
  "street address or contact details, since the answer goes to every bidder. Answer with one JSON object and nothing else.";

export async function modelDraft(question: string, files: RoomText[], env: Record<string, string | undefined> = process.env): Promise<Draft | null> {
  if (!files.length) return null;
  let budget = MAX_PROMPT_TEXT;
  const blocks: string[] = [];
  for (const file of files) {
    if (budget <= 0) break;
    const body = file.text.slice(0, Math.min(15_000, budget));
    budget -= body.length;
    blocks.push(`[file id=${file.documentId} name=${file.name}]\n${body}`);
  }
  const answer = await modelJson(
    {
      system: DRAFT_SYSTEM,
      prompt: [
        `Question: ${question}`,
        'Answer as {"answer":"...","sources":[{"documentId":"...","quote":"..."}]}. Each quote is copied exactly from that file.',
        ...blocks,
      ].join("\n\n"),
      timeoutMs: 45_000,
    },
    env,
  );
  if (!answer.ok || !answer.json || typeof answer.json !== "object") return null;
  const body = answer.json as { answer?: unknown; sources?: unknown };
  const text = typeof body.answer === "string" ? body.answer.trim().slice(0, 2000) : "";
  if (text.length < 2) return null;
  const byId = new Map(files.map((file) => [file.documentId, file]));
  const sources: DraftSource[] = [];
  for (const item of Array.isArray(body.sources) ? body.sources : []) {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const file = byId.get(String(row.documentId ?? ""));
    const quote = typeof row.quote === "string" ? row.quote.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    if (file && quoteFound(file.text, quote)) sources.push({ documentId: file.documentId, name: file.name, quote });
  }
  // An answer with nothing in the files behind it isn't a draft from the files.
  return sources.length ? { answer: text, sources } : null;
}

// Reads ListingQuestion.aiSources defensively, for the page beside the answer form.
export function draftSources(json: string | null | undefined): DraftSource[] {
  try {
    const list: unknown = JSON.parse(json || "[]");
    if (!Array.isArray(list)) return [];
    return list.flatMap((item) => {
      const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      return typeof row.documentId === "string" && typeof row.name === "string" && typeof row.quote === "string"
        ? [{ documentId: row.documentId, name: row.name, quote: row.quote }]
        : [];
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------------
// The tape, and how the reader runs

export const READING_MODES = ["OFF", "SHADOW", "ON"] as const;
export type ReadingMode = (typeof READING_MODES)[number];

export const MODE_LABELS: Record<ReadingMode, string> = {
  OFF: "Off",
  SHADOW: "Shadow · AI-read, not confirmed",
  ON: "On · differences go to the seller",
};

export function readingModeOf(value: unknown): ReadingMode {
  return value === "OFF" || value === "ON" ? value : "SHADOW";
}

export async function readingMode() {
  return readingModeOf((await getSettings()).aiReading);
}

// What the reader writes as the one who raised a difference. It isn't an account, so the desk page names it.
export const READER_ID = "document-reader";
export const READER_NAME = "Document reader";

export type Comparison = "match" | "mismatch" | "blank" | "none";

// The finding beside the tape: the same, different, the tape blank, or nothing to compare (the original balance,
// or a file the reader couldn't tie to a loan).
export function compareWithTape(field: string, value: string, note: object | null): Comparison {
  const spec = fieldSpec(field);
  if (!note || !spec || !isReadField(field)) return "none";
  const tape = tapeValue(note, field);
  if (tape == null || tape === "") return "blank";
  const exact = spec.kind === "percent" ? exactValue(spec, (note as Record<string, unknown>)[field]) : tape;
  if (field === "lienPosition") return canonical(spec, value) === tape ? "match" : "mismatch";
  return sameRead(field, value, exact) ? "match" : "mismatch";
}

export function tapeShown(field: string, note: object | null) {
  const spec = fieldSpec(field);
  if (!note || !spec) return "—";
  return shownValue(field, spec.kind === "percent" ? exactValue(spec, (note as Record<string, unknown>)[field]) : tapeValue(note, field));
}

// The document as the desk names it in a verified badge: "Desk-verified against pay history".
const VERIFY_SOURCE: Record<string, string> = {
  NOTE: "Original note",
  MORTGAGE: "Mortgage or deed of trust",
  PAY_HISTORY: "Pay history",
  BPO: "BPO",
  TITLE: "Title policy",
  OE_REPORT: "O&E report",
  ALLONGE: "Allonge",
  ASSIGNMENT: "Assignment",
};

export function verifySource(type: string) {
  return VERIFY_SOURCE[type] ?? "Other";
}

// ---------------------------------------------------------------------------------------------------------
// Reading a listing's files and recording what was found

const SKIP_TYPES = ["PHOTO", "NDA", "TAPE"] as const;

// Loan paper only. Photos, signed NDAs, the tape itself and a broker's seller authorization aren't read.
export function readable(document: { type: string; storedName: string }, listing: { authorizationKey: string }) {
  if ((SKIP_TYPES as readonly string[]).includes(document.type)) return false;
  return !(listing.authorizationKey !== "" && document.storedName === listing.authorizationKey);
}

type LoanKey = { id: string; streetAddress: string; borrowerName: string; loanNumber: string | null };

// A loan's own file is that loan's. A listing-wide file on a single note is the note's. On a pool, a file is tied to
// a loan only when its street, borrower or loan number points at exactly one.
export function loanFor(document: { noteId: string | null }, loans: LoanKey[], findings: Finding[], text: string) {
  if (document.noteId) return loans.some((loan) => loan.id === document.noteId) ? document.noteId : null;
  if (loans.length === 1) return loans[0].id;
  const candidates = new Set<string>();
  const street = findings.find((finding) => finding.field === "streetAddress");
  const borrower = findings.find((finding) => finding.field === "borrowerName");
  const words = text.toLowerCase();
  for (const loan of loans) {
    if (street && loan.streetAddress && sameRead("streetAddress", street.value, loan.streetAddress)) candidates.add(loan.id);
    if (borrower && loan.borrowerName && sameRead("borrowerName", borrower.value, loan.borrowerName)) candidates.add(loan.id);
    if (loan.loanNumber && loan.loanNumber.length >= 5 && words.includes(loan.loanNumber.toLowerCase())) candidates.add(loan.id);
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

export type ReadOptions = { reader?: Reader; mode?: ReadingMode };
export type ReadReport = { status: ReadOutcome["status"]; reason: string; findings: number; rejected: number; raised: number; source: string; noteId: string | null };

export const textKeyFor = (documentId: string) => `reader/${documentId}.txt`;

// Opens a difference for a mismatch the reader found, as the desk would by hand, unless one is already open on the
// field or the seller already answered this same difference.
async function raiseFromReader(finding: { field: string; value: string }, note: Record<string, unknown> & { id: string }, documentType: string) {
  const spec = fieldSpec(finding.field);
  if (!spec) return false;
  const rows = await prisma.fieldDiscrepancy.findMany({ where: { noteId: note.id, field: spec.field } });
  const tape = exactValue(spec, note[spec.field]);
  if (rows.some((row) => row.status === "OPEN")) return false;
  if (rows.some((row) => sameReading(spec, row.documentValue, finding.value) && sameReading(spec, row.tapeValue, tape))) return false;
  const raised = await raiseDiscrepancy(READER_ID, { noteId: note.id, field: spec.field, document: finding.value, source: verifySource(documentType), via: "reader" });
  return raised.ok;
}

// Reads one file and records each finding beside the tape. A new read replaces the findings the desk hasn't decided;
// what the desk confirmed or rejected stays, and the same reading isn't proposed again.
export async function readDocument(documentId: string, options: ReadOptions = {}): Promise<Outcome<ReadReport>> {
  const document = documentId ? await prisma.document.findUnique({ where: { id: documentId } }) : null;
  if (!document) return fail("That file isn't on file.");
  const listing = await prisma.listing.findUnique({
    where: { id: document.listingId },
    select: { id: true, status: true, authorizationKey: true, notes: { select: { id: true, streetAddress: true, borrowerName: true, loanNumber: true } } },
  });
  if (!listing || !readable(document, listing)) return fail("The reader doesn't read this kind of file.");
  const mode = options.mode ?? (await readingMode());
  if (mode === "OFF") return fail("The reader is off. Turn it on in settings first.");
  const reader = options.reader ?? activeReader();
  let outcome: ReadOutcome;
  try {
    const bytes = await getBytes(document.storedName);
    outcome = await reader.read({ name: document.originalName, mime: document.mime, bytes });
  } catch {
    outcome = { status: "FAILED", reason: "The file couldn't be opened from storage.", text: "", findings: [], rejected: 0 };
  }
  let textKey = document.textKey ?? null;
  if (outcome.text) {
    textKey = textKeyFor(document.id);
    await putBytes(textKey, Buffer.from(outcome.text, "utf8"), "text/plain");
  }
  const noteId = loanFor(document, listing.notes, outcome.findings, outcome.text);
  const created: { id: string; field: string; value: string }[] = [];
  if (outcome.status === "READ") {
    const decided = await prisma.aiFinding.findMany({ where: { documentId: document.id, status: { in: ["CONFIRMED", "REJECTED"] } }, select: { field: true, value: true } });
    await prisma.aiFinding.deleteMany({ where: { documentId: document.id, status: "PROPOSED" } });
    for (const finding of outcome.findings) {
      if (decided.some((row) => row.field === finding.field && sameRead(finding.field, row.value, finding.value))) continue;
      created.push(
        await prisma.aiFinding.create({
          data: {
            listingId: listing.id,
            noteId,
            documentId: document.id,
            field: finding.field,
            value: finding.value,
            quote: finding.quote,
            page: finding.page,
            confidence: finding.confidence,
            source: reader.source,
          },
          select: { id: true, field: true, value: true },
        }),
      );
    }
  }
  await prisma.document.update({ where: { id: document.id }, data: { readStatus: outcome.status, readAt: new Date(), textKey } });
  // Shadow mode stops here: the desk sees the findings and nothing else changes. So does a listing in contract or
  // closed, whose tape changes only through the closing.
  let raised = 0;
  if (mode === "ON" && noteId && created.length && answerable(listing.status)) {
    const note = await prisma.note.findUnique({ where: { id: noteId } });
    for (const row of created) {
      if (note && compareWithTape(row.field, row.value, note) === "mismatch" && (await raiseFromReader(row, note as unknown as Record<string, unknown> & { id: string }, document.type))) raised += 1;
    }
  }
  await audit(null, "AI_READ", "listing", listing.id, `${document.id} · ${outcome.status} · ${created.length} found · ${outcome.rejected} rejected · ${reader.source}`);
  return { ok: true, value: { status: outcome.status, reason: outcome.reason, findings: created.length, rejected: outcome.rejected, raised, source: reader.source, noteId } };
}

// Reads a listing's files in turn: every one, or only those not read yet.
export async function readListing(listingId: string, options: ReadOptions & { onlyUnread?: boolean } = {}) {
  const mode = options.mode ?? (await readingMode());
  if (mode === "OFF") return { read: 0 };
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, select: { authorizationKey: true } });
  if (!listing) return { read: 0 };
  const documents = await prisma.document.findMany({
    where: { listingId, type: { notIn: [...SKIP_TYPES] }, ...(options.onlyUnread ? unset("readStatus") : {}) },
    select: { id: true, type: true, storedName: true },
    orderBy: { createdAt: "asc" },
  });
  let read = 0;
  for (const document of documents) {
    if (!readable(document, listing)) continue;
    if ((await readDocument(document.id, { ...options, mode })).ok) read += 1;
  }
  return { read };
}

// After an upload or a filing, the new files are read once the response has gone, so the seller isn't kept waiting.
// Outside a request (a script or a test) nothing runs in the background; the desk reads a file from its page.
export function readInBackground(listingId: string) {
  try {
    after(() => readListing(listingId, { onlyUnread: true }).catch((error) => console.error("[upb-reader] background read failed:", error)));
  } catch {
    // No request to run after.
  }
}

// ---------------------------------------------------------------------------------------------------------
// The desk's decisions

// What buyers read when the desk sets aside a difference the reader opened on a misreading.
export const READER_WAIVE_REASON = "The desk read the file itself. The reader had misread it.";

async function claimFinding(id: string, status: "CONFIRMED" | "REJECTED", actorId: string) {
  const moved = await prisma.aiFinding.updateMany({ where: { id, status: "PROPOSED" }, data: { status, decidedById: actorId, decidedAt: new Date() } });
  return moved.count === 1;
}

// The desk agrees with the reading. The field is marked verified against the file through the desk's own check, so a
// difference opens or stays open exactly as it would had the desk typed the value in.
export async function confirmFinding(actorId: string, findingId: string): Promise<Outcome<{ listingId: string; noteId: string | null; field: string; verified: boolean; raised: boolean }>> {
  const finding = findingId ? await prisma.aiFinding.findUnique({ where: { id: findingId } }) : null;
  if (!finding) return fail("That reading isn't on file.");
  if (finding.status !== "PROPOSED") return fail("That reading was already decided.");
  if (!finding.noteId) return fail("The reader couldn't tell which loan this file is for. Check the file and verify the field by hand.");
  const [document, note] = await Promise.all([
    prisma.document.findUnique({ where: { id: finding.documentId }, select: { id: true, type: true } }),
    prisma.note.findUnique({ where: { id: finding.noteId } }),
  ]);
  if (!document || !note) return fail("That reading isn't on file.");
  if (!(await claimFinding(finding.id, "CONFIRMED", actorId))) return fail("That reading was decided a moment ago. Reload to see it.");
  const base = { listingId: finding.listingId, noteId: finding.noteId, field: finding.field };
  const spec = fieldSpec(finding.field);
  if (!spec) {
    await audit(actorId, "AI_FINDING_CONFIRM", "note", note.id, `${finding.field} · ${document.id}`);
    return { ok: true, value: { ...base, verified: false, raised: false } };
  }
  const comparison = compareWithTape(finding.field, finding.value, note);
  // A match verifies the tape as it stands, so a cent of rounding or "Ave" for "Avenue" doesn't open a difference.
  const outcome = await markFieldVerified(actorId, {
    noteId: note.id,
    field: spec.field,
    source: verifySource(document.type),
    document: comparison === "match" ? null : finding.value,
  });
  if (!outcome.ok) {
    await prisma.aiFinding.updateMany({ where: { id: finding.id, status: "CONFIRMED" }, data: { status: "PROPOSED", decidedById: null, decidedAt: null } });
    return outcome;
  }
  await audit(actorId, "AI_FINDING_CONFIRM", "note", note.id, `${finding.field} · ${document.id}`);
  return { ok: true, value: { ...base, verified: true, raised: outcome.value.raised } };
}

// The desk says the reader got it wrong. A difference the reader opened on this reading is set aside with a reason.
export async function rejectFinding(actorId: string, findingId: string): Promise<Outcome<{ listingId: string; noteId: string | null; waived: boolean }>> {
  const finding = findingId ? await prisma.aiFinding.findUnique({ where: { id: findingId } }) : null;
  if (!finding) return fail("That reading isn't on file.");
  if (finding.status !== "PROPOSED") return fail("That reading was already decided.");
  if (!(await claimFinding(finding.id, "REJECTED", actorId))) return fail("That reading was decided a moment ago. Reload to see it.");
  let waived = false;
  const spec = fieldSpec(finding.field);
  if (finding.noteId && spec) {
    const open = await prisma.fieldDiscrepancy.findFirst({ where: { noteId: finding.noteId, field: spec.field, status: "OPEN", raisedById: READER_ID } });
    if (open && sameReading(spec, open.documentValue, finding.value)) {
      waived = (await deskResolveDiscrepancy(actorId, { id: open.id, answer: "WAIVE", reason: READER_WAIVE_REASON })).ok;
    }
  }
  await audit(actorId, "AI_FINDING_REJECT", finding.noteId ? "note" : "listing", finding.noteId ?? finding.listingId, `${finding.field} · ${finding.documentId}`);
  return { ok: true, value: { listingId: finding.listingId, noteId: finding.noteId, waived } };
}

// ---------------------------------------------------------------------------------------------------------
// Drafting an answer to a bidder's question

// The room's files a draft may quote: read, and open to every bidder in the room. On a pool, a question about one
// loan uses the files the reader tied to that loan, and a question about the whole pool uses them all.
async function roomTexts(question: { listingId: string; noteId: string | null }) {
  const listing = await prisma.listing.findUnique({ where: { id: question.listingId }, select: { authorizationKey: true, notes: { select: { id: true } } } });
  if (!listing) return [];
  const documents = (await prisma.document.findMany({ where: { listingId: question.listingId, readStatus: "READ" }, orderBy: { createdAt: "asc" } })).filter(
    (document) => document.textKey && readable(document, listing) && !isPrivateDocument(document, listing),
  );
  let chosen = documents;
  if (listing.notes.length > 1 && question.noteId) {
    const tied = await prisma.aiFinding.findMany({ where: { listingId: question.listingId, noteId: question.noteId }, select: { documentId: true } });
    const ids = new Set(tied.map((row) => row.documentId));
    chosen = documents.filter((document) => ids.has(document.id));
  }
  const texts: RoomText[] = [];
  for (const document of chosen) {
    try {
      texts.push({ documentId: document.id, name: document.originalName, text: (await getBytes(document.textKey!)).toString("utf8") });
    } catch {
      // A text that can't be opened is left out; the file is read again on the desk's next pass.
    }
  }
  return texts;
}

// Drafts an answer from the room's files, for the seller, broker or desk to check before publishing. Files not read
// yet are read first, so a question on an older listing still finds its answer. No draft is left when the files
// don't answer it.
export async function draftAnswer(questionId: string, options: ReadOptions = {}): Promise<Outcome<{ drafted: boolean }>> {
  const question = questionId ? await prisma.listingQuestion.findUnique({ where: { id: questionId } }) : null;
  if (!question) return fail("That question isn't on file.");
  if (question.status !== "OPEN") return { ok: true, value: { drafted: false } };
  const mode = options.mode ?? (await readingMode());
  if (mode === "OFF") return { ok: true, value: { drafted: false } };
  const reader = options.reader ?? activeReader();
  await readListing(question.listingId, { reader, mode, onlyUnread: true });
  const listing = await prisma.listing.findUnique({ where: { id: question.listingId }, select: { notes: { select: { id: true } } } });
  // A rules draft on a pool needs the loan, since the files differ loan by loan.
  if (reader.source === "rules" && (listing?.notes.length ?? 0) > 1 && !question.noteId) return { ok: true, value: { drafted: false } };
  const draft = await reader.draft(question.question, await roomTexts(question));
  if (!draft) return { ok: true, value: { drafted: false } };
  await prisma.listingQuestion.updateMany({
    where: { id: question.id, status: "OPEN" },
    data: { aiDraft: draft.answer, aiSources: JSON.stringify(draft.sources.slice(0, 12)), aiDraftedAt: new Date() },
  });
  await audit(null, "AI_DRAFT", "listing", question.listingId, `${question.id} · ${reader.source}`);
  return { ok: true, value: { drafted: true } };
}

export function draftInBackground(questionId: string) {
  try {
    after(() => draftAnswer(questionId).catch((error) => console.error("[upb-reader] background draft failed:", error)));
  } catch {
    // No request to run after.
  }
}

// Who sees a draft beside the answer form. In shadow mode only the desk does, since the reader hasn't passed its test.
export function draftVisible(mode: ReadingMode, from: string) {
  return mode === "ON" || (mode === "SHADOW" && from === "admin");
}

// ---------------------------------------------------------------------------------------------------------
// What the pages show

// The seller's line, in ON mode only: how many files the reader checked and how many fields the desk is confirming.
export async function readerSummary(listingId: string) {
  const [mode, files, proposed] = await Promise.all([
    readingMode(),
    prisma.document.count({ where: { listingId, readStatus: "READ" } }),
    prisma.aiFinding.findMany({ where: { listingId, status: "PROPOSED" }, select: { noteId: true, field: true } }),
  ]);
  const confirming = new Set(proposed.map((row) => `${row.noteId ?? ""}|${row.field}`)).size;
  return { mode, files, confirming };
}

export function summaryLine(files: number, confirming: number) {
  return `The desk's reader checked ${files} file${files === 1 ? "" : "s"}; the desk is confirming ${confirming} field${confirming === 1 ? "" : "s"}.`;
}

// The desk's panel for one loan: the files that bear on it, and every finding beside the tape.
export async function readerPanel(listingId: string, noteId: string | null) {
  const [mode, listing, note] = await Promise.all([
    readingMode(),
    prisma.listing.findUnique({ where: { id: listingId }, select: { authorizationKey: true } }),
    noteId ? prisma.note.findUnique({ where: { id: noteId } }) : Promise.resolve(null),
  ]);
  const documents = listing
    ? (
        await prisma.document.findMany({
          where: { listingId, type: { notIn: [...SKIP_TYPES] }, OR: [{ noteId }, ...unset("noteId").OR] },
          orderBy: { createdAt: "asc" },
          select: { id: true, type: true, storedName: true, originalName: true, mime: true, size: true, noteId: true, readStatus: true, readAt: true, textKey: true },
        })
      ).filter((document) => readable(document, listing))
    : [];
  const findings = await prisma.aiFinding.findMany({
    where: { listingId, OR: [{ noteId }, ...unset("noteId").OR] },
    orderBy: [{ createdAt: "desc" }],
    take: 200,
  });
  const names = new Map(documents.map((document) => [document.id, document]));
  return {
    mode,
    source: activeReader().source,
    documents: documents.map((document) => ({
      ...document,
      reason: document.readStatus === "SKIPPED" ? skipReason(document) : document.readStatus === "FAILED" ? "The reader couldn't read the file. Try again." : "",
    })),
    findings: findings.map((finding) => {
      const file = names.get(finding.documentId);
      return {
        ...finding,
        label: readLabel(finding.field),
        shown: shownValue(finding.field, finding.value),
        tape: finding.noteId ? tapeShown(finding.field, note) : "—",
        comparison: finding.noteId ? compareWithTape(finding.field, finding.value, note) : ("none" as Comparison),
        fileName: file?.originalName ?? "A removed file",
        // With no text from the file, a model's quote couldn't be checked against it.
        quoteChecked: finding.source === "rules" || Boolean(file?.textKey),
      };
    }),
  };
}
