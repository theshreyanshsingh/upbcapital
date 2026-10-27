import type { Metadata } from "next";
import { PublicPage } from "@/components/public-page";

export const metadata: Metadata = {
  title: "How selling a note works",
  description: "List one mortgage note or upload a tape. The desk reviews it before it is live, and commission is shown before you submit.",
};

export default function SellingPage() {
  return (
    <PublicPage title="How a seller puts paper on the desk." lede="One loan is a form. A fund or a bank can upload a tape, or push it through the API.">
      <p>An individual seller files the loan facts: address, lien, balance, rate, payment, and an asking price. The commission is shown on that form before the file is sent. The listing stays in review until the desk approves it.</p>
      <p>An institutional seller uploads a CSV or Excel tape, or posts the same columns to /api/v1/tapes with an API key. The tape lands in the review queue. Offer status comes back from /api/v1/offers, or from a webhook when a bid is created, countered, accepted, or declined.</p>
      <p>When a bid is accepted, the seller sees the same closing checklist as the buyer. Net proceeds are the price minus the commission on the fee schedule at that moment. Seller-financed paper to an owner-occupant can raise Dodd-Frank and licensing questions. The desk shows a reminder. It is not legal advice.</p>
    </PublicPage>
  );
}
