"use client";

import { useActionState, useState } from "react";
import { login, signup } from "@/actions/auth";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type DemoDesk = { password: string; accounts: { role: string; email: string }[] };

export function LoginPanel({ next, demo }: { next?: string; demo?: DemoDesk }) {
  const [state, action] = useActionState(login, { error: "" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState(demo?.password ?? "");
  return (
    <div className={demo ? "grid gap-6 md:grid-cols-[380px_minmax(0,1fr)]" : ""}>
      <form action={action} className="glass space-y-4 self-start p-7 shadow-[var(--shadow)]">
        <input type="hidden" name="next" value={next ?? ""} />
        <div>
          <Label htmlFor="email" className="text-[13px] text-muted-foreground">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1.5 h-10 bg-card" required />
        </div>
        <div>
          <Label htmlFor="password" className="text-[13px] text-muted-foreground">Password</Label>
          <Input id="password" name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1.5 h-10 bg-card" required />
        </div>
        {state.error && <p className="text-sm text-bad">{state.error}</p>}
        <SubmitButton className="h-10 w-full text-[13px] font-semibold" pendingLabel="Checking…">
          Enter
        </SubmitButton>
      </form>
      {demo && (
        <aside className="space-y-2">
          <p className="eyebrow">Demo desk</p>
          <p className="text-sm text-muted-foreground">Password for every sample account is {demo.password}</p>
          {demo.accounts.map((account) => (
            <button
              key={account.email}
              type="button"
              onClick={() => {
                setEmail(account.email);
                setPassword(demo.password);
              }}
              className="block w-full rounded-xl border border-border bg-card px-3.5 py-2.5 text-left transition hover:bg-hover"
            >
              <span className="block text-xs font-medium text-link">{account.role}</span>
              <span className="mt-1 block text-sm text-foreground">{account.email}</span>
            </button>
          ))}
        </aside>
      )}
    </div>
  );
}

export function SignupForm({ lead = "", email = "", referral = "" }: { lead?: string; email?: string; referral?: string }) {
  const [state, action] = useActionState(signup, { error: "" });
  const [role, setRole] = useState(lead ? "INDIVIDUAL_SELLER" : "BUYER");
  return (
    <form action={action} className="glass space-y-6 p-6 md:p-10">
      {lead && <input type="hidden" name="lead" value={lead} />}
      <div className="grid gap-3 sm:grid-cols-2">
        {[
          ["BUYER", "Buyer", "Underwrite the book."],
          ["INDIVIDUAL_SELLER", "Note seller", "List one loan."],
          ["INSTITUTIONAL_SELLER", "Institution", "Upload a tape."],
          ["BROKER", "Broker", "Bring a seller or a buyer."],
        ].map(([value, label, hint]) => (
          <label key={value} className="block cursor-pointer">
            <input type="radio" name="role" value={value} checked={role === value} onChange={() => setRole(value)} className="peer sr-only" />
            <span className="block border border-border p-4 peer-checked:border-link peer-checked:bg-link/10 rounded-xl">
              <span className="block font-semibold tracking-tight text-2xl text-foreground">{label}</span>
              <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Field name="name" label="Name" />
        <Field name="email" label="Email" type="email" defaultValue={email} />
        <Field name="password" label="Password" type="password" />
        <Field name="phone" label="Phone" />
        <Field name="referral" label="Referral code" defaultValue={referral} />
      </div>
      {role === "BROKER" && (
        <p className="text-sm leading-relaxed text-muted-foreground">
          Next you will add the company, the states you cover, a W-9, and a payout note. Leave the license blank if you only introduce people. Do not enter bank account numbers.
        </p>
      )}
      {role === "INSTITUTIONAL_SELLER" && (
        <div className="grid gap-4 md:grid-cols-2">
          <Field name="companyName" label="Company" />
          <label>
            <span className="text-[13px] text-muted-foreground">Company type</span>
            <select name="companyType" className="desk-input mt-2" defaultValue="FUND">
              <option value="BANK">Bank</option>
              <option value="FUND">Fund</option>
              <option value="SERVICER">Servicer</option>
              <option value="OTHER">Other</option>
            </select>
          </label>
        </div>
      )}
      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      <SubmitButton className="h-11 px-6 text-[13px] font-medium" pendingLabel="Creating…">
        Create account
      </SubmitButton>
    </form>
  );
}

function Field({ name, label, type = "text", defaultValue }: { name: string; label: string; type?: string; defaultValue?: string }) {
  return (
    <label>
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <Input name={name} type={type} defaultValue={defaultValue} className="mt-2 h-11 bg-card" />
    </label>
  );
}
