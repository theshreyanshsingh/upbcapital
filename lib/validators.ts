import { z } from "zod";
import type { Note } from "@prisma/client";
import { isoDate } from "@/lib/format";
import { FORECLOSURES, LIEN_POSITIONS, OCCUPANCIES, PAYMENT_STATUSES, PROPERTY_TYPES, US_STATES } from "@/lib/labels";
import {
  BANKRUPTCY_CHAPTERS,
  CREDIT_SCORE_MAX,
  CREDIT_SCORE_MIN,
  CREDIT_SCORE_TYPES,
  LOAN_PURPOSES,
  LOSS_MIT_STAGES,
  PAYMENT_TYPES,
  VALUE_TYPES,
  parseMersMin,
  parsePayString,
  type ServicingKey,
} from "@/lib/tape-fields";

const values = <T extends readonly { value: string }[]>(items: T) => items.map((item) => item.value) as [T[number]["value"], ...T[number]["value"][]];

const optionalDate = z
  .string()
  .trim()
  .optional()
  .or(z.literal(""))
  .transform((value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  });

// The servicing record is optional end to end: a blank, a missing field and "not sure" all store nothing.
const blank = (value: unknown) => (value == null || (typeof value === "string" && value.trim() === "") ? undefined : value);

const optionalText = (max: number, message: string) =>
  z.preprocess(blank, z.string().trim().max(max, message).optional()).transform((value) => value || null);

const DAY = 86400000;

// A day of slack, so a date picked in a timezone ahead of the server isn't called the future.
const pastDate = (message: string) =>
  z
    .preprocess(blank, z.string().trim().optional())
    .transform((value) => {
      if (!value) return null;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    })
    .refine((date) => !date || date.getTime() <= Date.now() + DAY, message);

const yesNo = z
  .preprocess(blank, z.enum(["true", "false"], { error: "Choose yes, no or not sure." }).optional())
  .transform((value) => (value === undefined ? null : value === "true"));

const optionalEnum = <T extends readonly [string, ...string[]]>(options: T, message: string) =>
  z.preprocess(blank, z.enum(options, { error: message }).optional()).transform((value) => value ?? null);

const optionalNumber = (check: z.ZodCoercedNumber) => z.preprocess(blank, check.optional()).transform((value) => value ?? null);

const scoreMessage = `Credit scores run from ${CREDIT_SCORE_MIN} to ${CREDIT_SCORE_MAX}.`;

