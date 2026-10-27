import Link from "next/link";
import { retireBuyBox, saveBuyBox } from "@/actions/buy-box";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { q } from "@/lib/format";
import { LIEN_POSITIONS, PAYMENT_STATUSES } from "@/lib/labels";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Buy box" };

export default async function BuyBoxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRole(["BUYER"]);
  const params = await searchParams;
  const boxes = await prisma.buyBox.findMany({
    where: { userId: user.id, active: true },
    include: { matches: { include: { listing: true }, orderBy: { score: "desc" }, take: 5 } },
    orderBy: { createdAt: "desc" },
  });
  return (
    <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div>
        <PageIntro eyebrow="Buy box" title="Paper that fits." lede="States, lien, performance, balance, price, a ceiling as a percent of UPB, and a target IRR from the deal analyzer. New listings are scored against every active box. A match on the live book sends a notice." />
        <Notice notice={q(params, "notice")} error={q(params, "error")} />
        <ul className="mt-8 space-y-4">
          {boxes.length === 0 && <li className="border border-dashed border-link/30 px-5 py-8 text-sm text-muted-foreground rounded-xl">No box yet. The form on the right starts one.</li>}
          {boxes.map((box) => (
            <li key={box.id} className="glass p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold tracking-tight text-3xl text-foreground">{box.name}</p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {[box.states || "Any state", box.liens || "Any lien", box.statuses || "Any status"].join(" · ")}
                    {box.maxPriceToUpb != null ? ` · max ${Number(box.maxPriceToUpb)}% of UPB` : ""}
                    {box.targetYield != null ? ` · IRR ${Number(box.targetYield)}%` : ""}
                  </p>
                </div>
                <form action={retireBuyBox}>
                  <input type="hidden" name="id" value={box.id} />
                  <SubmitButton variant="ghost" className="h-9 text-[13px] font-medium">Retire</SubmitButton>
                </form>
              </div>
              <ul className="mt-4 space-y-2 text-sm">
                {box.matches.length === 0 && <li className="text-muted-foreground">Nothing on the current book fits.</li>}
                {box.matches.filter((match) => match.listing.status === "APPROVED" || match.listing.status === "PENDING").map((match) => (
                  <li key={match.id} className="flex flex-wrap items-baseline justify-between gap-2">
                    <Link href={`/marketplace/${match.listingId}`} className="text-foreground hover:text-link">{match.listing.title}</Link>
                    <span className="text-link">{match.score}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
      <form action={saveBuyBox} className="glass h-fit space-y-4 p-5">
        <p className="eyebrow">New box</p>
        <label className="block"><span className="text-[13px] text-muted-foreground">Name</span><input name="name" required className="desk-input mt-2" aria-label="Box name" /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">States</span><input name="states" placeholder="FL, GA" className="desk-input mt-2" aria-label="States" /></label>
        <fieldset>
          <legend className="text-[13px] text-muted-foreground">Lien</legend>
          <div className="mt-2 flex flex-wrap gap-3 text-sm text-foreground">
            {LIEN_POSITIONS.map((item) => (
              <label key={item.value} className="inline-flex items-center gap-2"><input type="checkbox" name={`lien_${item.value}`} />{item.label}</label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-[13px] text-muted-foreground">Performance</legend>
          <div className="mt-2 flex flex-wrap gap-3 text-sm text-foreground">
            {PAYMENT_STATUSES.map((item) => (
              <label key={item.value} className="inline-flex items-center gap-2"><input type="checkbox" name={`status_${item.value}`} />{item.label}</label>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="text-[13px] text-muted-foreground">UPB min</span><input name="upbMin" className="desk-input mt-2" aria-label="UPB minimum" /></label>
          <label className="block"><span className="text-[13px] text-muted-foreground">UPB max</span><input name="upbMax" className="desk-input mt-2" aria-label="UPB maximum" /></label>
          <label className="block"><span className="text-[13px] text-muted-foreground">Price min</span><input name="priceMin" className="desk-input mt-2" aria-label="Price minimum" /></label>
          <label className="block"><span className="text-[13px] text-muted-foreground">Price max</span><input name="priceMax" className="desk-input mt-2" aria-label="Price maximum" /></label>
        </div>
        <label className="block"><span className="text-[13px] text-muted-foreground">Max % of UPB</span><input name="maxPriceToUpb" className="desk-input mt-2" aria-label="Maximum percent of UPB" /></label>
        <label className="block"><span className="text-[13px] text-muted-foreground">Target IRR %</span><input name="targetYield" className="desk-input mt-2" aria-label="Target IRR" /></label>
        <SubmitButton className="h-11 text-[13px] font-medium">Score the book</SubmitButton>
      </form>
    </div>
  );
}
