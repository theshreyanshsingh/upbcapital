"use client";

import { useState, useTransition } from "react";
import { createPoolListing } from "@/actions/listings";
import { Field } from "@/components/page-intro";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { money } from "@/lib/format";
import { bpsToPercent } from "@/lib/money";
import { TAPE_FIELDS, type TapeFieldKey } from "@/lib/tape-fields";

type TapeFlag = { row: number; level: "error" | "warn" | "fix"; field: string; message: string };

type Preview = {
  token: string;
  filename: string;
  headers: string[];
  rowCount: number;
  preview: Record<string, string>[];
  suggestions: Partial<Record<TapeFieldKey, string>>;
  flags?: TapeFlag[];
};

export function TapeWizard({
  premiumBps,
  commissionBps,
}: {
  premiumBps: number;
  commissionBps: number;
}) {
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [priceMode, setPriceMode] = useState<"COLUMN" | "PERCENT" | "POOL_TOTAL">("COLUMN");
  const [pricePercent, setPricePercent] = useState("70");
  const [poolTotal, setPoolTotal] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<TapeFieldKey, string>>>({});
  const [error, setError] = useState("");
  const [flags, setFlags] = useState<TapeFlag[]>([]);
  const [pending, start] = useTransition();

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError("");
    const body = new FormData();
    body.set("file", file);
    const response = await fetch("/api/tapes/preview", { method: "POST", body });
    const json = await response.json();
    if (!response.ok) {
      setError(json.error || "The tape could not be read.");
      return;
    }
    setPreview(json);
    setMapping(json.suggestions ?? {});
    setFlags(json.flags ?? []);
    setStep(2);
  }

  async function recheck() {
    if (!preview) return;
    const response = await fetch("/api/tapes/quality", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: preview.token, mapping }),
    });
    const json = await response.json();
    if (!response.ok) {
      setError(json.error || "The tape could not be checked.");
      return;
    }
    setFlags(json.flags ?? []);
  }

  function submit() {
    if (!preview) return;
    if (title.trim().length < 3) {
      setError("Name the pool.");
      setStep(0);
      return;
    }
    const missing = TAPE_FIELDS.filter((field) => field.required && !mapping[field.key]);
    if (priceMode === "COLUMN" && !mapping.askingPrice) missing.push({ key: "askingPrice", label: "Asking price", required: false });
    if (missing.length) {
      setError(`Map ${missing.map((field) => field.label).join(", ")}.`);
      return;
    }
    const formData = new FormData();
    formData.set("token", preview.token);
    formData.set("title", title);
    formData.set("summary", summary);
    formData.set("priceMode", priceMode);
    formData.set("pricePercent", pricePercent);
    formData.set("poolTotal", poolTotal);
    formData.set("mapping", JSON.stringify(mapping));
    start(async () => {
      const result = await createPoolListing(formData);
      if (result?.error) setError(result.error);
    });
  }

  return (
    <div className="space-y-8">
      <div className="flex gap-6 text-[13px] font-medium text-muted-foreground">
        {["Pool", "Tape", "Map", "Confirm"].map((label, index) => (
          <span key={label} className={index === step ? "text-link" : ""}>
            0{index + 1} {label}
          </span>
        ))}
      </div>
      {step === 0 && (
        <div className="glass grid gap-5 p-6 md:p-10">
          <Field label="Pool name">
            <Input className="h-11 bg-card" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Gulfstream 2026-1" />
          </Field>
          <Field label="What a buyer should know">
            <Textarea className="min-h-28 bg-card" value={summary} onChange={(event) => setSummary(event.target.value)} />
          </Field>
          <Field label="How the pool is priced">
            <select className="desk-input" value={priceMode} onChange={(event) => setPriceMode(event.target.value as typeof priceMode)}>
              <option value="COLUMN">Each loan has an asking price column</option>
              <option value="PERCENT">Price every loan at a percent of its UPB</option>
              <option value="POOL_TOTAL">One pool price, allocated by UPB</option>
            </select>
          </Field>
          {priceMode === "PERCENT" && (
            <Field label="Percent of UPB">
              <Input className="h-11 bg-card" value={pricePercent} onChange={(event) => setPricePercent(event.target.value)} />
            </Field>
          )}
          {priceMode === "POOL_TOTAL" && (
            <Field label="Pool asking price">
              <Input className="h-11 bg-card" value={poolTotal} onChange={(event) => setPoolTotal(event.target.value)} />
            </Field>
          )}
          <div className="flex justify-end">
            <Button type="button" className="h-11 px-5 text-[13px] font-medium" onClick={() => (title.trim().length < 3 ? setError("Name the pool.") : (setError(""), setStep(1)))}>
              Continue
            </Button>
          </div>
        </div>
      )}
      {step === 1 && (
        <div className="space-y-6">
          <label className="flex min-h-72 cursor-pointer flex-col items-center justify-center border border-dashed border-link/40 bg-link/5 px-6 text-center rounded-lg">
            <span className="eyebrow">Upload the tape</span>
            <span className="mt-4 font-semibold tracking-tight text-[28px] text-foreground">CSV or Excel</span>
            <span className="mt-3 max-w-md text-sm text-muted-foreground">The first row should be headers. We will suggest a mapping. Nothing is listed until you confirm.</span>
            <input type="file" accept=".csv,.xlsx,.xls" className="sr-only" onChange={(event) => onFile(event.target.files?.[0])} />
          </label>
          <div className="flex flex-wrap gap-4 text-[13px] font-medium">
            <a className="text-link" href="/api/tapes/template?format=csv">Download CSV template</a>
            <a className="text-link" href="/api/tapes/template?format=xlsx">Download Excel template</a>
          </div>
          <p className="max-w-xl text-sm text-muted-foreground">
            The template includes three fictional loans so you can try the mapper. Seller commission on a sale is {bpsToPercent(commissionBps).toFixed(2)}% of the accepted price. Buyers also pay a {bpsToPercent(premiumBps).toFixed(2)}% premium.
          </p>
        </div>
      )}
      {step === 2 && preview && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="eyebrow">{preview.filename}</p>
              <h2 className="mt-2 font-semibold tracking-tight text-lg text-foreground">{preview.rowCount} rows</h2>
            </div>
            <Button type="button" variant="outline" onClick={() => setStep(1)}>Replace file</Button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {TAPE_FIELDS.map((field) => (
              <label key={field.key} className="block">
                <span className="text-[13px] text-muted-foreground">{field.label}{field.required || (field.key === "askingPrice" && priceMode === "COLUMN") ? " · required" : ""}</span>
                <select
                  className="desk-input mt-2"
                  value={mapping[field.key] ?? ""}
                  onChange={(event) => setMapping((current) => ({ ...current, [field.key]: event.target.value }))}
                >
                  <option value="">Do not map</option>
                  {preview.headers.map((header) => (
                    <option key={header} value={header}>{header}</option>
                  ))}
                </select>
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  {mapping[field.key] ? preview.preview[0]?.[mapping[field.key]!] || "—" : " "}
                </span>
              </label>
            ))}
          </div>
          <div className="overflow-x-auto border border-border rounded-xl">
            <table className="min-w-full text-left text-xs">
              <thead className="text-xs font-medium text-muted-foreground">
                <tr>
                  {preview.headers.slice(0, 6).map((header) => (
                    <th key={header} className="px-3 py-2 font-normal">{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.preview.map((row, index) => (
                  <tr key={index} className={`border-t border-border ${flags.some((flag) => flag.row === index + 2 && flag.level !== "fix") ? "bg-bad/10" : ""}`}>
                    {preview.headers.slice(0, 6).map((header) => (
                      <td key={header} className="px-3 py-2 text-foreground/80">{row[header]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button type="button" variant="outline" onClick={recheck}>Recheck rows</Button>
            <Button type="button" className="h-11 px-5 text-[13px] font-medium" onClick={() => setStep(3)}>Review pool</Button>
          </div>
          <TapeFlags flags={flags} />
        </div>
      )}
      {step === 3 && preview && (
        <div className="glass p-6 md:p-10">
          <p className="eyebrow">Ready for the desk</p>
          <h2 className="mt-2 font-semibold tracking-tight text-[28px] text-foreground">{title}</h2>
          <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted-foreground">{summary || "No narrative."}</p>
          <p className="mt-6 text-sm text-foreground">{preview.rowCount} loans · {priceMode === "COLUMN" ? "priced from the tape" : priceMode === "PERCENT" ? `${pricePercent}% of UPB` : money(Number(poolTotal) || 0) + " allocated by UPB"}</p>
          <p className="mt-2 text-sm text-muted-foreground">Commission of {bpsToPercent(commissionBps).toFixed(2)}% is deducted from the accepted sale price, not from UPB.</p>
          <div className="mt-8 flex justify-between">
            <Button type="button" variant="ghost" onClick={() => setStep(2)}>Back</Button>
            <Button type="button" className="h-11 px-5 text-[13px] font-medium" disabled={pending} onClick={submit}>
              {pending ? "Creating…" : "Submit the pool"}
            </Button>
          </div>
        </div>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  );
}

function TapeFlags({ flags }: { flags: TapeFlag[] }) {
  if (!flags.length) return <p className="text-sm text-muted-foreground">No data issues on the mapped columns.</p>;
  const errors = flags.filter((flag) => flag.level === "error").length;
  const warnings = flags.filter((flag) => flag.level === "warn").length;
  const fixes = flags.filter((flag) => flag.level === "fix").length;
  return (
    <div className="border border-border p-4 rounded-xl">
      <p className="eyebrow">{errors} errors · {warnings} warnings · {fixes} auto-fixes</p>
      <ul className="mt-3 space-y-2 text-sm">
        {flags.slice(0, 12).map((flag, index) => (
          <li key={`${flag.row}-${flag.field}-${index}`} className={flag.level === "error" ? "text-bad" : flag.level === "warn" ? "text-foreground" : "text-muted-foreground"}>
            Row {flag.row}: {flag.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
