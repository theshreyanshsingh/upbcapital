import { clearBuyerStrike } from "@/actions/strikes";
import { reviewVerification } from "@/actions/verification";
import { reviewEntity } from "@/actions/buyer-entities";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { FileOwners } from "@/components/file-owners";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SellerFilesLink } from "@/components/seller-identity";
import { requireRole } from "@/lib/auth";
import { fileKey, ownersByFile, type OwnerView } from "@/lib/beneficial-owners";
import { deskEntityStatus } from "@/lib/buyer-entities";
import { ROAD_THRESHOLD, reoStrategyLabel } from "@/lib/eligibility";
import { isoDate, money, prettyDate, q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { entityLabel } from "@/lib/labels";
import { getSettings } from "@/lib/settings";
import { deskCan } from "@/lib/staff";
import { strikeLimitOf, strikesFor, type StrikeRow } from "@/lib/strikes";

export const metadata = { title: "Verification" };

export default async function AdminVerificationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Every desk role reads the buyer files. Decisions on them are compliance work, and the actions check the same.
  const vets = deskCan(await requireRole(["ADMIN"]), "compliance");
  const params = await searchParams;
  const profiles = await prisma.buyerProfile.findMany({ include: { user: true }, orderBy: { updatedAt: "desc" } });
  const [strikes, settings, entityRows] = await Promise.all([
    strikesFor(profiles.map((profile) => profile.userId)),
    getSettings(),
    prisma.buyerEntity.findMany({ where: { userId: { in: profiles.map((profile) => profile.userId) } }, orderBy: { createdAt: "asc" } }),
  ]);
  const limit = strikeLimitOf(settings.strikeLimit);
  // Owners of each main file and entity, with their screens as they stand.
  const owners = await ownersByFile(profiles.map((profile) => profile.userId));
  const entitiesOf = (userId: string) => entityRows.filter((entity) => entity.userId === userId);
  const waitingEntities = entityRows.filter((entity) => entity.status === "SUBMITTED").length;
  return (
    <div>
      <PageIntro eyebrow="Buyer files" title="Accreditation and proof of funds." lede="An approved account can browse. An approved file can offer." />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {!vets && <p className="mt-4 text-sm text-muted-foreground">Your desk role reads these files. Decisions are for compliance.</p>}
      {vets && <SellerFilesLink />}
      {waitingEntities > 0 && (
        <p className="mt-4 text-sm text-foreground">{waitingEntities} buying entit{waitingEntities === 1 ? "y is" : "ies are"} waiting for review under the buyers below.</p>
      )}
      <ul className="mt-8 space-y-4">
        {profiles.length === 0 && <li className="text-sm text-muted-foreground">No buyer files yet.</li>}
        {profiles.map((profile) => (
          <li key={profile.userId} id={`buyer-${profile.userId}`} className="glass scroll-mt-6 p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <p className="font-semibold tracking-tight text-3xl text-foreground">{profile.entityName || profile.user.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {profile.user.email} · {entityLabel(profile.entityType).toLowerCase()} · {profile.jurisdiction} · {profile.accredited ? "self-certified accredited" : "not certified"}
                </p>
              </div>
              <p className="text-[13px] font-medium text-link">{profile.status.replaceAll("_", " ").toLowerCase()}</p>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Submitted {prettyDate(profile.submittedAt)}</p>
            <p className="mt-1 text-sm text-foreground">
              {profile.proofVerifiedAt && profile.proofAmount != null
                ? `Verified funds ${money(profile.proofAmount)} through ${prettyDate(profile.proofExpiresAt)}${profile.proofExpiresAt && profile.proofExpiresAt.getTime() < Date.now() ? " · expired" : ""}`
                : profile.proofAmount != null
                  ? `Buyer states ${money(profile.proofAmount)} · not verified yet`
                  : "No funds amount stated"}
            </p>
            {/* The buyer's own answers to the eligibility screen. They inform and are logged; they never stop a bid. */}
            <p className="mt-1 text-sm text-foreground">
              {profile.homesControlled != null
                ? <>Controls <span className="tabular-nums">{profile.homesControlled.toLocaleString("en-US")}</span> single-family homes · foreclosed homes: {reoStrategyLabel(profile.reoStrategy).toLowerCase()} · answered {prettyDate(profile.eligibilityAt)}</>
                : "Eligibility questions not answered"}
            </p>
            {profile.homesControlled != null && profile.homesControlled >= ROAD_THRESHOLD && (
              <p className="mt-1 text-[13px] font-medium text-foreground">At or over {ROAD_THRESHOLD} homes. They acknowledge the ROAD Act notice before bidding on non-performing one- and two-unit loans.</p>
            )}
            <FileOwners owners={owners.get(fileKey(profile.userId, null)) ?? []} entityType={profile.entityType} taxIdLast4={profile.taxIdLast4 ?? null} recertifyBy={profile.status === "APPROVED" ? profile.recertifyBy : null} />
            <Strikes rows={strikes.get(profile.userId) ?? []} limit={limit} back="/admin/verification" canClear={vets} />
            <Entities userId={profile.userId} rows={entitiesOf(profile.userId)} canReview={vets} owners={owners} />
            {profile.proofKey && (
              <a className="mt-3 inline-block text-sm text-link" href={`/api/verification/${profile.userId}`}>Download proof</a>
            )}
            {vets && <form action={reviewVerification} className="mt-4 space-y-3">
              <input type="hidden" name="userId" value={profile.userId} />
              <input name="reviewerNote" placeholder="Note to the buyer" className="desk-input" />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="text-[13px] text-muted-foreground">Funds the proof supports</span>
                  <input name="proofAmount" inputMode="decimal" defaultValue={profile.proofAmount ?? ""} className="desk-input mt-2" aria-label="Verified funds amount" />
                </label>
                <label className="block">
                  <span className="text-[13px] text-muted-foreground">Good through</span>
                  <input name="proofExpiresAt" type="date" defaultValue={isoDate(profile.proofExpiresAt) ?? ""} className="desk-input mt-2" aria-label="Proof of funds expiry" />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">Needed to approve. With no date, the proof is good for 90 days. Bids whose all-in runs above it are flagged on the bid sheet.</p>
              <div className="flex flex-wrap gap-2">
                <button type="submit" name="decision" value="APPROVED" className="h-9 bg-primary px-3 text-[13px] font-medium text-primary-foreground rounded-lg">Approve</button>
                <button type="submit" name="decision" value="CHANGES_REQUESTED" className="h-9 border border-border px-3 text-[13px] font-medium text-foreground rounded-lg">Request changes</button>
                <button type="submit" name="decision" value="REJECTED" className="h-9 px-3 text-[13px] font-medium text-bad">Decline</button>
              </div>
            </form>}
          </li>
        ))}
      </ul>
    </div>
  );
}

