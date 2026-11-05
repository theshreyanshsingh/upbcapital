"use client";

import { postOfferMessage } from "@/actions/offers";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { money } from "@/lib/format";

export function OfferThread({
  inquiryId,
  canCounter,
  messages,
  acceptAmount,
  acceptFrom = "desk",
}: {
  inquiryId: string;
  canCounter: boolean;
  messages: { id: string; kind: string; body: string; amount: number | null; author: string; when: string }[];
  // The desk's open counter, shown to the buyer as one click to accept. A counter alone is never awarded.
  acceptAmount?: number | null;
  // Whose counter it is. The seller's own counter is already their approval, so accepting it needs no second ask.
  acceptFrom?: "desk" | "seller";
}) {
  const seller = acceptFrom === "seller";
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
      {canCounter && acceptAmount != null && (
        <form action={postOfferMessage} className="mt-4 flex flex-wrap items-center gap-3 border border-link/30 bg-link/5 p-3 rounded-xl">
          <input type="hidden" name="inquiryId" value={inquiryId} />
          <input type="hidden" name="amount" value={acceptAmount} />
          <p className="text-sm text-foreground">
            {seller
              ? `The seller countered at ${money(acceptAmount)}. The seller has already agreed to this price. Nothing is awarded until you accept it.`
              : `The desk countered at ${money(acceptAmount)}. Nothing is awarded until you accept a price.`}
          </p>
          <ConfirmSubmit
            title={`Accept the ${seller ? "seller" : "desk"}'s ${money(acceptAmount)}?`}
            consequence={
              seller
                ? "Your bid becomes this price, which the seller has already approved, so the desk can award it without asking again. If it does, you're committed to buy at it plus the buyer premium, and a deposit falls due."
                : "Your bid becomes this price. If the desk awards it, you're committed to buy at it plus the buyer premium, and a deposit falls due."
            }
            confirmLabel={`Accept ${money(acceptAmount)}`}
            pendingLabel="Accepting…"
            className="h-9 text-[13px] font-medium"
          >
            Accept {money(acceptAmount)}
          </ConfirmSubmit>
        </form>
      )}
      <form action={postOfferMessage} className="mt-4 space-y-3">
        <input type="hidden" name="inquiryId" value={inquiryId} />
        <label className="block text-[13px] text-muted-foreground">
          Message the other side
          <Textarea name="body" className="mt-1 min-h-20 bg-card" />
        </label>
        {canCounter && (
          <label className="block text-[13px] text-muted-foreground">
            New price (optional, only if you are moving the price)
            <Input name="amount" inputMode="decimal" className="mt-1 h-11 bg-card" />
          </label>
        )}
        <SubmitButton variant="outline" className="h-9 text-[13px] font-medium" pendingLabel="Sending…">
          {canCounter ? "Send note or counter" : "Send note"}
        </SubmitButton>
      </form>
    </div>
  );
}
