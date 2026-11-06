"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { SheetHandle } from "@/components/ui/sheet-handle"
import { XIcon } from "lucide-react"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-overlay duration-(--dur-2) ease-(--ease-enter) supports-backdrop-filter:backdrop-blur-[2px] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 data-closed:duration-(--dur-1) data-closed:ease-(--ease-exit)",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  phone = "sheet",
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
  phone?: "sheet" | "top"
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-2xl bg-popover p-5 text-sm text-popover-foreground shadow-float ring-1 ring-border duration-(--dur-2) ease-(--ease-enter) outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98] data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-[0.98] data-closed:duration-(--dur-1) data-closed:ease-(--ease-exit)",
          // On a phone a dialog rises from the bottom edge as a sheet, its buttons within reach of a thumb. One
          // with a search field instead hangs from the top, clear of the keyboard.
          phone === "sheet" &&
            "max-sm:top-auto max-sm:bottom-0 max-sm:max-h-[92dvh] max-sm:max-w-none max-sm:translate-y-0 max-sm:overflow-y-auto max-sm:rounded-b-none max-sm:rounded-t-[22px] max-sm:pb-[calc(1.25rem+env(safe-area-inset-bottom))] max-sm:data-open:zoom-in-100 max-sm:data-open:slide-in-from-bottom-8 max-sm:data-closed:zoom-out-100 max-sm:data-closed:slide-out-to-bottom-8",
          phone === "top" &&
            "max-sm:top-[max(0.5rem,env(safe-area-inset-top))] max-sm:max-w-[calc(100%-1rem)] max-sm:translate-y-0 max-sm:rounded-[18px] max-sm:data-open:zoom-in-100 max-sm:data-open:slide-in-from-top-4 max-sm:data-closed:zoom-out-100 max-sm:data-closed:slide-out-to-top-4",
          className
        )}
        {...props}
      >
        {phone === "sheet" && <SheetHandle className="-mx-5 -mt-5 -mb-2 h-6 sm:hidden" />}
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-3 right-3"
                size="icon-sm"
              />
            }
          >
            <XIcon
            />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-5 -mb-5 flex flex-col-reverse gap-2 rounded-b-2xl border-t bg-muted/60 px-5 py-4 sm:flex-row sm:justify-end max-sm:sticky max-sm:bottom-[calc(-1.25rem-env(safe-area-inset-bottom))] max-sm:-mb-[calc(1.25rem+env(safe-area-inset-bottom))] max-sm:rounded-b-none max-sm:pb-[calc(1rem+env(safe-area-inset-bottom))] max-sm:*:data-[slot=button]:h-12 max-sm:*:data-[slot=button]:rounded-xl max-sm:*:data-[slot=button]:text-[15px]",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-[1.0625rem] leading-snug font-semibold tracking-[-0.01em] pr-8",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "type-body text-muted-foreground *:[a]:text-link *:[a]:underline *:[a]:underline-offset-3",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
