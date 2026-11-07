import type { Metadata } from "next";
import { LegalDocument } from "@/components/legal-document";
import { q } from "@/lib/format";

export const metadata: Metadata = {
  title: "Terms of use",
  description: "The rules for using UPB Capital: who may bid, what the desk is and is not, fees, confidentiality and borrowers.",
};
export const dynamic = "force-dynamic";

export default async function TermsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  return (
    <LegalDocument
      legalKey="TERMS"
      lede="The rules for using the desk, in plain English. The listing and the closing papers govern a particular trade."
      notice={q(params, "notice")}
      error={q(params, "error")}
    />
  );
}
