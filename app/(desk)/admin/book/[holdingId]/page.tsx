import Link from "next/link";
import { notFound } from "next/navigation";
import { addLossTask, completeLossTask, handoffReo, listSlice, logOutreach, quoteSlice, relistDeskNote, saveLossStatus, saveMilestone, savePlan } from "@/actions/assets";
import { ensureUnitCosts } from "@/actions/rehab";
import { RehabPanel } from "@/components/rehab-panel";
import { Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { money, prettyDate, q } from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Loss file" };

const STATUSES = ["OUTREACH", "REINSTATEMENT", "FORBEARANCE", "MODIFICATION", "FORECLOSURE", "REO", "RESOLVED"];

export default async function LossFilePage({
  params,
  searchParams,
}: {
  params: Promise<{ holdingId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireRole(["ADMIN"]);
  await ensureUnitCosts();
  const { holdingId } = await params;
  const query = await searchParams;
  const holding = await prisma.deskHolding.findUnique({
    where: { id: holdingId },
    include: {
      listing: { include: { notes: true } },
      payments: { orderBy: { paidOn: "desc" } },
      participations: { orderBy: { createdAt: "desc" } },
      rehab: { include: { lines: true, bids: { orderBy: { createdAt: "asc" } }, draws: true } },
      lossCase: {
        include: {
          outreach: { orderBy: { contactedAt: "desc" } },
          plans: { orderBy: { createdAt: "desc" } },
          milestones: { orderBy: { courtDate: "asc" } },
          tasks: { orderBy: { dueOn: "asc" } },
          property: true,
        },
      },
    },
  });
  if (!holding) notFound();
  const file = holding.lossCase;
  const borrower = holding.listing.notes[0]?.borrowerName || "Borrower";
  return (
    <div>
      <Link href="/admin/book" className="text-[13px] font-medium text-link">Desk book</Link>
      <Notice notice={q(query, "notice")} error={q(query, "error")} />
      {(q(query, "buyerIrr") || q(query, "sellerIrr")) && (
        <p className="mt-4 text-sm text-foreground">
          Split model · buyer IRR {q(query, "buyerIrr") || "—"}% · holder keeps {q(query, "sellerIrr") || "—"}%.
        </p>
      )}
      <p className="eyebrow mt-4">Asset file</p>
      <h1 className="mt-3 font-semibold tracking-tight text-[28px] text-foreground">{holding.title}</h1>
      <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
        Cost {money(Number(holding.costBasis))} · UPB {money(Number(holding.upb))} · {borrower}. Outreach, a workout, foreclosure dates, and a rehab exit live on this file.
      </p>

      <section className="glass mt-8 p-6">
        <p className="eyebrow">File status</p>
        <form action={saveLossStatus} className="mt-4 grid gap-3 sm:grid-cols-[220px_minmax(0,1fr)_auto]">
          <input type="hidden" name="holdingId" value={holding.id} />
          <select name="status" defaultValue={file?.status || "OUTREACH"} className="desk-input" aria-label="Loss file status">
            {STATUSES.map((status) => <option key={status} value={status}>{status.toLowerCase()}</option>)}
          </select>
          <input name="summary" defaultValue={file?.summary || ""} className="desk-input" aria-label="File summary" placeholder="Where the file stands" />
          <SubmitButton className="h-11 text-[13px] font-medium">Save</SubmitButton>
        </form>
      </section>

      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="border border-border p-5 rounded-xl">
          <p className="eyebrow">Borrower outreach</p>
          <ul className="mt-4 space-y-3">
            {(file?.outreach ?? []).length === 0 && <li className="text-sm text-muted-foreground">No calls logged. A name on the mock OFAC list stops the log until it is cleared.</li>}
            {file?.outreach.map((row) => (
              <li key={row.id} className="text-sm">
                <p className="text-foreground">{prettyDate(row.contactedAt)} · {row.channel}</p>
                <p className="text-muted-foreground">{row.note}</p>
              </li>
            ))}
          </ul>
          <form action={logOutreach} className="mt-4 grid gap-3">
            <input type="hidden" name="holdingId" value={holding.id} />
            <div className="grid gap-3 sm:grid-cols-2">
              <input name="contactedAt" type="date" className="desk-input" aria-label="Outreach date" required />
              <select name="channel" className="desk-input" aria-label="Outreach channel">
                <option value="phone">Phone</option>
                <option value="email">Email</option>
                <option value="letter">Letter</option>
                <option value="door">Door</option>
              </select>
            </div>
            <input name="note" className="desk-input" aria-label="Outreach note" placeholder="What was said" required />
            <SubmitButton className="h-11 text-[13px] font-medium">Log contact</SubmitButton>
          </form>
        </div>
        <div className="border border-border p-5 rounded-xl">
          <p className="eyebrow">Workout plans</p>
          <ul className="mt-4 space-y-3">
            {(file?.plans ?? []).length === 0 && <li className="text-sm text-muted-foreground">No reinstatement, forbearance, or modification yet.</li>}
            {file?.plans.map((plan) => (
              <li key={plan.id} className="text-sm text-muted-foreground">
                <span className="text-foreground">{plan.kind.toLowerCase()}</span> · {money(Number(plan.amount))}
                {plan.months ? ` · ${plan.months} mo` : ""}
                {Number(plan.rate) ? ` · ${Number(plan.rate)}%` : ""}
                {plan.note ? ` · ${plan.note}` : ""}
              </li>
            ))}
          </ul>
          <form action={savePlan} className="mt-4 grid gap-3">
            <input type="hidden" name="holdingId" value={holding.id} />
            <select name="kind" className="desk-input" aria-label="Plan kind">
              <option value="REINSTATEMENT">Reinstatement</option>
              <option value="FORBEARANCE">Forbearance</option>
              <option value="MODIFICATION">Modification</option>
            </select>
            <div className="grid gap-3 sm:grid-cols-3">
              <input name="amount" className="desk-input" aria-label="Plan amount" placeholder="Amount" />
              <input name="months" className="desk-input" aria-label="Plan months" placeholder="Months" />
              <input name="rate" className="desk-input" aria-label="Plan rate" placeholder="Rate %" />
            </div>
            <input name="startOn" type="date" className="desk-input" aria-label="Plan start" />
            <input name="note" className="desk-input" aria-label="Plan note" placeholder="Terms" />
            <SubmitButton className="h-11 text-[13px] font-medium">Save plan</SubmitButton>
          </form>
        </div>
      </section>

      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="border border-border p-5 rounded-xl">
          <p className="eyebrow">Foreclosure</p>
          <ul className="mt-4 space-y-3">
            {(file?.milestones ?? []).length === 0 && <li className="text-sm text-muted-foreground">No attorney or court dates yet. Florida is judicial; the clock starts when the complaint is filed.</li>}
            {file?.milestones.map((step) => (
              <li key={step.id} className="text-sm">
                <p className="text-foreground">{step.label}</p>
                <p className="text-muted-foreground">
                  {step.attorney || "No attorney"}
                  {step.courtDate ? ` · court ${prettyDate(step.courtDate)}` : ""}
                  {step.filedOn ? ` · filed ${prettyDate(step.filedOn)}` : ""}
                  {step.note ? ` · ${step.note}` : ""}
                </p>
              </li>
            ))}
          </ul>
          <form action={saveMilestone} className="mt-4 grid gap-3">
            <input type="hidden" name="holdingId" value={holding.id} />
            <input name="label" className="desk-input" aria-label="Milestone" placeholder="Complaint, hearing, sale" required />
            <input name="attorney" className="desk-input" aria-label="Attorney" placeholder="Attorney" />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-medium text-muted-foreground">Filed<input name="filedOn" type="date" className="desk-input mt-2" aria-label="Filed on" /></label>
              <label className="block text-xs font-medium text-muted-foreground">Court<input name="courtDate" type="date" className="desk-input mt-2" aria-label="Court date" /></label>
            </div>
            <input name="note" className="desk-input" aria-label="Milestone note" placeholder="Note" />
            <SubmitButton className="h-11 text-[13px] font-medium">Add milestone</SubmitButton>
          </form>
        </div>
        <div className="border border-border p-5 rounded-xl">
          <p className="eyebrow">Deadlines</p>
          <ul className="mt-4 space-y-3">
            {(file?.tasks ?? []).length === 0 && <li className="text-sm text-muted-foreground">No tasks. Due dates also show on the desk book.</li>}
            {file?.tasks.map((task) => (
              <li key={task.id} className="flex items-center justify-between gap-3 text-sm">
                <span className={task.doneAt ? "text-muted-foreground line-through" : "text-foreground"}>{task.title} · {prettyDate(task.dueOn)}</span>
                {!task.doneAt && (
                  <form action={completeLossTask}>
                    <input type="hidden" name="holdingId" value={holding.id} />
                    <input type="hidden" name="id" value={task.id} />
                    <SubmitButton variant="ghost" className="h-8 text-[13px] font-medium">Done</SubmitButton>
                  </form>
                )}
              </li>
            ))}
          </ul>
          <form action={addLossTask} className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px_auto]">
            <input type="hidden" name="holdingId" value={holding.id} />
            <input name="title" className="desk-input" aria-label="Task" placeholder="Call counsel" required />
            <input name="dueOn" type="date" className="desk-input" aria-label="Due date" required />
            <SubmitButton className="h-11 text-[13px] font-medium">Add</SubmitButton>
          </form>
        </div>
      </section>

      <section className="glass mt-8 p-6">
        <p className="eyebrow">REO hand-off</p>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          When the note becomes the house, open a property record with a rehab budget and a resale or rental exit. South Florida labor and materials belong in that budget.
        </p>
        {file?.property && (
          <p className="mt-4 text-sm text-foreground">
            {file.property.address} · rehab {money(Number(file.property.rehabBudget))} · {file.property.exitPath.toLowerCase()}
            {Number(file.property.exitValue) ? ` · exit ${money(Number(file.property.exitValue))}` : ""}
            {Number(file.property.monthlyRent) ? ` · rent ${money(Number(file.property.monthlyRent))}` : ""}
          </p>
        )}
        <form action={handoffReo} className="mt-4 grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="holdingId" value={holding.id} />
          <label className="block sm:col-span-2"><span className="text-[13px] text-muted-foreground">Address</span><input name="address" defaultValue={file?.property?.address || ""} className="desk-input mt-2" aria-label="Property address" required /></label>
          <label className="block"><span className="text-[13px] text-muted-foreground">Rehab budget</span><input name="rehabBudget" defaultValue={file?.property ? Number(file.property.rehabBudget) : ""} className="desk-input mt-2" aria-label="Rehab budget" required /></label>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Exit</span>
            <select name="exitPath" defaultValue={file?.property?.exitPath || "RESALE"} className="desk-input mt-2" aria-label="Exit path">
              <option value="RESALE">Resale</option>
              <option value="RENTAL">Rental</option>
            </select>
          </label>
          <label className="block"><span className="text-[13px] text-muted-foreground">Exit value</span><input name="exitValue" defaultValue={file?.property ? Number(file.property.exitValue) : ""} className="desk-input mt-2" aria-label="Exit value" /></label>
          <label className="block"><span className="text-[13px] text-muted-foreground">Monthly rent</span><input name="monthlyRent" defaultValue={file?.property ? Number(file.property.monthlyRent) : ""} className="desk-input mt-2" aria-label="Monthly rent" /></label>
          <label className="block sm:col-span-2"><span className="text-[13px] text-muted-foreground">Scope</span><input name="note" defaultValue={file?.property?.note || ""} className="desk-input mt-2" aria-label="Rehab scope" placeholder="Roof, kitchen, rental set" /></label>
          <SubmitButton className="h-11 text-[13px] font-medium">Open the property</SubmitButton>
        </form>
      </section>

      <RehabPanel
        holdingId={holding.id}
        basis={Number(holding.costBasis)}
        costs={await prisma.unitCost.findMany({ where: { region: "South Florida" }, orderBy: { trade: "asc" } })}
        estimate={holding.rehab}
      />

      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <form action={relistDeskNote} className="border border-border p-5 rounded-xl">
          <p className="eyebrow">Relist the note</p>
          <p className="mt-2 text-sm text-muted-foreground">One price puts this note back on the book, with the same documents, the payment log, and the loan facts. It goes live as a desk listing.</p>
          <input type="hidden" name="holdingId" value={holding.id} />
          <input name="askingPrice" className="desk-input mt-4" aria-label="Relist asking price" placeholder="Asking price" required />
          <SubmitButton className="mt-3 h-11 text-[13px] font-medium">Relist</SubmitButton>
        </form>
        <div className="border border-border p-5 rounded-xl">
          <p className="eyebrow">Participation</p>
          <p className="mt-2 text-sm text-muted-foreground">Sell a percent of the note, or the next few payments. The model splits the cash flows before anything is listed.</p>
          <form action={quoteSlice} className="mt-4 grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="holdingId" value={holding.id} />
            <input type="hidden" name="side" value="desk" />
            <input name="percent" className="desk-input" aria-label="Percent sold" placeholder="Percent" defaultValue="50" />
            <input name="paymentCount" className="desk-input" aria-label="Payments sold" placeholder="Or payment count" />
            <input name="price" className="desk-input sm:col-span-2" aria-label="Slice price" placeholder="Price for the slice" required />
            <SubmitButton className="h-11 text-[13px] font-medium">Model the split</SubmitButton>
          </form>
          <ul className="mt-4 space-y-3">
            {holding.participations.map((slice) => (
              <li key={slice.id} className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <span className="text-foreground">
                  {slice.paymentCount ? `${slice.paymentCount} payments` : `${Number(slice.percent)}%`} · {money(Number(slice.price))} · {slice.status.toLowerCase()}
                </span>
                {slice.status === "DRAFT" && (
                  <form action={listSlice}>
                    <input type="hidden" name="id" value={slice.id} />
                    <SubmitButton variant="outline" className="h-9 text-[13px] font-medium">List it</SubmitButton>
                  </form>
                )}
                {slice.listingId && <Link href={`/admin/listings/${slice.listingId}`} className="text-link">Open listing</Link>}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
