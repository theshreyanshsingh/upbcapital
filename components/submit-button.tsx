"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

export function SubmitButton({
  children,
  pendingLabel = "Working…",
  className,
  variant = "default",
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  className?: string;
  variant?: "default" | "outline" | "ghost" | "secondary";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} variant={variant} className={className}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
