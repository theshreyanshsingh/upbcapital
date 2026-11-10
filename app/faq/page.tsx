import type { Metadata } from "next";
import { PublicPage } from "@/components/public-page";
import { participationFaq, participationsOpen } from "@/lib/participation";

export const metadata: Metadata = {
  title: "FAQ",
  description: "Common questions about listings, buyer verification, premiums, groups, and what UPB Capital does not do.",
};
// Two answers follow the participations flag, which is read when the page is served, not when it is built.
export const dynamic = "force-dynamic";

export default function FaqPage() {
  const answers = participationFaq(participationsOpen());
  const faqs = [
    ["Is this a fund?", answers.fund],
    ["Who can bid?", "An approved buyer with an approved buyer file. Groups require the same verification, plus the confidentiality agreement on that listing."],
    ["What is the premium?", "A percentage of the accepted price, set on the fee schedule, added on top of the bid. It is one ledger entry when the closing finishes. In a group it is split by each seat’s percentage."],
    ["When do I see the address?", "After you sign confidentiality on a live listing. Files in the data room also require Pro. Once a listing or a loan goes to contract, its address and files close to everyone but the buyer on that deal, and they reopen if the closing is canceled."],
    ["Can I sell part of a note I already hold?", answers.resale],
    ["Do you lend or service?", "No. The desk lists paper and runs the closing checklist. Servicing, foreclosure counsel, and licensing stay with the parties and their lawyers."],
  ];
  return (
    <PublicPage title="Questions the desk hears." lede="Short answers. The listing and the closing checklist are the record of a particular trade.">
      {faqs.map(([question, answer]) => (
        <section key={question}>
          <h2 className="font-semibold tracking-tight text-3xl text-foreground">{question}</h2>
          <p className="mt-2">{answer}</p>
        </section>
      ))}
    </PublicPage>
  );
}
