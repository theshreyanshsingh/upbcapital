import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { SAMPLE_TAPE_ROWS, TAPE_HEADERS } from "@/lib/tape-fields";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const format = new URL(request.url).searchParams.get("format");
  if (format === "xlsx") {
    const sheet = XLSX.utils.aoa_to_sheet([TAPE_HEADERS, ...SAMPLE_TAPE_ROWS]);
    sheet["!cols"] = TAPE_HEADERS.map(() => ({ wch: 22 }));
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Tape");
    const buffer = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": "attachment; filename=upb-capital-tape-template.xlsx",
      },
    });
  }
  const lines = [TAPE_HEADERS, ...SAMPLE_TAPE_ROWS]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  return new NextResponse(lines, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=upb-capital-tape-template.csv",
    },
  });
}
