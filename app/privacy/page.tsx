import type { Metadata } from "next";
import { LegalDocument } from "@/components/legal-document";
import { q } from "@/lib/format";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "What UPB Capital collects, why, who handles it, how long it is kept, and how to ask for deletion.",
};
export const dynamic = "force-dynamic";

export default async function PrivacyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  return (
    <LegalDocument
      legalKey="PRIVACY"
      lede="What the desk collects about you, why, who handles it, and what you can ask for."
      notice={q(params, "notice")}
      error={q(params, "error")}
    />
  );
}
