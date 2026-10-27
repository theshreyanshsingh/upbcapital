import { deleteSearch, toggleSearchAlert } from "@/actions/buyer";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { Button } from "@/components/ui/button";
import { requireRole } from "@/lib/auth";
import { q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { isPro } from "@/lib/settings";
import Link from "next/link";

export const metadata = { title: "Alerts" };

export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["BUYER"]);
  const params = await searchParams;
  const searches = await prisma.savedSearch.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
  return (
    <div>
      <PageIntro
        eyebrow="Alerts"
        title="Searches that watch the book."
        lede="When the desk approves a match, a notice is written to the mail log. Delivery to a real inbox is not wired in this version."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {!isPro(user) && (
        <p className="mt-6 text-sm text-muted-foreground">
          Alerts are a Pro privilege. <Link href="/buyer/subscription" className="text-link">See membership</Link>
        </p>
      )}
      <ul className="mt-8 divide-y divide-border border border-border rounded-xl">
        {searches.length === 0 && <li className="px-5 py-8 text-sm text-muted-foreground">No saved searches. Filter the book and save one.</li>}
        {searches.map((search) => (
          <li key={search.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-5">
            <div>
              <p className="font-semibold tracking-tight text-2xl text-foreground">{search.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">{JSON.stringify(search.filters)}</p>
            </div>
            <div className="flex gap-2">
              <form action={toggleSearchAlert}>
                <input type="hidden" name="id" value={search.id} />
                <Button type="submit" variant="outline" className="h-9 text-[13px] font-medium">{search.alertEnabled ? "Pause" : "Resume"}</Button>
              </form>
              <form action={deleteSearch}>
                <input type="hidden" name="id" value={search.id} />
                <Button type="submit" variant="ghost" className="h-9 text-[13px] font-medium">Remove</Button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
