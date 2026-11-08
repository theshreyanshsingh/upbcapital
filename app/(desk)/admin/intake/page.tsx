import Link from "next/link";
import { cookies } from "next/headers";
import { discardDeskIntake, fileDeskIntakeTape, stageDeskIntake } from "@/actions/desk-intake";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { StatusPill } from "@/components/status-pill";
import { SubmitButton } from "@/components/submit-button";
import { bandLabel, INTAKE_COOKIE, intakeSellers, MAX_POOLS, poolTitle, readIntakeCookie, SPLIT_RULES, stagedIntake, type IntakePreview } from "@/lib/desk-intake";
import { money, pct, prettyDate, q } from "@/lib/format";
import { labelOf } from "@/lib/labels";
import { prisma } from "@/lib/prisma";
import { requireDesk } from "@/lib/staff";

export const metadata = { title: "Tape intake" };

const LOANS_SHOWN = 10;

export default async function IntakePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireDesk("sales", "/admin");
  const params = await searchParams;
  const jar = await cookies();
  const saved = readIntakeCookie(jar.get(INTAKE_COOKIE)?.value);
  const [preview, sellers, filed] = await Promise.all([
    saved ? stagedIntake(user.id, saved) : Promise.resolve(null),
    intakeSellers(),
    prisma.listing.findMany({
      where: { filedByDeskId: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { id: true, title: true, status: true, createdAt: true, sellerConfirmedAt: true, seller: { select: { name: true, companyName: true } }, _count: { select: { notes: true } } },
    }),
  ]);
  return (
    <div>
      <PageIntro
        eyebrow="Acquisitions"
        title="File a seller's tape."
        lede="Upload the tape a seller sent, or their servicer's export, and file it in their name. Split it into pools if they want. The seller confirms each listing before the desk can approve it."
      />
      <Notice notice={q(params, "notice")} error={q(params, "error")} />
      {preview ? <Preview preview={preview} /> : <StageForm sellers={sellers} />}
      <section id="filed" aria-labelledby="filed-heading" className="mt-10 scroll-mt-6">
        <h2 id="filed-heading" className="eyebrow">Filed by the desk</h2>
        <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
          {filed.length === 0 && <li className="px-5 py-6 text-sm text-muted-foreground">Nothing filed for a seller yet.</li>}
          {filed.map((listing) => (
            <li key={listing.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <Link href={`/admin/listings/${listing.id}`} className="font-medium text-link">{listing.title}</Link>
                <p className="text-sm text-muted-foreground">
                  {listing.seller.companyName || listing.seller.name} · {listing._count.notes === 1 ? "1 loan" : `${listing._count.notes} loans`} · filed {prettyDate(listing.createdAt)} ·{" "}
                  {listing.sellerConfirmedAt ? `confirmed ${prettyDate(listing.sellerConfirmedAt)}` : "waiting for the seller"}
                </p>
              </div>
              <StatusPill status={listing.status} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function StageForm({ sellers }: { sellers: Awaited<ReturnType<typeof intakeSellers>> }) {
  return (
    <form action={stageDeskIntake} className="grid max-w-3xl gap-4 border border-border p-5 rounded-xl sm:grid-cols-2">
      <label className="block sm:col-span-2">
        <span className="text-[13px] text-muted-foreground">Seller account</span>
        <select name="sellerId" required defaultValue="" className="desk-input mt-2">
          <option value="" disabled>Choose the seller</option>
          {sellers.map((seller) => (
            <option key={seller.id} value={seller.id}>{seller.companyName ? `${seller.companyName} · ${seller.name}` : seller.name} · {seller.email}</option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-muted-foreground">Approved seller accounts only. Invite a new seller from Valuations or Accounts first.</span>
      </label>
      <label className="block sm:col-span-2">
        <span className="text-[13px] text-muted-foreground">Tape</span>
        <input type="file" name="file" required accept=".csv,.xlsx,.xls" className="mt-2 block w-full text-sm" />
        <span className="mt-1 block text-xs text-muted-foreground">CSV or Excel, up to 10 MB and 2,000 loans. A servicer&apos;s export from FCI, BSI and the like reads too.</span>
      </label>
      <fieldset className="sm:col-span-2">
        <legend className="text-[13px] text-muted-foreground">Asking price</legend>
        <div className="mt-2 flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="radio" name="priceMode" value="COLUMN" defaultChecked /> From the tape&apos;s price column</label>
          <label className="flex items-center gap-2"><input type="radio" name="priceMode" value="PERCENT" /> Percent of UPB</label>
          <input name="percent" inputMode="decimal" aria-label="Percent of UPB" placeholder="80" className="desk-input h-9 w-24" />
        </div>
      </fieldset>
      <fieldset className="sm:col-span-2">
        <legend className="text-[13px] text-muted-foreground">Split into pools by</legend>
        <div className="mt-2 flex flex-wrap gap-4 text-sm">
          {SPLIT_RULES.map((rule) => (
            <label key={rule.value} className="flex items-center gap-2"><input type="checkbox" name="rule" value={rule.value} /> {rule.label}</label>
          ))}
        </div>
        <span className="mt-1 block text-xs text-muted-foreground">Leave all unchecked for one listing. Rules combine: state and performing makes one pool per state and status, up to {MAX_POOLS}.</span>
      </fieldset>
      <label className="block sm:col-span-2">
        <span className="text-[13px] text-muted-foreground">Balance band edges, for a balance split</span>
        <input name="bands" className="desk-input mt-2" placeholder="100k, 250k" autoComplete="off" />
        <span className="mt-1 block text-xs text-muted-foreground">100k, 250k makes three bands: {bandLabel(0, [100000, 250000])}, {bandLabel(1, [100000, 250000])}, and {bandLabel(2, [100000, 250000])}.</span>
      </label>
      <div className="sm:col-span-2"><SubmitButton className="h-10 text-[13px] font-medium" pendingLabel="Reading…">Preview the tape</SubmitButton></div>
    </form>
  );
}

function Preview({ preview }: { preview: IntakePreview }) {
  const { tape, pools, seller } = preview;
  const upb = pools.reduce((sum, pool) => sum + pool.upb, 0);
  const ask = tape.loans.reduce((sum, loan) => sum + loan.askingPrice, 0);
  const defaultTitle = `${seller.companyName || seller.name} tape`;
  return (
    <section id="preview" aria-labelledby="preview-heading" className="scroll-mt-6 space-y-5">
      <div>
        <h2 id="preview-heading" className="eyebrow">Preview</h2>
        <p className="mt-2 text-sm text-foreground">{preview.filename} · for {seller.companyName ? `${seller.companyName} (${seller.name})` : seller.name}</p>
        <dl className="mt-3 grid grid-cols-2 gap-px bg-muted sm:grid-cols-4">
          {[
            ["Loans read", String(tape.loans.length)],
            ["Rows with errors", String(new Set(tape.errors.map((issue) => issue.row)).size)],
            ["UPB", money(upb)],
            ["Asking", money(ask)],
          ].map(([k, v]) => (
            <div key={k} className="bg-card/80 px-3 py-2">
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="mt-0.5 text-sm font-medium tabular-nums text-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      {preview.problem && (
        <p role="alert" className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-foreground">{preview.problem} Fix the tape and upload it again.</p>
      )}
      <div className="border border-border p-4 rounded-xl">
        <p className="eyebrow">{tape.quality.errors} errors · {tape.quality.warnings} warnings · {tape.quality.fixes} auto-fixes</p>
        {tape.quality.flags.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No data issues on the mapped columns.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {tape.quality.flags.slice(0, 12).map((flag, index) => (
              <li key={`${flag.row}-${flag.field}-${index}`} className={flag.level === "error" ? "text-bad" : flag.level === "warn" ? "text-foreground" : "text-muted-foreground"}>
                Row {flag.row}: {flag.message}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Columns read: {tape.columns.map((column) => `${column.field} (${column.header})`).join(", ") || "none"}.
          {tape.unused.length ? ` Not read: ${tape.unused.join(", ")}.` : ""}
        </p>
      </div>
      {tape.loans.length > 0 && (
        <div>
          <h3 className="text-[13px] font-medium text-foreground">{tape.loans.length > LOANS_SHOWN ? `The first ${LOANS_SHOWN} of ${tape.loans.length} loans` : "The loans"}</h3>
          <div className="relative mt-2 overflow-x-auto border border-border rounded-xl">
            <table className="min-w-full text-left text-xs">
              <thead className="font-medium text-muted-foreground">
                <tr>{["Loan", "Property", "Lien", "Status", "UPB", "Rate", "Asking"].map((heading) => <th key={heading} className="px-3 py-2 font-normal">{heading}</th>)}</tr>
              </thead>
              <tbody>
                {tape.loans.slice(0, LOANS_SHOWN).map((loan, index) => (
                  <tr key={index} className="border-t border-border">
                    <td className="px-3 py-2 text-muted-foreground">{loan.loanNumber || index + 1}</td>
                    <td className="px-3 py-2 text-foreground">{loan.streetAddress}, {loan.city}, {loan.state}</td>
                    <td className="px-3 py-2 text-muted-foreground">{labelOf("lien", loan.lienPosition)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{labelOf("payment", loan.paymentStatus)}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{money(loan.upb)}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{pct(loan.interestRate, 3)}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{money(loan.askingPrice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {!preview.problem && (
        <>
          <div className="relative overflow-x-auto border border-border rounded-xl">
            <table className="min-w-full text-left text-sm">
              <thead className="text-xs font-medium text-muted-foreground">
                <tr>{["Pool", "Loans", "UPB", "Asking"].map((heading) => <th key={heading} className="px-3 py-2 font-normal">{heading}</th>)}</tr>
              </thead>
              <tbody>
                {pools.map((pool) => (
                  <tr key={pool.key} className="border-t border-border">
                    <td className="px-3 py-2 text-foreground">{pool.label || "Whole tape"}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{pool.loans.length}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{money(pool.upb)}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{money(pool.loans.reduce((sum, loan) => sum + loan.askingPrice, 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <form action={fileDeskIntakeTape} className="grid gap-3 border border-border p-5 rounded-xl sm:grid-cols-2">
            <input type="hidden" name="token" value={preview.token} />
            <label className="block sm:col-span-2">
              <span className="text-[13px] text-muted-foreground">Pool name</span>
              <input name="title" required minLength={3} maxLength={100} defaultValue={defaultTitle} className="desk-input mt-2" />
              <span className="mt-1 block text-xs text-muted-foreground">
                Each listing is named {poolTitle("the pool name", pools[0]?.label ?? "")}{pools.length > 1 ? ", and so on" : ""}.
              </span>
            </label>
            <label className="block sm:col-span-2">
              <span className="text-[13px] text-muted-foreground">Narrative</span>
              <textarea name="summary" maxLength={2000} className="desk-input mt-2 min-h-20" placeholder="Optional. Buyers read it once the listing is live." />
            </label>
            <div className="sm:col-span-2">
              <ConfirmSubmit
                title={`File ${pools.length === 1 ? "one listing" : `${pools.length} listings`} for the seller?`}
                consequence="Each listing goes to the review queue in the seller's name, marked as filed by the desk. The seller is emailed to confirm the tape. None can be approved until they do."
                confirmLabel="File the listings"
                pendingLabel="Filing…"
                className="h-10 text-[13px] font-medium"
              >
                {pools.length === 1 ? "File the listing" : `File ${pools.length} listings`}
              </ConfirmSubmit>
            </div>
          </form>
        </>
      )}
      <form action={discardDeskIntake}>
        <SubmitButton variant="ghost" className="h-9 px-0 text-[13px] font-medium text-link" pendingLabel="Setting aside…">Set this tape aside</SubmitButton>
      </form>
    </section>
  );
}
