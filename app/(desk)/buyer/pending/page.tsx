import Link from "next/link";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { resolveMailTransport } from "@/lib/mail-config";

export const metadata = { title: "Waiting" };

export default async function PendingPage() {
  const user = await requireRole(["BUYER", "ADMIN"]);
  return (
    <div className="max-w-xl">
      <PageIntro
        eyebrow="In review"
        title={`Welcome, ${user.name.split(" ")[0]}.`}
        lede={`Buyer accounts are opened by the desk before the book is visible. You'll get ${resolveMailTransport() === "log" ? "a notice here" : "an email"} once the desk approves the account.`}
      />
      {user.accountStatus === "APPROVED" && (
        <Link href="/marketplace" className="inline-flex h-11 items-center bg-primary px-5 text-[13px] font-medium text-primary-foreground rounded-lg">The book is open</Link>
      )}
    </div>
  );
}
