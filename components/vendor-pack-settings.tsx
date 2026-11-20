import { saveVendorPackFacts } from "@/actions/vendor-pack";
import { SubmitButton } from "@/components/submit-button";
import { NOT_SET, type SecurityPack } from "@/lib/vendor-pack";

const FIELDS: { name: keyof SecurityPack; label: string; hint: string; type?: string; inputMode?: "decimal" }[] = [
  { name: "penTestDate", label: "Last penetration test", hint: "The day an outside firm finished testing.", type: "date" },
  { name: "penTestFirm", label: "Firm that ran it", hint: "Named in the pack beside the date." },
  { name: "cyberInsurer", label: "Cyber insurer", hint: "The carrier on the policy in force." },
  { name: "incidentContact", label: "Incident contact", hint: "A name with an email address or a phone number." },
  { name: "rtoHours", label: "Recovery time objective (hours)", hint: "How long the site may be down after an outage.", inputMode: "decimal" },
  { name: "rpoHours", label: "Recovery point objective (hours)", hint: "How much recent data an outage may lose.", inputMode: "decimal" },
];

// The facts the vendor pack takes from the desk, on the compliance page. Blank means the pack says so: a missing test
// reads "Not yet in place", the rest "Not set by the desk". Compliance edits; other desk roles read.
export function VendorPackSettings({ pack, readOnly }: { pack: SecurityPack; readOnly: boolean }) {
  return (
    <section id="vendor-pack" aria-labelledby="vendor-pack-heading" className="glass mt-8 scroll-mt-6 p-5 md:p-6">
      <p id="vendor-pack-heading" className="eyebrow">Vendor pack</p>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
        Banks and credit unions get the pack from /security: a PDF of UPB&apos;s controls and answers to a standard questionnaire, read from the code
        and the configuration. These are the facts it can&apos;t read for itself. Enter only what is true today. A blank field tells the reader it
        isn&apos;t in place or isn&apos;t set.
      </p>
      {readOnly ? (
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          {FIELDS.map((field) => (
            <div key={field.name} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{field.label}</dt>
              <dd className="break-words text-sm text-foreground">{pack[field.name] ?? NOT_SET}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <form action={saveVendorPackFacts} className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {FIELDS.map((field) => (
              <label key={field.name} className="block min-w-0 text-sm">
                <span className="text-foreground">{field.label}</span>
                <input
                  name={field.name}
                  type={field.type ?? "text"}
                  inputMode={field.inputMode}
                  defaultValue={pack[field.name] ?? ""}
                  className="desk-input mt-1 w-full"
                  autoComplete="off"
                />
                <span className="mt-1 block text-xs text-muted-foreground">{field.hint}</span>
              </label>
            ))}
          </div>
          <SubmitButton pendingLabel="Saving…" className="h-11 w-full text-[13px] font-medium sm:w-fit">Save vendor pack facts</SubmitButton>
        </form>
      )}
    </section>
  );
}
