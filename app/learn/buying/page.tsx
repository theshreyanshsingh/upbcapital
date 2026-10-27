import type { Metadata } from "next";
import { PublicPage } from "@/components/public-page";

export const metadata: Metadata = {
  title: "How buying a note works",
  description: "Request access, verify the buyer file, sign confidentiality, bid, and fund the closing. Groups can fill one note together.",
};

export default function BuyingPage() {
  return (
    <PublicPage title="How a buyer takes a note." lede="The book is open to approved buyers. The file, the bid, and the wire are separate steps.">
      <p>Request access and wait for the desk to approve the account. Free membership opens a limited slice of the book and hides the ratios. Pro opens price, yield, and the data room.</p>
      <p>Before a bid, the buyer file has to be approved: entity, jurisdiction, an accredited-investor certification, and proof of funds. On a live listing, sign the confidentiality agreement. Then the street and the borrower name open.</p>
      <p>A bid can be yours alone, or a group. In a group, each verified buyer takes a percentage or a dollar seat until the price is filled. The seller sees one offer. At closing, each member funds their share and the documents record the percentages.</p>
      <p>Accepting the working price opens a checklist: purchase agreement, deposit, collateral, assignment, payment, and closed. The buyer’s premium is stated on the bid and posted once, to the ledger, when the file closes.</p>
    </PublicPage>
  );
}
