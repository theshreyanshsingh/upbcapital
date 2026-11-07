import { saveEligibility, startVendorKyc, submitVerification } from "@/actions/verification";
import { kycMode } from "@/lib/vendors";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { requireUser } from "@/lib/auth";
import { money, prettyDate, q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { ELIGIBILITY_INTRO, HOMES_HELP, REO_STRATEGIES } from "@/lib/eligibility";
import { bidStanding } from "@/lib/inquiry";
import { getSettings } from "@/lib/settings";
import { strikeLimitOf, strikesFor } from "@/lib/strikes";
import { ACCREDITATION_TEXT } from "@/lib/verification";
import { BuyerEntityForm } from "@/components/buyer-entity-form";
import { ENTITY_TYPES, IRA_NOTE, IRA_TITLE_EXAMPLE } from "@/lib/buyer-entities";
import { INVESTOR_ENTITIES, MAIN_FILE_ENTITIES, entityLabel } from "@/lib/labels";
import { redirect } from "next/navigation";

export const metadata = { title: "Verification" };

const ENTITIES = MAIN_FILE_ENTITIES.map((entity) => [entity.value, entity.label] as const);
// Extra entities list the usual buying vehicles first.
const ENTITY_KINDS = ENTITY_TYPES.map((value) => INVESTOR_ENTITIES.find((entity) => entity.value === value)!);

export default async function VerificationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  if (user.role !== "BUYER") redirect("/");
  const params = await searchParams;
  const [profile, standing, strikeRows, settings, entities] = await Promise.all([
    prisma.buyerProfile.findUnique({ where: { userId: user.id } }),
    bidStanding(user.id),
    strikesFor([user.id]),
    getSettings(),
    prisma.buyerEntity.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } }),
  ]);
  const strikes = strikeRows.get(user.id) ?? [];
  const strikeLimit = strikeLimitOf(settings.strikeLimit);
  return (
    <div className="max-w-2xl">
      <PageIntro
        eyebrow="Buyer file"
        title="Who is bidding."
        lede="Offers wait until the desk has an entity, a proof-of-funds file, and an accredited-investor certification. Account approval and this file are separate."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {kycMode() !== "mock" && profile?.status !== "APPROVED" && profile?.status !== "REJECTED" && (
        <form action={startVendorKyc} className="mt-6 border border-border p-5 rounded-xl">
          <p className="eyebrow">Vendor file</p>
          <p className="mt-2 text-sm text-muted-foreground">Open {kycMode() === "persona" ? "Persona" : "Parallel Markets"} to confirm who you are. It checks identity only; the desk still approves the file below before you can bid.</p>
          <SubmitButton className="mt-4 h-11 text-[13px] font-medium">Continue with {kycMode() === "persona" ? "Persona" : "Parallel"}</SubmitButton>
        </form>
      )}
      {profile && (
        <p className="mt-4 text-sm text-foreground">
          Status: {profile.status.replaceAll("_", " ").toLowerCase()}
          {profile.reviewerNote ? ` · ${profile.reviewerNote}` : ""}
        </p>
      )}
      {standing.credential && (
        <section aria-labelledby="credential-heading" className={`mt-6 rounded-xl border p-5 ${standing.credential.expired ? "border-bad/40" : "border-link/30 bg-link/5"}`}>
          <p id="credential-heading" className="eyebrow">Your bidding credential</p>
          <p className="mt-2 font-semibold tracking-tight text-xl text-foreground tabular-nums">{standing.credential.line}</p>
          {standing.credential.expired ? (
            <p className="mt-2 text-sm text-foreground">New bids are stopped until the desk verifies a fresh proof of funds. Send it with the form below.</p>
          ) : (
            <>
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-muted-foreground">Ceiling</dt>
                  <dd className="text-foreground tabular-nums">{money(standing.credential.amount)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Held by open bids and closings</dt>
                  <dd className="text-foreground tabular-nums">{money(standing.credential.amount - standing.credential.headroom)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Headroom left</dt>
                  <dd className="text-foreground tabular-nums">{money(Math.max(0, standing.credential.headroom))}</dd>
                </div>
              </dl>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                It goes with you to every listing. Your open bids, at their all-in with the buyer premium, and any closing still open together stay inside the ceiling. A higher bid on a loan you already bid needs room only for the raise. Information and data room requests don&apos;t count.
              </p>
            </>
          )}
        </section>
      )}
      {strikes.length > 0 && (
        <section aria-labelledby="strikes-heading" className="mt-6 rounded-xl border border-border p-5">
          <p id="strikes-heading" className="eyebrow">Closings that didn&apos;t complete</p>
          {standing.paused ? (
            <p className="mt-2 text-sm font-medium text-bad">{standing.paused} You can still ask for information. Write the desk on the closing thread if you think a strike is wrong.</p>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              When a closing you won is canceled because the buyer side didn&apos;t close, the desk records a strike. At {strikeLimit} active strikes, your new bids pause until the desk reviews them. A walk-away inside the diligence window is never a strike.
            </p>
          )}
          <ul className="mt-3 divide-y divide-border">
            {strikes.map((strike) => (
              <li key={strike.id} className="py-3 text-sm">
                <p className="text-foreground">{strike.listingTitle}</p>
                <p className="text-muted-foreground">
                  Recorded {prettyDate(strike.createdAt)}. {strike.reason}
                </p>
                <p className={`text-xs ${strike.clearedAt ? "text-muted-foreground" : "text-foreground"}`}>
                  {strike.clearedAt ? `Cleared by the desk ${prettyDate(strike.clearedAt)}. ${strike.clearNote}` : "Active"}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
      {profile?.proofKey && (
        <a className="mt-3 inline-block text-sm text-link" href={`/api/verification/${user.id}`}>
          Download proof on file
        </a>
      )}
      {/* An approved file answers these on their own, since resubmitting the file below would reopen it. */}
      {profile?.status === "APPROVED" && (
        <form id="eligibility" action={saveEligibility} className="mt-8 scroll-mt-6 space-y-5 border border-border p-6 rounded-xl">
          <EligibilityFields homes={profile.homesControlled} strategy={profile.reoStrategy} answeredAt={profile.eligibilityAt} />
          <SubmitButton variant="outline" className="h-11 text-[13px] font-medium" pendingLabel="Saving…">
            Save the answers
          </SubmitButton>
          <p className="text-xs text-muted-foreground">Saving these doesn&apos;t reopen your file or change its status.</p>
        </form>
      )}
      {/* More buying entities open once the main file is approved. Each one waits for the desk like the main file. */}
      {(profile?.status === "APPROVED" || entities.length > 0) && (
        <section id="entities" aria-labelledby="entities-heading" className="mt-8 scroll-mt-6 border border-border p-6 rounded-xl">
          <p id="entities-heading" className="eyebrow">Other buying entities</p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Buy through another LLC, a trust or a self-directed IRA. Once the desk approves one, you choose it when you bid, and the closing papers name it. Your funds credential and record stay with your login.
          </p>
          {entities.length > 0 && (
            <ul className="mt-4 divide-y divide-border border border-border rounded-xl">
              {entities.map((entity) => (
                <li key={entity.id} className="px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="font-medium text-foreground">{entity.name}</p>
                    <p className={`text-[13px] font-medium ${entity.status === "APPROVED" ? "text-good" : entity.status === "REJECTED" ? "text-bad" : "text-link"}`}>
                      {entity.status === "SUBMITTED" ? "With the desk" : entity.status === "APPROVED" ? "Approved" : entity.status === "REJECTED" ? "Declined" : entity.status.replaceAll("_", " ").toLowerCase()}
                    </p>
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    {entityLabel(entity.entityType)}
                    {entity.entityType === "IRA" ? ` · custodian ${entity.iraCustodian} · vests as ${entity.iraAccountTitle}` : entity.jurisdiction ? ` · formed in ${entity.jurisdiction}` : ""}
                  </p>
                  {entity.reviewerNote && <p className="mt-1 text-muted-foreground">The desk: {entity.reviewerNote}</p>}
                </li>
              ))}
            </ul>
          )}
          {profile?.status === "APPROVED" ? (
            <BuyerEntityForm kinds={ENTITY_KINDS} iraNote={IRA_NOTE} titleExample={IRA_TITLE_EXAMPLE} />
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">New entities open again once the desk approves your main file.</p>
          )}
        </section>
      )}
      <form action={submitVerification} className="mt-8 space-y-5 glass p-6">
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Entity</span>
          <select name="entityType" defaultValue={profile?.entityType || "INDIVIDUAL"} className="desk-input mt-2">
            {ENTITIES.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Legal name</span>
          <Input name="entityName" defaultValue={profile?.entityName} className="mt-2 h-11 bg-card" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Formed in</span>
          <Input name="jurisdiction" defaultValue={profile?.jurisdiction} placeholder="Florida" className="mt-2 h-11 bg-card" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Proof of funds</span>
          <input name="proof" type="file" className="mt-2 block text-sm text-muted-foreground" />
        </label>
        <label className="block">
          <span className="text-[13px] text-muted-foreground">Amount the proof shows, in dollars</span>
          <Input name="proofAmount" inputMode="decimal" defaultValue={profile?.proofAmount ?? ""} placeholder="250000" className="mt-2 h-11 bg-card" required />
        </label>
        {profile?.status !== "APPROVED" && (
          <div id="eligibility" className="scroll-mt-6 space-y-5">
            <EligibilityFields homes={profile?.homesControlled ?? null} strategy={profile?.reoStrategy ?? null} answeredAt={profile?.eligibilityAt ?? null} />
          </div>
        )}
        <label className="flex items-start gap-3 text-sm leading-relaxed text-muted-foreground">
          <input type="checkbox" name="accredited" value="yes" defaultChecked={profile?.accredited} className="mt-1" />
          <span>{ACCREDITATION_TEXT}</span>
        </label>
        <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Sending…">
          Submit to the desk
        </SubmitButton>
      </form>
    </div>
  );
}

// Asked for the federal limit on large single-family investors. The buyer's own statement; the desk doesn't verify it.
function EligibilityFields({ homes, strategy, answeredAt }: { homes: number | null; strategy: string | null; answeredAt: Date | null }) {
  return (
    <>
      <div>
        <p className="eyebrow">Two eligibility questions</p>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {ELIGIBILITY_INTRO}
          {answeredAt ? ` You last answered on ${prettyDate(answeredAt)}.` : ""}
        </p>
      </div>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Single-family homes you and your affiliates control</span>
        <Input name="homesControlled" inputMode="numeric" pattern="[0-9,]*" required defaultValue={homes ?? ""} placeholder="0" className="mt-2 h-11 bg-card tabular-nums" />
        <span className="mt-1 block text-xs text-muted-foreground">{HOMES_HELP}</span>
      </label>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">What you do with homes taken by foreclosure</span>
        <select name="reoStrategy" required defaultValue={strategy ?? ""} className="desk-input mt-2">
          <option value="" disabled>Choose one</option>
          {REO_STRATEGIES.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
    </>
  );
}
