import { actionGate } from "@/lib/action-gates";
import { audit } from "@/lib/audit";
import { announceInquiry, checkOffer, inquiryBlock, logEligibility, writeInquiry, type OfferCheck } from "@/lib/inquiry";
import { loanPricesFromForm, type LoanPrices } from "@/lib/loan-prices";
import { prisma } from "@/lib/prisma";
import { formFields, holdSeatBid, overSeatLimit, type ActingUser } from "@/lib/seats";
import { isPro } from "@/lib/settings";

// The listing's inquiry form: a bid, an information request or a data room request. The form's action calls it, and
// so does an approving seat placing a bid a trading seat asked for (lib/seats.ts), so every check runs each time, as
// of the moment the bid is placed. A refusal carries the page to send the buyer to.
export type InquiryOutcome =
  | { error: string; redirect: string; inquiryId?: null; heldId?: null }
  | { error: null; inquiryId: string; heldId: null }
  | { error: null; inquiryId: null; heldId: string };

export async function placeInquiry(user: ActingUser, formData: FormData, options: { approved?: boolean; now?: Date } = {}): Promise<InquiryOutcome> {
  const listingId = String(formData.get("listingId") || "");
  const type = String(formData.get("type") || "INFO_REQUEST");
  const message = String(formData.get("message") || "").trim();
  const back = `/marketplace/${listingId}`;
  const refuse = (error: string, to = back, hash = "") => ({ error, redirect: `${to}?error=${encodeURIComponent(error)}${hash}` });
  // An address not yet confirmed, or a seat that can't act for its firm, stops here (lib/action-gates.ts).
  const gated = await actionGate(user, type === "OFFER" ? "bid" : "message");
  if (gated) return refuse(gated);
  const listing = await prisma.listing.findUnique({ where: { id: listingId }, include: { seller: true } });
  const noteId = String(formData.get("noteId") || "");
  let amount: number | null = null;
  let expiresAt: Date | null = null;
  let passed: Extract<OfferCheck, { error: null }> | null = null;
  let loanPrices: LoanPrices | null = null;
  let allowPartial = false;
  let buyerEntityId: string | null = null;
  if (type === "OFFER") {
    // The same checks a confirmed standing bid runs, in lib/inquiry.ts.
    amount = Number(String(formData.get("amount") || "").replace(/[$,]/g, ""));
    // A whole-pool bid may price each loan. The check holds the prices to the bid.
    const priced = loanPricesFromForm(formData);
    if (priced.error) return refuse(priced.error, back, "#offer");
    loanPrices = priced.prices;
    allowPartial = priced.allowPartial;
    const check = await checkOffer({ user, listing, noteId, amount, goodUntil: String(formData.get("goodUntil") || ""), loanPrices, allowPartial, buyerEntityId: String(formData.get("buyerEntityId") || ""), now: options.now });
    if (check.error !== null) return check.verification ? refuse(check.error, "/buyer/verification") : refuse(check.error);
    expiresAt = check.expiresAt;
    passed = check;
    buyerEntityId = check.buyerEntityId;
    // A trading seat's bid above its limit isn't placed. It waits for an approving seat, who places it through here.
    if (listing && !options.approved && overSeatLimit(user, amount)) {
      const held = await holdSeatBid(user, { listing, noteId, amount, fields: formFields(formData), now: options.now });
      if (held.error !== null) return refuse(held.error, back, "#offer");
      return { error: null, inquiryId: null, heldId: held.id };
    }
  } else {
    const blocked = await inquiryBlock(user, listing);
    if (blocked) return refuse(blocked);
    if (type === "DATA_ROOM" && !isPro(user)) return { error: "Data room requests are a Pro privilege.", redirect: "/buyer/subscription?reason=dataroom" };
  }
  if (!listing) return { error: "This listing is not taking new inquiries.", redirect: back };
  const input = { user, listing, type, noteId, amount, message, expiresAt, loanPrices, allowPartial, buyerEntityId };
  const inquiry = await writeInquiry(input);
  await announceInquiry(inquiry, input);
  if (passed) await logEligibility(user.id, inquiry.id, passed);
  // Which seat placed it, for the firm's own offer book. An approved bid is told by its approval instead.
  if (type === "OFFER" && user.actor && !options.approved) await audit(user.id, "SEAT_BID", "inquiry", inquiry.id, `Placed by ${user.actor.name}`, user.actor.id);
  return { error: null, inquiryId: inquiry.id, heldId: null };
}
