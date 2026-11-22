import { importTemplateCsv } from "@/lib/portfolio-import";

export const runtime = "nodejs";

// The portfolio import's template: the columns a note added by hand takes, and one fictional row to show the format.
// The same file for everyone, so it needs no sign-in.
export async function GET() {
  return new Response(importTemplateCsv(), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="upb-capital-portfolio-template.csv"',
    },
  });
}
