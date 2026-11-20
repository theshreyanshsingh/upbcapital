import Link from "next/link";
import { RequestBoardCard } from "@/components/bids-wanted";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { requireRole } from "@/lib/auth";
import { boardOpen, requestBoard } from "@/lib/bids-wanted";
import { q } from "@/lib/format";

export const metadata = { title: "Buyers wanted" };

// The board sellers and brokers answer: open requests from approved buyers, each buyer named only by type with its
// record of closings. The desk reads it as sellers do, and sees the buyers named at /admin/requests.
export default async function WantedPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireRole(["INDIVIDUAL_SELLER", "INSTITUTIONAL_SELLER", "BROKER", "ADMIN"]);
  const params = await searchParams;
  const open = boardOpen(user);
  const board = open ? await requestBoard(user) : [];
  return (
    <div className="max-w-3xl">
      <PageIntro
        eyebrow="Buyers wanted"
        title="What buyers want to buy."
        lede="Open requests from approved buyers, each named only by type, with its record of closings on UPB. Answer one by sending a listing of yours. A private listing is invited to that buyer alone, and a public one stays public."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {!open ? (
        <p className="mt-6 rounded-xl border border-dashed border-border px-5 py-6 text-sm text-muted-foreground">The board opens once the desk approves your account.</p>
      ) : board.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed border-border px-5 py-6 text-sm text-muted-foreground">No open requests right now. Buyers post them as they look for paper, so check back.</p>
      ) : (
        <ul className="mt-6 space-y-4">
          {board.map((request) => (
            <li key={request.id}>
              <RequestBoardCard
                request={request}
                action={
                  <Link href={`/wanted/${request.id}`} className="inline-flex h-10 shrink-0 items-center rounded-lg bg-primary px-4 text-[13px] font-medium text-primary-foreground">
                    Answer
                  </Link>
                }
              />
            </li>
          ))}
        </ul>
      )}
      <p className="mt-6 text-xs leading-relaxed text-muted-foreground">
        A price guide is the buyer&apos;s own statement of what it pays. It is not a bid: a sale is priced only by bids on a listing, after the desk reviews the file.
      </p>
      {user.role === "ADMIN" && (
        <p className="mt-2 text-xs text-muted-foreground">
          The desk&apos;s view, with every buyer named, is <Link href="/admin/requests" className="text-link">Buyer requests</Link>.
        </p>
      )}
    </div>
  );
}
