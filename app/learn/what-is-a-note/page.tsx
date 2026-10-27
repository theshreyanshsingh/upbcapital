import type { Metadata } from "next";
import { PublicPage } from "@/components/public-page";

export const metadata: Metadata = {
  title: "What is a mortgage note",
  description: "A mortgage note is the debt. The house is the collateral. UPB Capital is a desk for trading that paper.",
};

export default function WhatIsANotePage() {
  return (
    <PublicPage title="A note is the debt, not the house." lede="Buying a mortgage note means buying the remaining payments and the lien that secures them.">
      <p>The borrower signed a promise to repay. The mortgage, or the deed of trust, ties that promise to a property. The owner of the note is the person entitled to the payments. If the payments stop, that owner is the one who can enforce the lien, subject to the loan documents and the law of the state.</p>
      <p>Performing paper is current. Non-performing paper is behind. A second lien sits behind a first, so the buyer is underwriting both the borrower and the senior debt. Unpaid principal balance is the remaining loan amount. The asking price is what the seller wants for that claim, which is often a discount to the balance.</p>
      <p>UPB Capital does not originate loans and does not take title for you. The desk lists the paper, screens the parties it is given, and runs a closing checklist when a bid is accepted. Street address and the borrower’s name stay closed until you sign confidentiality on that listing.</p>
    </PublicPage>
  );
}
