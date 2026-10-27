"use client";

import { useActionState } from "react";
import { createApiKey, saveWebhook, type RevealState } from "@/actions/keys";
import { SubmitButton } from "@/components/submit-button";

const empty: RevealState = { secret: "", error: "" };

export function MintKeyForm() {
  const [state, action] = useActionState(createApiKey, empty);
  return (
    <div className="mt-4 max-w-xl">
      {state.secret && <p className="mb-4 break-all border border-link/40 p-4 text-sm text-foreground rounded-xl" role="status">Copy this key now. It is stored only as a hash. {state.secret}</p>}
      <form action={action} className="flex gap-3">
        <input name="name" className="desk-input" aria-label="Key name" placeholder="Key name" />
        <SubmitButton className="h-11 text-[13px] font-medium">Mint a key</SubmitButton>
      </form>
    </div>
  );
}

export function WebhookForm() {
  const [state, action] = useActionState(saveWebhook, empty);
  return (
    <div className="mt-10 max-w-xl">
      {state.secret && <p className="mb-4 break-all border border-link/40 p-4 text-sm text-foreground rounded-xl" role="status">Webhook secret, shown once. {state.secret}</p>}
      {state.error && <p role="alert" className="mb-4 border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad rounded-xl">{state.error}</p>}
      <form action={action} className="flex gap-3">
        <input name="url" className="desk-input" aria-label="Webhook URL" placeholder="https://example.com/upb" />
        <SubmitButton variant="outline" className="h-11 text-[13px] font-medium">Add webhook</SubmitButton>
      </form>
    </div>
  );
}
