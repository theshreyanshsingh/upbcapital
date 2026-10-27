import { z } from "zod";
import { FORECLOSURES, LIEN_POSITIONS, OCCUPANCIES, PAYMENT_STATUSES, PROPERTY_TYPES, US_STATES } from "@/lib/labels";

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
  interestRate: z.coerce.number().min(0).max(40),
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
