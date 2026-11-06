"use client"

import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"
import { useThemeChoice } from "@/components/theme-toggle"

const Toaster = ({ ...props }: ToasterProps) => {
  // "system" lets Sonner follow the OS, the same rule the page follows.
  const theme = useThemeChoice()

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      // Toasts stack just above the desk's tab bar (below 1024px) and a listing's bid bar, wherever those show.
      offset={{ bottom: "calc(var(--dock, 0px) + var(--bar, 0px) + 24px)" }}
      mobileOffset={{ bottom: "calc(var(--dock, 0px) + var(--bar, 0px) + 12px)" }}
      icons={{
        success: (
          <CircleCheckIcon className="size-4 text-good" />
        ),
        info: (
          <InfoIcon className="size-4 text-link" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4 text-warn" />
        ),
        error: (
          <OctagonXIcon className="size-4 text-bad" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "calc(var(--radius) * 1.2)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast shadow-pop! text-sm",
          description: "text-muted-foreground!",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
