import { reviewSellerFile } from "@/actions/seller-identity";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SellerExclusionList } from "@/components/private-sale";
import { prettyDate, q } from "@/lib/format";
import { exclusionsBySeller } from "@/lib/private-listings";
import { entityLabel, roleLabel } from "@/lib/labels";
import { ofacBlocks } from "@/lib/ofac";
import { prisma } from "@/lib/prisma";
import { sellerFileLabel, sellerIdentityRequired } from "@/lib/seller-identity";
import { getSettings } from "@/lib/settings";
import { requireDesk } from "@/lib/staff";

export const metadata = { title: "Seller files" };

const IN_REVIEW = ["SUBMITTED", "UNDER_REVIEW"] as const;

export default async function SellerFilesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Identity documents are compliance work, so the page itself is, unlike the buyer files any desk role may read.
  await requireDesk("compliance", "/admin/verification");
  const params = await searchParams;
  const [rows, settings] = await Promise.all([
    prisma.sellerProfile.findMany({
      where: { status: { not: "NOT_STARTED" } },
      include: { user: { select: { name: true, email: true, role: true, companyName: true } } },
      orderBy: { submittedAt: "desc" },
    }),
    getSettings(),
  ]);
  // Files waiting on the desk first, newest first within each group.
  const profiles = [...rows.filter((row) => row.status === "SUBMITTED"), ...rows.filter((row) => row.status !== "SUBMITTED")];
  const userIds = profiles.map((profile) => profile.userId);
  const reviewerIds = [...new Set(profiles.map((profile) => profile.reviewedById).filter((id): id is string => Boolean(id)))];
  const [checks, waiting, reviewers, excluded] = await Promise.all([
    prisma.ofacCheck.findMany({ where: { userId: { in: userIds }, result: "REVIEW" }, orderBy: { createdAt: "desc" } }),
    prisma.listing.findMany({ where: { sellerId: { in: userIds }, status: { in: [...IN_REVIEW] } }, select: { id: true, sellerId: true, title: true } }),
    reviewerIds.length ? prisma.user.findMany({ where: { id: { in: reviewerIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    // The buyers each seller never sells to, which the desk reads and the seller keeps (lib/private-listings.ts).
    exclusionsBySeller(userIds),
  ]);
  const reviewerName = new Map(reviewers.map((person) => [person.id, person.name]));
  const required = sellerIdentityRequired(settings);
  const open = profiles.filter((profile) => profile.status === "SUBMITTED").length;
  return (
    <div>
      <PageIntro eyebrow="Seller files" title="Identity and signing authority." lede="Who is selling, who signs for them, and a document that shows they may sell. Approve, ask for changes, or decline with a note." />
      <nav aria-label="Verification files" className="flex flex-wrap gap-4 text-sm">
        <a href="/admin/verification" className="text-link">Buyer files</a>
        <span aria-current="page" className="font-medium text-foreground">Seller files</span>
      </nav>
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      <p className="mt-4 text-sm text-muted-foreground">
        {required
          ? "The desk approves the seller of record's file before it approves their listing, whether a seller or a broker filed it. The desk's own paper is exempt."
          : "The gate is off, so a listing can be approved before its seller's file. Each listing still shows the seller's status."}{" "}
        <a href="/admin/settings#seller-identity" className="text-link">Change it in settings</a>
      </p>
      {open > 0 && <p className="mt-2 text-sm text-foreground">{open} seller file{open === 1 ? " is" : "s are"} waiting for review.</p>}
      <ul className="mt-8 space-y-4">
        {profiles.length === 0 && <li className="text-sm text-muted-foreground">No seller files yet.</li>}
        {profiles.map((profile) => {
          const holds = checks.filter((check) => check.userId === profile.userId && ofacBlocks(check));
          const listings = waiting.filter((listing) => listing.sellerId === profile.userId);
          return (
            <li key={profile.userId} id={`seller-${profile.userId}`} className="glass scroll-mt-6 p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold tracking-tight text-3xl text-foreground">{profile.entityName || profile.user.companyName || profile.user.name}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {profile.user.name} · {profile.user.email} · {roleLabel(profile.user.role).toLowerCase()} · {entityLabel(profile.entityType).toLowerCase()}
                  </p>
                </div>
                <p className={`text-[13px] font-medium ${profile.status === "APPROVED" ? "text-good" : profile.status === "REJECTED" ? "text-bad" : "text-link"}`}>{sellerFileLabel(profile.status)}</p>
              </div>
              <p className="mt-2 text-sm text-foreground">
                Signed by {profile.signerName || "no one named"}
                {profile.signerTitle ? `, ${profile.signerTitle}` : profile.entityType === "INDIVIDUAL" ? ", for themselves" : ""}
                {" · "}
                <span className="tabular-nums">{profile.taxIdLast4 ? `EIN or SSN ends in ${profile.taxIdLast4}` : "No tax ID digits"}</span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Sent {prettyDate(profile.submittedAt)}
                {profile.reviewedAt ? ` · decided ${prettyDate(profile.reviewedAt)}${profile.reviewedById ? ` by ${reviewerName.get(profile.reviewedById) ?? "a desk member"}` : ""}` : ""}
                {profile.vendor && profile.vendorRef ? ` · ${profile.vendor} case ${profile.vendorRef}` : ""}
              </p>
              {profile.reviewerNote && <p className="mt-1 text-xs text-muted-foreground">Note: {profile.reviewerNote}</p>}
              <p className="mt-3 text-sm">
                {profile.idDocKey ? <a className="text-link" href={`/api/seller-identity/${profile.userId}/id`}>Identity document</a> : <span className="text-bad">No identity document</span>}
                {" · "}
                {profile.authorityDocKey ? <a className="text-link" href={`/api/seller-identity/${profile.userId}/authority`}>Authority document</a> : <span className="text-bad">No authority document</span>}
              </p>
              {holds.length > 0 && (
                <div role="status" className="mt-3 rounded-lg border border-bad/40 bg-bad/5 px-3 py-2 text-sm text-foreground">
                  {holds.map((check) => (
                    <p key={check.id}>
                      {check.status === "CONFIRMED" ? "Confirmed sanctions match" : "Open sanctions review"}: &ldquo;{check.name}&rdquo;{check.matched ? ` against ${check.matched}` : ""} · {check.context}.
                    </p>
                  ))}
                  <p className="mt-1">
                    Approval waits on it. <a className="font-medium text-link" href="/admin/compliance">Decide it under Compliance</a>
                  </p>
                </div>
              )}
              {listings.length > 0 && (
                <p className="mt-3 text-sm text-foreground">
                  In review:{" "}
                  {listings.map((listing, index) => (
                    <span key={listing.id}>
                      {index > 0 && " · "}
                      <a className="text-link" href={`/admin/listings/${listing.id}`}>{listing.title}</a>
                    </span>
                  ))}
                </p>
              )}
              {(excluded.get(profile.userId) ?? []).length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm text-foreground">Excluded buyers · {excluded.get(profile.userId)?.length}</summary>
                  <SellerExclusionList rows={excluded.get(profile.userId) ?? []} empty="" />
                </details>
              )}
              <form action={reviewSellerFile} className="mt-4 space-y-3">
                <input type="hidden" name="userId" value={profile.userId} />
                <input type="hidden" name="seen" value={profile.submittedAt?.toISOString() ?? ""} />
                <input name="reviewerNote" maxLength={600} placeholder="Note to the seller. Needed to ask for changes or decline." aria-label="Note to the seller" className="desk-input" />
                <div className="flex flex-wrap gap-2">
                  {profile.status !== "APPROVED" && (
                    <button type="submit" name="decision" value="APPROVED" className="h-9 bg-primary px-3 text-[13px] font-medium text-primary-foreground rounded-lg">Approve</button>
                  )}
                  {profile.status !== "CHANGES_REQUESTED" && (
                    <button type="submit" name="decision" value="CHANGES_REQUESTED" className="h-9 border border-border px-3 text-[13px] font-medium text-foreground rounded-lg">Request changes</button>
                  )}
                  {profile.status !== "REJECTED" && (
                    <button type="submit" name="decision" value="REJECTED" className="h-9 px-3 text-[13px] font-medium text-bad">Decline</button>
                  )}
                </div>
              </form>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
