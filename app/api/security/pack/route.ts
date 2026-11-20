import { getApiUser } from "@/lib/auth";
import { packDownload } from "@/lib/vendor-pack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The vendor pack as a PDF, or its questionnaire answers with format=csv, for approved institutional sellers, approved
// buyers and the desk. Everyone else asks the desk. Each download is audited (lib/vendor-pack.ts).
export async function GET(request: Request) {
  return packDownload(await getApiUser(), new URL(request.url).searchParams.get("format"));
}
