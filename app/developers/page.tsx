import type { Metadata } from "next";
import { PublicPage } from "@/components/public-page";

export const metadata: Metadata = {
  title: "Seller API",
  description: "Institutional sellers can push a tape and read offer status with an API key, and receive signed webhooks.",
};

export default function DevelopersPage() {
  return (
    <PublicPage title="The seller API." lede="Institutional accounts mint a key at Seller API. Send it as a bearer token. The key is stored as a hash.">
      <p>POST /api/v1/tapes with JSON. title is the pool name. csv is the tape, using the same headers as the upload template. The listing is submitted for review and the response is listingId and loans.</p>
      <p>GET /api/v1/offers returns bids on listings this key’s account owns: id, status, amount, listing title. GET /api/v1/offers/:id returns one of them. On a sealed listing before its deadline, amount is null, sealed is true, and the message history is empty.</p>
      <p>A webhook URL receives offer.created, offer.accepted, offer.declined, and offer.countered. The body is JSON. x-upb-signature is the hex HMAC-SHA256 of the raw body, using the secret shown once when the endpoint is saved.</p>
      <p>Scheduled jobs are separate. A host can call GET /api/cron with Authorization: Bearer $CRON_SECRET, or run npm run jobs on a worker. That sends buy-box digests, task reminders, bid-deadline notices, and retention cleanup.</p>
    </PublicPage>
  );
}
