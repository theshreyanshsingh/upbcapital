import { redirect } from "next/navigation";
import { startSellerKyc, submitSellerFile } from "@/actions/seller-identity";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { requireUser } from "@/lib/auth";
import { prettyDate, q } from "@/lib/format";
import { entityLabel } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import {
  AUTHORITY_HELP,
  BROKER_AUTHORITY_HELP,
  ID_HELP,
  SELLER_ENTITIES,
  SELLER_FILE_HREF,
  TAX_ID_NOTE,
  keepsSellerFile,
  sellerFileLabel,
  sellerFileLocked,
  sellerIdentityRequired,
} from "@/lib/seller-identity";
import { getSettings } from "@/lib/settings";
import { kycMode } from "@/lib/vendors";

export const metadata = { title: "Seller verification" };

export default async function SellerVerificationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  if (!keepsSellerFile(user.role)) redirect(user.role === "ADMIN" ? SELLER_FILE_HREF : "/");
  const params = await searchParams;
  const [profile, settings] = await Promise.all([prisma.sellerProfile.findUnique({ where: { userId: user.id } }), getSettings()]);
  const status = profile?.status ?? "NOT_STARTED";
  const locked = sellerFileLocked(status);
  const required = sellerIdentityRequired(settings);
  const vendor = kycMode();
  // A broker is the seller of record on what they file. Their authority is their own license or firm's; each note
  // holder's mandate goes on that listing.
  const broker = user.role === "BROKER";
  const who = broker
    ? "The desk confirms who you are and that you may act as a broker. Each note holder's mandate goes on the listing you file for them."
    : "The desk confirms who you are and that the person signing may sell the note.";
  return (
    <div className="max-w-2xl">
      <PageIntro
        eyebrow="Seller file"
        title="Who is selling."
        lede={
          required
            ? `${who} ${broker ? "The deals you file" : "Your listings"} wait for this file before they go live.`
            : `${who} Once it approves, buyers see that the seller's identity is verified.`
        }
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {status !== "NOT_STARTED" && (
        <p className="mt-4 text-sm text-foreground">
          Status: {sellerFileLabel(status)}
          {profile?.submittedAt ? ` · sent ${prettyDate(profile.submittedAt)}` : ""}
          {profile?.reviewedAt ? ` · decided ${prettyDate(profile.reviewedAt)}` : ""}
        </p>
      )}
      {profile?.reviewerNote && <p className="mt-1 text-sm text-muted-foreground">The desk: {profile.reviewerNote}</p>}
      {profile?.vendor && profile.vendorRef && !locked && (
        <p className="mt-1 text-sm text-muted-foreground">Your {profile.vendor === "persona" ? "Persona" : profile.vendor === "parallel" ? "Parallel Markets" : profile.vendor} check is on the file.</p>
      )}
      {vendor !== "mock" && !locked && (
        <form action={startSellerKyc} className="mt-6 border border-border p-5 rounded-xl">
          <p className="eyebrow">Vendor check</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Open {vendor === "persona" ? "Persona" : "Parallel Markets"} to confirm who you are. It checks identity only. The desk still reads the file below before it approves.
          </p>
          <SubmitButton variant="outline" className="mt-4 h-11 text-[13px] font-medium">Continue with {vendor === "persona" ? "Persona" : "Parallel"}</SubmitButton>
        </form>
      )}
      {profile && (profile.idDocKey || profile.authorityDocKey) && (
        <p className="mt-4 text-sm">
          {profile.idDocKey && <a className="text-link" href={`/api/seller-identity/${user.id}/id`}>Identity document on file</a>}
          {profile.idDocKey && profile.authorityDocKey && " · "}
          {profile.authorityDocKey && <a className="text-link" href={`/api/seller-identity/${user.id}/authority`}>Authority document on file</a>}
        </p>
      )}
      {locked ? (
        <section aria-labelledby="file-heading" className="mt-8 border border-border p-6 rounded-xl">
          <p id="file-heading" className="eyebrow">{status === "APPROVED" ? "Approved file" : "Declined file"}</p>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Seller</dt>
              <dd className="text-foreground">{profile?.entityName} · {entityLabel(profile?.entityType).toLowerCase()}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Signs</dt>
              <dd className="text-foreground">{profile?.signerName}{profile?.signerTitle ? `, ${profile.signerTitle}` : ""}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">EIN or SSN</dt>
              <dd className="text-foreground tabular-nums">{profile?.taxIdLast4 ? `Ends in ${profile.taxIdLast4}` : "Not given"}</dd>
            </div>
          </dl>
          <p className="mt-4 text-sm text-muted-foreground">{locked}</p>
        </section>
      ) : (
        <form action={submitSellerFile} className="mt-8 space-y-5 glass p-6">
          <label className="block">
            <span className="text-[13px] text-muted-foreground">{broker ? "You work as" : "You sell as"}</span>
            <select name="entityType" defaultValue={profile?.entityType || "INDIVIDUAL"} className="desk-input mt-2">
              {SELLER_ENTITIES.map((entity) => (
                <option key={entity.value} value={entity.value}>{entity.label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">{broker ? "Your legal name, or your firm's" : "Legal name the note is held in"}</span>
            <Input name="entityName" required maxLength={180} defaultValue={profile?.entityName || user.companyName || ""} className="mt-2 h-11 bg-card" />
            <span className="mt-1 block text-xs text-muted-foreground">
              {broker
                ? "Exactly as it reads on your license or firm papers. You are the seller of record on what you file, and closing papers name it once the desk approves."
                : "Your own name, or the entity's exactly as it reads on the note or the assignment. Closing papers name it once the desk approves."}
            </span>
          </label>
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Person who signs</span>
              <Input name="signerName" required maxLength={120} defaultValue={profile?.signerName || user.name} className="mt-2 h-11 bg-card" />
            </label>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Their title</span>
              <Input name="signerTitle" maxLength={80} defaultValue={profile?.signerTitle} placeholder="Managing member" className="mt-2 h-11 bg-card" />
              <span className="mt-1 block text-xs text-muted-foreground">{broker ? "Leave blank if you work as yourself." : "Leave blank if you sell as yourself."}</span>
            </label>
          </div>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Last four digits of the EIN or SSN</span>
            <Input
              name="taxIdLast4"
              required
              inputMode="numeric"
              pattern="[0-9]{4}"
              minLength={4}
              maxLength={4}
              autoComplete="off"
              defaultValue={profile?.taxIdLast4 ?? ""}
              placeholder="1234"
              className="mt-2 h-11 w-32 bg-card tabular-nums"
            />
            <span className="mt-1 block text-xs text-muted-foreground">{TAX_ID_NOTE}</span>
          </label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Identity document{profile?.idDocKey ? ", to replace the one on file" : ""}</span>
            <input name="idDoc" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" required={!profile?.idDocKey} className="mt-2 block text-sm text-muted-foreground" />
            <span className="mt-1 block text-xs text-muted-foreground">{ID_HELP}</span>
          </label>
          <div>
            <label className="block">
              <span className="text-[13px] text-muted-foreground">Authority document{profile?.authorityDocKey ? ", to replace the one on file" : ""}</span>
              <input name="authorityDoc" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" required={!profile?.authorityDocKey} className="mt-2 block text-sm text-muted-foreground" />
            </label>
            {broker ? (
              <p className="mt-1 text-xs text-muted-foreground">{BROKER_AUTHORITY_HELP}</p>
            ) : (
              <>
                <p className="mt-1 text-xs text-muted-foreground">Proof the person signing may sell the note.</p>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {SELLER_ENTITIES.map((entity) => (
                    <li key={entity.value}>
                      <span className="text-foreground">{entity.label}:</span> {AUTHORITY_HELP[entity.value]}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
          <p className="text-xs text-muted-foreground">PDF or image, up to 10 MB each. Only you and the desk&apos;s compliance staff can open them.</p>
          <SubmitButton className="h-11 text-[13px] font-medium" pendingLabel="Sending…">
            {status === "NOT_STARTED" ? "Send to the desk" : "Send the file again"}
          </SubmitButton>
        </form>
      )}
    </div>
  );
}
