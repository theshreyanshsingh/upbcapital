import Link from "next/link";
import { ScrollText } from "lucide-react";
import { acceptanceHistory, currentVersion, masterApplies, masterLabel, type MasterKind } from "@/lib/agreements";

// On the buyer's inquiries page and the seller desk: a slim line while the member hasn't signed the current master.
// It blocks nothing. Until both sides sign, each sale's purchase agreement carries its own articles.
export async function MasterAgreementBanner({ user, kind, back }: { user: { id: string; role: string }; kind: MasterKind; back?: string }) {
  if (!(await masterApplies(user, kind))) return null;
  const version = currentVersion(kind);
  const history = await acceptanceHistory(user.id, kind);
  if (history.some((row) => row.version === version)) return null;
  const label = masterLabel(kind);
  const earlier = history[0];
  return (
    <p className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-link/30 bg-link/10 px-4 py-3 text-sm text-foreground">
      <ScrollText aria-hidden className="size-4 shrink-0 text-link" />
      <span className="min-w-0 flex-1">
        {earlier
          ? `Version ${version} of the ${label} replaces the version ${earlier.version} you signed.`
          : `Sign the ${label} once, and each sale's papers incorporate it.`}
      </span>
      <Link href={`/account/agreements${back ? `?back=${encodeURIComponent(back)}` : ""}#${kind.toLowerCase()}`} className="font-medium text-link">
        Read and sign
      </Link>
    </p>
  );
}