export const noteSchema = z.object({
  streetAddress: z.string().trim().min(3, "Enter the street address."),
  city: z.string().trim().min(2, "Enter the city."),
  state: z
    .string()
    .trim()
    .toUpperCase()
    .refine((value) => (US_STATES as readonly string[]).includes(value), "Use a two-letter state."),
  zip: z.string().trim().regex(/^\d{5}$/, "Use a 5-digit ZIP."),
  propertyType: z.enum(values(PROPERTY_TYPES)),
  occupancy: z.enum(values(OCCUPANCIES)),
  estimatedValue: z.coerce.number().positive("Estimated value must be greater than zero."),
  lienPosition: z.enum(values(LIEN_POSITIONS)),
  upb: z.coerce.number().positive("UPB must be greater than zero."),
  // A blank rate isn't 0%. Zero is allowed when typed.
  interestRate: z.preprocess((value) => (value === "" || value == null ? undefined : value), z.coerce.number({ error: "Enter a note rate between 0 and 40." }).min(0).max(40)),
  monthlyPi: z.coerce.number().min(0),
  paymentStatus: z.enum(values(PAYMENT_STATUSES)),
  monthsDelinquent: z.coerce.number().int().min(0).max(600),
  lastPaidDate: optionalDate,
  originationDate: optionalDate,
  maturityDate: optionalDate,
  askingPrice: z.coerce.number().positive("Asking price must be greater than zero."),
  foreclosureStatus: z.enum(values(FORECLOSURES)),
  borrowerName: z.string().trim().optional().or(z.literal("")).transform((value) => value ?? ""),
  narrative: z.string().trim().optional().or(z.literal("")).transform((value) => value ?? ""),
  loanNumber: optionalText(40, "Keep the loan number under 40 characters."),
  servicerName: optionalText(120, "Keep the servicer's name under 120 characters."),
  payString: z
    .preprocess(blank, z.string().optional())
    .transform((value, context) => {
      if (!value) return null;
      const parsed = parsePayString(value);
      if (!parsed) {
        context.addIssue({ code: "custom", message: "Use 0 to 9 or X for each month of the pay string, newest month first." });
        return z.NEVER;
      }
      return parsed;
    }),
  nextDueDate: optionalDate,
  modified: yesNo,
  modificationDate: pastDate("The modification date can't be in the future."),
  lossMitigation: optionalText(200, "Keep loss mitigation to a few words."),
  bankruptcyChapter: optionalEnum(BANKRUPTCY_CHAPTERS, "Choose a bankruptcy chapter."),
  bankruptcyFiledAt: pastDate("The bankruptcy filing date can't be in the future."),
  foreclosureFiledAt: pastDate("The foreclosure filing date can't be in the future."),
  valueType: optionalEnum(values(VALUE_TYPES), "Choose where the value came from."),
  valueAsOf: pastDate("The value date can't be in the future."),
  loanPurpose: optionalEnum(values(LOAN_PURPOSES), "Choose the loan purpose."),
  hoaLien: yesNo,
  taxDelinquent: yesNo,
  // Tape v2.1.
  armIndex: optionalText(60, "Keep the ARM index under 60 characters."),
  armMargin: optionalNumber(
    z.coerce.number({ error: "Enter the margin as a percent, such as 2.75." }).min(0, "Enter the margin as a percent, such as 2.75.").max(20, "Enter the margin as a percent, such as 2.75."),
  ),
  armNextReset: optionalDate,
  creditScore: optionalNumber(z.coerce.number({ error: scoreMessage }).int(scoreMessage).min(CREDIT_SCORE_MIN, scoreMessage).max(CREDIT_SCORE_MAX, scoreMessage)),
  creditScoreType: optionalEnum(values(CREDIT_SCORE_TYPES), "Choose the score model."),
  creditScoreDate: pastDate("The score date can't be in the future."),
  mersMin: z
    .preprocess(blank, z.string().optional())
    .transform((value, context) => {
      if (!value) return null;
      const min = parseMersMin(value);
      if (!min) {
        context.addIssue({ code: "custom", message: "A MERS MIN is 18 digits." });
        return z.NEVER;
      }
      return min;
    }),
  eNoteId: optionalText(60, "Keep the eNote ID under 60 characters."),
  originatingPlatform: optionalText(120, "Keep the originating platform under 120 characters."),
  lossMitStage: optionalEnum(values(LOSS_MIT_STAGES), "Choose the loss mitigation stage."),
  inheritedCovenants: optionalText(600, "Keep the covenants under 600 characters."),
  originatorLicense: optionalText(200, "Keep the originator's license under 200 characters."),
  // Tape v3.
  originalBalance: optionalNumber(z.coerce.number({ error: "Enter the original balance as an amount." }).positive("The original balance must be greater than zero.")),
  // An escrow account the servicer advanced runs negative.
  escrowBalance: optionalNumber(z.coerce.number({ error: "Enter the escrow balance as an amount." })),
  arrearsAmount: optionalNumber(z.coerce.number({ error: "Enter the arrears as an amount." }).min(0, "Arrears can't be below zero.")),
  payoffAmount: optionalNumber(z.coerce.number({ error: "Enter the payoff as an amount." }).positive("The payoff must be greater than zero.")),
  payoffAsOf: optionalDate,
  balloonDate: optionalDate,
  paymentType: optionalEnum(values(PAYMENT_TYPES), "Choose the payment type."),
  seniorLienBalance: optionalNumber(z.coerce.number({ error: "Enter the senior lien balance as an amount." }).min(0, "The senior lien balance can't be below zero.")),
  scraFlag: yesNo,
  borrowerDeceased: yesNo,
  litigationFlag: yesNo,
  litigationNote: optionalText(300, "Keep the litigation note under 300 characters."),
}).superRefine((input, context) => {
  // A payoff is only a figure with the date it's good through.
  if (input.payoffAmount != null && !input.payoffAsOf) context.addIssue({ code: "custom", path: ["payoffAsOf"], message: "Give the date the payoff is good through." });
  if (input.payoffAsOf && input.payoffAmount == null) context.addIssue({ code: "custom", path: ["payoffAmount"], message: "Enter the payoff amount for that date." });
});

