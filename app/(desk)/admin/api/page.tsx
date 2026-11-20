import Link from "next/link";
import { notFound } from "next/navigation";
import { RecentCalls } from "@/components/api-calls";
import { PageIntro } from "@/components/page-intro";
import { API_LOG_DAYS, apiAccounts, recentCalls } from "@/lib/api-log";
import { requireRole } from "@/lib/auth";
import { prettyDate, q } from "@/lib/format";
import { roleLabel } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { deskCan } from "@/lib/staff";

export const metadata = { title: "API calls" };

const stamp = (at: Date) => `${prettyDate(at)} ${at.toISOString().slice(11, 16)} UTC`;

// The API call log by account. Every desk role reads it; the CSV is compliance's, as the audit log's export is.
// ?account= shows one account's keys and their latest calls.
export default async function DeskApiPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await requireRole(["ADMIN"]);
  const accountId = q(await searchParams, "account");
  const exports = deskCan(viewer, "compliance");
  if (accountId) {
    const account = await prisma.user.findUnique({ where: { id: accountId }, select: { id: true, name: true, companyName: true, email: true, role: true } });
    if (!account) notFound();
    const groups = await recentCalls(account.id);
    return (
      <div className="max-w-5xl">
        <PageIntro eyebrow="API calls" title={account.companyName || account.name} lede={`${roleLabel(account.role)} · ${account.email}`} />
        <div className="flex flex-wrap gap-4 text-[13px] font-medium">
          <Link className="text-link" href="/admin/api">Every account</Link>
          {account.role === "BUYER" && <Link className="text-link" href={`/admin/buyers/${account.id}`}>Buyer page</Link>}
        </div>
        <RecentCalls groups={groups} csvHref={exports ? `/api/security/api-calls?${new URLSearchParams({ account: account.id }).toString()}` : null} className="mt-6" />
      </div>
    );
  }
  const accounts = await apiAccounts();
  return (
    <div className="max-w-5xl">
      <PageIntro
        eyebrow="API calls"
        title="Who is calling the API."
        lede={`Accounts with a live key or a call in the last ${API_LOG_DAYS} days. A refusal is a call the key check turned away: a revoked key, a missing scope, lapsed Pro or too many calls.`}
      />
      {accounts.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-5 py-8 text-sm text-muted-foreground">No account has an API key yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {accounts.map((row) => (
            <li key={row.user.id} className="grid gap-1 px-4 py-3 text-sm md:grid-cols-[minmax(0,1fr)_200px_220px] md:items-baseline md:gap-4">
              <div className="min-w-0">
                <Link href={`/admin/api?${new URLSearchParams({ account: row.user.id }).toString()}`} className="font-medium text-link break-words">
                  {row.user.companyName || row.user.name}
                </Link>
                <p className="break-all text-xs text-muted-foreground">{roleLabel(row.user.role)} · {row.user.email}</p>
              </div>
              <p className="tabular-nums text-muted-foreground">
                {row.calls.toLocaleString("en-US")} {row.calls === 1 ? "call" : "calls"}
                {row.refused ? <span className="text-bad"> · {row.refused.toLocaleString("en-US")} refused</span> : null}
                {" · "}
                {row.liveKeys} live {row.liveKeys === 1 ? "key" : "keys"}
              </p>
              <p className="tabular-nums text-muted-foreground">{row.lastCallAt ? `Last call ${stamp(row.lastCallAt)}` : "No calls yet"}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