type EntityRow = {
  id: string;
  name: string;
  entityType: string;
  jurisdiction: string;
  iraCustodian: string | null;
  iraAccountTitle: string | null;
  status: string;
  reviewerNote: string;
  reviewedAt: Date | null;
  createdAt: Date;
  taxIdLast4?: string | null;
};

// The buyer's other buying entities. Each is approved or declined with a note, and approval screens it again.
function Entities({ userId, rows, canReview, owners }: { userId: string; rows: EntityRow[]; canReview: boolean; owners: Map<string, OwnerView[]> }) {
  if (!rows.length) return null;
  return (
    <div className="mt-3 rounded-lg border border-border p-3">
      <p className="text-[13px] font-medium text-foreground">Other buying entities</p>
      <ul className="mt-2 divide-y divide-border">
        {rows.map((entity) => (
          <li key={entity.id} className="py-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-medium text-foreground">{entity.name}</p>
              <p className="text-[13px] font-medium text-link">{deskEntityStatus(entity.status)}</p>
            </div>
            <p className="text-xs text-muted-foreground">
              {entityLabel(entity.entityType)}
              {entity.entityType === "IRA" ? ` · custodian ${entity.iraCustodian} · account title ${entity.iraAccountTitle}` : ` · formed in ${entity.jurisdiction}`}
              {` · added ${prettyDate(entity.createdAt)}`}
              {entity.reviewedAt ? ` · decided ${prettyDate(entity.reviewedAt)}` : ""}
            </p>
            {entity.reviewerNote && <p className="text-xs text-muted-foreground">Note: {entity.reviewerNote}</p>}
            <FileOwners owners={owners.get(fileKey(userId, entity.id)) ?? []} entityType={entity.entityType} taxIdLast4={entity.taxIdLast4 ?? null} />
            {canReview && <form action={reviewEntity} className="mt-2 flex flex-wrap items-end gap-2">
              <input type="hidden" name="entityId" value={entity.id} />
              <input type="hidden" name="userId" value={userId} />
              <label className="block min-w-56 flex-1">
                <span className="text-xs text-muted-foreground">Note to the buyer</span>
                <input name="note" maxLength={600} className="desk-input mt-1" placeholder={entity.status === "APPROVED" ? "Why it is declined" : "Optional when approving"} />
              </label>
              {entity.status !== "APPROVED" && (
                <button type="submit" name="decision" value="APPROVED" className="h-9 bg-primary px-3 text-[13px] font-medium text-primary-foreground rounded-lg">Approve</button>
              )}
              {entity.status !== "REJECTED" && (
                <button type="submit" name="decision" value="REJECTED" className="h-9 px-3 text-[13px] font-medium text-bad">Decline</button>
              )}
            </form>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Closings this buyer won and didn't complete. Clearing one takes a note, which goes in the audit log.
function Strikes({ rows, limit, back, canClear }: { rows: StrikeRow[]; limit: number; back: string; canClear: boolean }) {
  if (!rows.length) return null;
  const active = rows.filter((row) => !row.clearedAt).length;
  return (
    <div className="mt-3 rounded-lg border border-border p-3">
      <p className={`text-[13px] font-medium tabular-nums ${active >= limit ? "text-bad" : "text-foreground"}`}>
        {active} of {limit} strikes active{active >= limit ? " · bidding paused" : ""}
      </p>
      <ul className="mt-2 divide-y divide-border">
        {rows.map((row) => (
          <li key={row.id} className="py-2 text-sm">
            <p className="text-foreground">
              <a className="text-link" href={`/closings/${row.closingId}`}>{row.listingTitle}</a> · {prettyDate(row.createdAt)}
            </p>
            <p className="text-xs text-muted-foreground">{row.reason}</p>
            {row.clearedAt ? (
              <p className="text-xs text-muted-foreground">Cleared {prettyDate(row.clearedAt)}. {row.clearNote}</p>
            ) : !canClear ? null : (
              <form action={clearBuyerStrike} className="mt-2 flex flex-wrap items-end gap-2">
                <input type="hidden" name="strikeId" value={row.id} />
                <input type="hidden" name="back" value={back} />
                <label className="block min-w-56 flex-1">
                  <span className="text-xs text-muted-foreground">Why the desk is clearing it</span>
                  <input name="note" required minLength={10} className="desk-input mt-1" />
                </label>
                <ConfirmSubmit
                  title={`Clear the strike for ${row.listingTitle}?`}
                  consequence="It stops counting toward the buyer's limit. If that takes them under the limit, their bidding resumes at once. Your note goes in the audit log."
                  typed={[["Note", "note", "text"]]}
                  confirmLabel="Clear the strike"
                  pendingLabel="Clearing…"
                  variant="outline"
                  className="h-10 text-[13px] font-medium"
                >
                  Clear strike
                </ConfirmSubmit>
              </form>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
