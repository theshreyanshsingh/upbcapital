import * as React from "react"
import { cn } from "cn"

// A desk table: it scrolls inside its own frame on a phone (the page never does), heads are labels, and
// a numeric column right-aligns with tabular figures so amounts read down the column.

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto rounded-xl border border-border bg-card">
      <table data-slot="table" className={cn("w-full min-w-full caption-bottom text-left text-sm", className)} {...props} />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("bg-muted/60 [&_tr]:border-b", className)} {...props} />
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props} />
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return <tfoot data-slot="table-footer" className={cn("border-t bg-muted/60 font-medium [&>tr]:last:border-b-0", className)} {...props} />
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn("border-b border-border transition-colors hover:bg-hover/60 data-[state=selected]:bg-active", className)}
      {...props}
    />
  )
}

function TableHead({ className, numeric = false, ...props }: React.ComponentProps<"th"> & { numeric?: boolean }) {
  return (
    <th
      data-slot="table-head"
      scope="col"
      className={cn(
        "h-9 px-3 align-middle text-[0.8125rem] font-medium whitespace-nowrap text-muted-foreground",
        numeric && "text-right",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, numeric = false, ...props }: React.ComponentProps<"td"> & { numeric?: boolean }) {
  return (
    <td
      data-slot="table-cell"
      className={cn("px-3 py-2.5 align-middle", numeric && "figure text-right whitespace-nowrap", className)}
      {...props}
    />
  )
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return <caption data-slot="table-caption" className={cn("mt-3 px-3 pb-3 text-left text-xs text-muted-foreground", className)} {...props} />
}

export { Table, TableHeader, TableBody, TableFooter, TableRow, TableHead, TableCell, TableCaption }
