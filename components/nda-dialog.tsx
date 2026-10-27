"use client";

import { useRef, useState } from "react";
import { signNda } from "@/actions/buyer";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NDA_TERMS } from "@/lib/nda-terms";

export function NdaDialog({ listingId, listingTitle }: { listingId: string; listingTitle: string }) {
  const [open, setOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [method, setMethod] = useState<"TYPED" | "DRAWN">("TYPED");
  const [signerName, setSignerName] = useState("");
  const [signatureData, setSignatureData] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    drawing.current = true;
    canvas.setPointerCapture(event.pointerId);
    const at = point(event);
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(at.x, at.y);
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const at = point(event);
    ctx.lineTo(at.x, at.y);
    ctx.stroke();
  }

  function end() {
    drawing.current = false;
    const canvas = canvasRef.current;
    if (canvas) setSignatureData(canvas.toDataURL("image/png"));
  }

  function clearPad() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setSignatureData("");
  }

  const ready = agreed && signerName.trim().length > 1 && (method === "TYPED" || signatureData.length > 0);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" className="h-11 px-4 text-[13px] font-medium" />}>
        Sign confidentiality
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-semibold tracking-tight text-3xl">Sign for {listingTitle}</DialogTitle>
          <DialogDescription className="leading-relaxed">
            Street, borrower, and the data room stay closed until this agreement is signed. The desk stores a PDF with your name, the time, and the network address of this request.
          </DialogDescription>
        </DialogHeader>
        <form action={signNda} className="space-y-5">
          <input type="hidden" name="listingId" value={listingId} />
          <input type="hidden" name="agreed" value={agreed ? "yes" : "no"} />
          <input type="hidden" name="method" value={method} />
          <input type="hidden" name="signatureData" value={signatureData} />
          <p className="text-sm leading-relaxed text-muted-foreground">{NDA_TERMS}</p>
          <label className="block">
            <span className="text-[13px] text-muted-foreground">Legal name</span>
            <Input name="signerName" value={signerName} onChange={(event) => setSignerName(event.target.value)} className="mt-2 h-11 bg-card" placeholder="Name as it should appear on the PDF" />
          </label>
          <div className="flex gap-2">
            {(["TYPED", "DRAWN"] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => setMethod(choice)}
                className={`h-9 border px-3 text-[13px] font-medium ${method === choice ? "border-link text-link" : "border-border text-muted-foreground"}`}
              >
                {choice === "TYPED" ? "Typed" : "Drawn"}
              </button>
            ))}
          </div>
          {method === "DRAWN" && (
            <div>
              <canvas
                ref={canvasRef}
                width={640}
                height={200}
                onPointerDown={start}
                onPointerMove={move}
                onPointerUp={end}
                onPointerLeave={end}
                className="h-28 w-full touch-none rounded-lg border border-border bg-white"
              />
              <button type="button" onClick={clearPad} className="mt-2 text-[13px] font-medium text-muted-foreground">
                Clear
              </button>
            </div>
          )}
          <label className="flex items-start gap-3 text-sm leading-relaxed text-muted-foreground">
            <Checkbox checked={agreed} onCheckedChange={(value) => setAgreed(value === true)} className="mt-1" />
            <span>I agree, and I intend this {method === "DRAWN" ? "drawn" : "typed"} signature to be my electronic signature.</span>
          </label>
          <Button type="submit" disabled={!ready} className="h-11 px-5 text-[13px] font-medium">
            Sign and unlock
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
