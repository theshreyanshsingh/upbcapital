"use client";

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// A binding action (an award, an approval, a cancel) asks once, in words that restate the price and what
// happens next, before its form submits. Everything else on the desk stays one click.
// It sits inside the action's own <form>, so the form's fields and the pending state are the form's.
export function ConfirmSubmit({
  children,
  title,
  details,
  consequence,
  confirmLabel,
  pendingLabel = "Working…",
  tone = "default",
  variant,
  className,
  name,
  value,
  typed,
}: {
  children: React.ReactNode;
  title: string;
  details?: React.ReactNode;
  // Figures the person typed into this form, restated in the dialog: [label, field name, "money" | "text"].
  typed?: [string, string, "money" | "text"][];
  consequence: string;
  confirmLabel: string;
  pendingLabel?: string;
  tone?: "default" | "danger";
  variant?: "default" | "outline" | "ghost" | "secondary" | "destructive";
  className?: string;
  name?: string;
  value?: string;
}) {
  const [open, setOpen] = useState(false);
  const [entered, setEntered] = useState<[string, string][]>([]);
  const { pending } = useFormStatus();
  const anchor = useRef<HTMLButtonElement>(null);
  const submitter = useRef<HTMLButtonElement>(null);

  function ask() {
    const form = anchor.current?.form;
    // The form's own checks run first, so the dialog never confirms something the browser would refuse.
    if (form && !form.reportValidity()) return;
    setEntered(
      (typed ?? []).map(([label, field, kind]) => {
        const raw = String((form?.elements.namedItem(field) as HTMLInputElement | null)?.value ?? "").trim();
        const amount = Number(raw.replace(/[$,\s]/g, ""));
        if (!raw) return [label, "Not entered"];
        return [label, kind === "money" && Number.isFinite(amount) ? amount.toLocaleString("en-US", { style: "currency", currency: "USD" }) : raw];
      }),
    );
    setOpen(true);
  }

  function confirm() {
    setOpen(false);
    const form = anchor.current?.form;
    const button = submitter.current;
    if (!form || !button) return;
    // The submitter stays disabled so Enter in a field can't submit past the question. It's enabled only for
    // this one synchronous submit, which reads the form there and then.
    button.disabled = false;
    form.requestSubmit(button);
    button.disabled = true;
  }

  return (
    <>
      <Button
        ref={anchor}
        type="button"
        onClick={ask}
        disabled={pending}
        aria-haspopup="dialog"
        variant={variant ?? (tone === "danger" ? "destructive" : "default")}
        className={className}
      >
        {pending ? pendingLabel : children}
      </Button>
      {/* The submitter carries a name and value when the action reads which button was pressed. */}
      <button ref={submitter} type="submit" name={name} value={value} hidden disabled tabIndex={-1} aria-hidden="true" />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{consequence}</DialogDescription>
          </DialogHeader>
          {details || entered.length ? (
            <div className="space-y-2 rounded-lg border border-border p-3 text-sm text-foreground">
              {details}
              {entered.length ? <ConfirmRows rows={entered} /> : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} autoFocus>
              Go back
            </Button>
            <Button
              type="button"
              onClick={confirm}
              className={cn(tone === "danger" && "bg-destructive text-background hover:bg-destructive/90")}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// Rows of figures for a confirmation, aligned so amounts read down a column.
export function ConfirmRows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="space-y-1">
      {rows.map(([label, amount]) => (
        <div key={label} className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="tabular-nums">{amount}</dd>
        </div>
      ))}
    </dl>
  );
}
