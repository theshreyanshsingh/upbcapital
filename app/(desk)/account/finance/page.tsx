import { redirect } from "next/navigation";
import { MyInvoices, PayoutAccountsSection } from "@/components/finance-panels";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { requireUser } from "@/lib/auth";
import { q } from "@/lib/format";
import { keepsSellerFile } from "@/lib/seller-identity";

export const metadata = { title: "Payouts and invoices" };

// A seller's payout accounts and every party's fee invoices. The desk keeps its own on each closing and in the exports.
export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  if (user.role === "ADMIN") redirect("/admin");
  const params = await searchParams;
  const seller = keepsSellerFile(user.role);
  return (
    <div className="max-w-2xl">
      <PageIntro
        eyebrow={seller ? "Payouts and invoices" : "Invoices"}
        title={seller ? "Where your money goes." : "Your fee invoices."}
        lede={
          seller
            ? `Add the account your ${user.role === "BROKER" ? "sale proceeds and broker fees go" : "sale proceeds go"} to. The desk checks it by phone before any money moves. Your commission invoices are below.`
            : "A numbered invoice for each buyer premium you paid at settlement, and any credit note against it."
        }
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {seller && <PayoutAccountsSection userId={user.id} broker={user.role === "BROKER"} />}
      <MyInvoices userId={user.id} />
    </div>
  );
}
