"use client";

import { useActionState } from "react";
import { createBuyerKey, saveBuyerWebhook, type BuyerRevealState } from "@/actions/buyer-api";
import { SubmitButton } from "@/components/submit-button";

const empty: BuyerRevealState = { secret: "", error: "" };

function Reveal({ state, lead }: { state: BuyerRevealState; lead: string }) {
  return (
    <>
      {state.secret && <p className="mb-4 break-all border border-link/40 p-4 text-sm text-foreground rounded-xl" role="status">{lead} {state.secret}</p>}
      {state.error && <p role="alert" className="mb-4 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad rounded-xl">{state.error}</p>}
    </>
  );
}

export function BuyerKeyForm({ scopes }: { scopes: { scope: string; label: string }[] }) {
  const [state, action] = useActionState(createBuyerKey, empty);
  return (
    <div className="mt-4 max-w-xl">
      <Reveal state={state} lead="Copy this key now. It is stored only as a hash." />
      <form action={action}>
        <fieldset>
          <legend className="text-[13px] text-muted-foreground">Scopes</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {scopes.map((item) => (
              <label key={item.scope} className="flex items-start gap-2 text-sm text-foreground">
                <input type="checkbox" name="scopes" value={item.scope} defaultChecked className="mt-1" />
                <span>{item.label} <span className="text-xs text-muted-foreground">{item.scope}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mt-3 flex gap-3">
          <input name="name" className="desk-input" aria-label="Key name" placeholder="Key name" maxLength={80} />
          <SubmitButton className="h-11 text-[13px] font-medium">Mint a key</SubmitButton>
        </div>
      </form>
    </div>
  );
}

export function BuyerWebhookForm() {
  const [state, action] = useActionState(saveBuyerWebhook, empty);
  return (
    <div className="mt-4 max-w-xl">
      <Reveal state={state} lead="Webhook secret, shown once." />
      <form action={action} className="flex gap-3">
        <input name="url" className="desk-input" aria-label="Webhook URL" placeholder="https://example.com/upb" />
        <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">Add webhook</SubmitButton>
      </form>
    </div>
  );
}
