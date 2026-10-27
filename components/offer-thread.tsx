"use client";

import { postOfferMessage } from "@/actions/offers";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { money } from "@/lib/format";

export function OfferThread({
  inquiryId,
  canCounter,
  messages,
}: {
  inquiryId: string;
  canCounter: boolean;
  messages: { id: string; kind: string; body: string; amount: number | null; author: string; when: string }[];
}) {
  return (
    <div className="mt-4 border-t border-border pt-4">
      <ul className="space-y-3">
        {messages.map((message) => (
          <li key={message.id}>
            <p className="text-xs font-medium text-link">
              {message.kind.toLowerCase()} · {message.author} · {message.when}
            </p>
            <p className="mt-1 text-sm text-foreground/90">
              {message.amount != null ? `${money(message.amount)} · ` : ""}
              {message.body}
            </p>
          </li>
        ))}
      </ul>
      <form action={postOfferMessage} className="mt-4 space-y-3">
        <input type="hidden" name="inquiryId" value={inquiryId} />
        <Textarea name="body" placeholder="Message the other side" className="min-h-20 bg-card" />
        {canCounter && <Input name="amount" inputMode="decimal" placeholder="Counter amount, if you are moving the price" className="h-11 bg-card" />}
        <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Sending…">
          {canCounter ? "Send note or counter" : "Send note"}
        </SubmitButton>
      </form>
    </div>
  );
}
