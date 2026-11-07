import type { Servicer } from "@prisma/client";
import { saveServicerAction, setServicerActiveAction } from "@/actions/servicers";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { Notice } from "@/components/notice";
import { PageIntro } from "@/components/page-intro";
import { SubmitButton } from "@/components/submit-button";
import { requireRole } from "@/lib/auth";
import { q } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { allServicers, FEE_MAX, IMPORT_FORMATS, importFormatLabel, NAME_MAX, NOTE_MAX } from "@/lib/servicers";
import { deskCan } from "@/lib/staff";

export const metadata = { title: "Servicers" };

export default async function ServicersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Every desk role reads the directory. Keeping it is the closings side's, and the actions check the same.
  const runs = deskCan(await requireRole(["ADMIN"]), "closings");
  const query = await searchParams;
  const servicers = await allServicers();
  const named = servicers.length
    ? await prisma.servicerBoarding.findMany({ where: { servicerId: { in: servicers.map((row) => row.id) } }, select: { servicerId: true } })
    : [];
  const boardings = new Map<string, number>();
  for (const row of named) if (row.servicerId) boardings.set(row.servicerId, (boardings.get(row.servicerId) ?? 0) + 1);
  return (
    <div>
      <PageIntro
        eyebrow="Servicers"
        title="The servicer directory."
        lede="Buyers pick from this list when they board a closed loan. The public directory shows each active servicer's states, fees as entered here, and whether UPB reads their export. Desk notes stay on this page."
      />
      <Notice notice={q(query, "notice")} error={q(query, "error")} />
      {runs ? (
        <details className="mt-8 glass p-5" open={servicers.length === 0}>
          <summary className="cursor-pointer text-[15px] font-semibold text-foreground">Add a servicer</summary>
          <ServicerForm />
        </details>
      ) : (
        <p className="mt-8 text-sm text-muted-foreground">Your desk role reads this page. The closings side keeps the directory.</p>
      )}
      <ul className="mt-8 space-y-4">
        {servicers.length === 0 && <li className="border border-dashed border-border px-5 py-8 text-sm text-muted-foreground rounded-xl">No servicers yet. The public directory says the desk is adding them.</li>}
        {servicers.map((servicer) => {
          const count = boardings.get(servicer.id) ?? 0;
          return (
            <li key={servicer.id} id={`servicer-${servicer.id}`} className={`glass scroll-mt-6 p-5 ${servicer.active ? "" : "opacity-75"}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h2 className="font-semibold tracking-tight text-lg text-foreground">{servicer.name}</h2>
                <span className={`text-[13px] font-medium ${servicer.active ? "text-link" : "text-muted-foreground"}`}>{servicer.active ? "On the directory" : "Off the directory"}</span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {servicer.states.length ? servicer.states.join(", ") : "No states listed"}
                {" · "}
                {importFormatLabel(servicer.importFormat) ? `UPB reads their export (${importFormatLabel(servicer.importFormat)})` : "UPB doesn't read their export"}
                {count ? ` · named on ${count} boarding${count === 1 ? "" : "s"}` : ""}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Boarding {servicer.boardingFee || "not entered"} · monthly {servicer.monthlyFee || "not entered"}
                {servicer.contactEmail ? ` · ${servicer.contactEmail}` : ""}
              </p>
              {servicer.website && <a href={servicer.website} className="mt-1 inline-block text-[13px] font-medium text-link" rel="noopener noreferrer" target="_blank">{servicer.website}</a>}
              {servicer.notes && <p className="mt-2 whitespace-pre-line text-sm text-foreground/85">{servicer.notes}</p>}
              {runs && (
                <div className="mt-4 flex flex-wrap items-start gap-4 border-t border-border pt-4">
                  <details className="min-w-0 flex-1">
                    <summary className="cursor-pointer text-[13px] font-medium text-foreground">Edit<span className="sr-only"> {servicer.name}</span></summary>
                    <ServicerForm servicer={servicer} />
                  </details>
                  <form action={setServicerActiveAction}>
                    <input type="hidden" name="id" value={servicer.id} />
                    <input type="hidden" name="active" value={servicer.active ? "0" : "1"} />
                    {servicer.active ? (
                      <ConfirmSubmit
                        title={`Take ${servicer.name} off the directory?`}
                        consequence="Buyers can no longer pick it when they board a loan, and it leaves the public directory. Boardings that already name it keep it. You can put it back."
                        confirmLabel="Take it off"
                        pendingLabel="Saving…"
                        variant="outline"
                        className="h-10 text-[13px] font-medium"
                      >
                        Deactivate
                      </ConfirmSubmit>
                    ) : (
                      <SubmitButton variant="outline" className="h-10 text-[13px] font-medium">Put back on the directory</SubmitButton>
                    )}
                  </form>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// The same fields to add a servicer and to edit one.
function ServicerForm({ servicer }: { servicer?: Servicer }) {
  const key = servicer?.id ?? "new";
  return (
    <form action={saveServicerAction} className="mt-4 grid gap-3 sm:grid-cols-2">
      {servicer && <input type="hidden" name="id" value={servicer.id} />}
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Name</span>
        <input name="name" defaultValue={servicer?.name ?? ""} maxLength={NAME_MAX} className="desk-input mt-2" required />
      </label>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Website</span>
        <input name="website" defaultValue={servicer?.website ?? ""} inputMode="url" className="desk-input mt-2" placeholder="example.com" />
      </label>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Boarding email</span>
        <input name="contactEmail" type="email" defaultValue={servicer?.contactEmail ?? ""} className="desk-input mt-2" />
        <span className="mt-1 block text-xs text-muted-foreground">Fills the buyer&apos;s boarding form. Not shown on the public directory.</span>
      </label>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">States</span>
        <input name="states" defaultValue={servicer?.states.join(", ") ?? ""} className="desk-input mt-2" placeholder="FL, GA, TX" aria-describedby={`states-hint-${key}`} />
        <span id={`states-hint-${key}`} className="mt-1 block text-xs text-muted-foreground">Two-letter states, separated by commas.</span>
      </label>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Boarding fee</span>
        <input name="boardingFee" defaultValue={servicer?.boardingFee ?? ""} maxLength={FEE_MAX} className="desk-input mt-2" placeholder="As the servicer quotes it" />
      </label>
      <label className="block">
        <span className="text-[13px] text-muted-foreground">Monthly fee</span>
        <input name="monthlyFee" defaultValue={servicer?.monthlyFee ?? ""} maxLength={FEE_MAX} className="desk-input mt-2" placeholder="As the servicer quotes it" />
      </label>
      <label className="block sm:col-span-2">
        <span className="text-[13px] text-muted-foreground">Export UPB reads</span>
        <select name="importFormat" defaultValue={servicer?.importFormat ?? ""} className="desk-input mt-2">
          <option value="">None</option>
          {IMPORT_FORMATS.map((format) => <option key={format.value} value={format.value}>{format.label}</option>)}
        </select>
      </label>
      <label className="block sm:col-span-2">
        <span className="text-[13px] text-muted-foreground">Desk notes</span>
        <textarea name="notes" defaultValue={servicer?.notes ?? ""} maxLength={NOTE_MAX} className="desk-input mt-2 min-h-20" />
        <span className="mt-1 block text-xs text-muted-foreground">Only the desk sees these.</span>
      </label>
      <div className="sm:col-span-2">
        <SubmitButton className="h-11 text-[13px] font-medium">{servicer ? "Save servicer" : "Add to the directory"}</SubmitButton>
      </div>
    </form>
  );
}
