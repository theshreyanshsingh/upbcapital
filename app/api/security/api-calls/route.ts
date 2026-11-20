import { callsDownload } from "@/lib/api-log";
import { getApiUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The account's API calls from the last 90 days as a CSV, from its Buyer API or Seller API page. The desk's compliance
// role names an account with ?account= (lib/api-log.ts).
export async function GET(request: Request) {
  return callsDownload(await getApiUser(), new URL(request.url).searchParams.get("account"));
}
