import Link from "next/link";
import { FillBar } from "@/components/fill-bar";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { money } from "@/lib/format";
import { fillState } from "@/lib/group-buy";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Groups" };

export default async function BuyerGroupsPage() {
  const user = await requireRole(["BUYER", "ADMIN"]);
  const groups = await prisma.groupBuy.findMany({
    where: { OR: [{ openedById: user.id }, { positions: { some: { userId: user.id, status: { not: "DROPPED" } } } }] },
    include: { listing: true, positions: true },
    orderBy: { createdAt: "desc" },
  });
  return (
    <div>
      <PageIntro eyebrow="Groups" title="Notes you are buying with others." lede="A group is one offer. Your seat is a percentage of that price, or a senior or junior slice of the cash flow." />
      <ul className="mt-8 space-y-4">
        {groups.length === 0 && <li className="border border-dashed border-link/30 px-5 py-8 text-sm text-muted-foreground rounded-xl">You have no seats. Open a group from a live listing.</li>}
        {groups.map((group) => {
          const state = fillState(Number(group.targetAmount), group.positions.map((seat) => ({ amount: Number(seat.amount), status: seat.status })));
          return (
            <li key={group.id} className="glass p-5">
              <Link href={`/groups/${group.id}`} className="font-semibold tracking-tight text-3xl text-foreground">{group.listing.title}</Link>
              <p className="mt-1 text-sm text-muted-foreground">{group.status.toLowerCase()} · {money(Number(group.targetAmount))}</p>
              <div className="mt-4 max-w-md">
                <FillBar filled={state.filled} target={Number(group.targetAmount)} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
