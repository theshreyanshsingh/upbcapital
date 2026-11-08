import type { User } from "@prisma/client";
import { emailGate } from "@/lib/email-confirm";
import { seatGate, type ActingUser } from "@/lib/seats";

// The commitments an account makes: a bid of any kind, a listing put up for review, an award accepted, a signature.
export type GatedAction = "bid" | "list" | "award" | "sign" | "message";

// Every check that can stop an account from committing, in order. Each answers null to let it through, or the
// sentence to show instead. lib/email-confirm.ts asks for a confirmed address; lib/seats.ts asks whether the seat
// that is signed in may do this for its firm.
export async function actionGate(user: User | ActingUser, action: GatedAction): Promise<string | null> {
  return (await emailGate(user, action)) ?? (await seatGate(user, action));
}