export function firstZodError(error: z.ZodError) {
  return error.issues[0]?.message ?? "Check the form and try again.";
}

export type NoteInput = z.infer<typeof noteSchema>;

export function noteTitle(input: Pick<NoteInput, "lienPosition" | "paymentStatus" | "city">) {
  const lien = input.lienPosition === "FIRST" ? "First-lien" : input.lienPosition === "SECOND" ? "Second-lien" : input.lienPosition === "THIRD" ? "Third-lien" : "Lien";
  const performance = input.paymentStatus === "PERFORMING" ? "performing" : input.paymentStatus === "SUB_PERFORMING" ? "sub-performing" : "NPL";
  return `${lien} ${performance} · ${input.city}`;
}

// The note wizard's draft for a stored servicing record, for the edit page's `initial`.
export function servicingDraft(note: Pick<Note, ServicingKey>): Record<ServicingKey, string> {
  const flag = (value: boolean | null) => (value == null ? "" : value ? "true" : "false");
  const amount = (value: number | null) => (value == null ? "" : String(value));
  return {
    loanNumber: note.loanNumber ?? "",
    servicerName: note.servicerName ?? "",
    payString: note.payString ?? "",
    nextDueDate: isoDate(note.nextDueDate) ?? "",
    modified: flag(note.modified),
    modificationDate: isoDate(note.modificationDate) ?? "",
    lossMitigation: note.lossMitigation ?? "",
    bankruptcyChapter: note.bankruptcyChapter ?? "",
    bankruptcyFiledAt: isoDate(note.bankruptcyFiledAt) ?? "",
    foreclosureFiledAt: isoDate(note.foreclosureFiledAt) ?? "",
    valueType: note.valueType ?? "",
    valueAsOf: isoDate(note.valueAsOf) ?? "",
    loanPurpose: note.loanPurpose ?? "",
    hoaLien: flag(note.hoaLien),
    taxDelinquent: flag(note.taxDelinquent),
    armIndex: note.armIndex ?? "",
    armMargin: note.armMargin == null ? "" : String(note.armMargin),
    armNextReset: isoDate(note.armNextReset) ?? "",
    creditScore: note.creditScore == null ? "" : String(note.creditScore),
    creditScoreType: note.creditScoreType ?? "",
    creditScoreDate: isoDate(note.creditScoreDate) ?? "",
    mersMin: note.mersMin ?? "",
    eNoteId: note.eNoteId ?? "",
    originatingPlatform: note.originatingPlatform ?? "",
    lossMitStage: note.lossMitStage ?? "",
    inheritedCovenants: note.inheritedCovenants ?? "",
    originatorLicense: note.originatorLicense ?? "",
    originalBalance: amount(note.originalBalance),
    escrowBalance: amount(note.escrowBalance),
    arrearsAmount: amount(note.arrearsAmount),
    payoffAmount: amount(note.payoffAmount),
    payoffAsOf: isoDate(note.payoffAsOf) ?? "",
    balloonDate: isoDate(note.balloonDate) ?? "",
    paymentType: note.paymentType ?? "",
    seniorLienBalance: amount(note.seniorLienBalance),
    scraFlag: flag(note.scraFlag),
    borrowerDeceased: flag(note.borrowerDeceased),
    litigationFlag: flag(note.litigationFlag),
    litigationNote: note.litigationNote ?? "",
  };
}
