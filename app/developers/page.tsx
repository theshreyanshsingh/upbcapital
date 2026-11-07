import type { Metadata } from "next";
import { PublicPage } from "@/components/public-page";
import { API_LIMIT } from "@/lib/api-limit";

export const metadata: Metadata = {
  title: "Seller API",
  description: "Institutional sellers can push a tape and read offer status with an API key, and receive signed webhooks.",
};

export default function DevelopersPage() {
  return (
    <PublicPage title="The seller API." lede="Institutional accounts mint a key at Seller API. Send it as a bearer token. The key is stored as a hash.">
      <p>POST /api/v1/tapes with JSON. title is the pool name. csv is the tape, using the same headers as the upload template. The listing is submitted for review and the response is listingId and loans.</p>
      <p>GET /api/v1/offers returns bids on listings this key’s account owns: id, status, amount, listing title. GET /api/v1/offers/:id returns one of them. On a sealed listing before its deadline, amount is null, sealed is true, and the message history is empty.</p>
      <p>Each key may make {API_LIMIT.requests} requests a minute. Past that, the API answers 429 with a Retry-After header in seconds and a JSON body with error and retryAfter. Wait that long, then go on.</p>
      <p>A webhook URL must be https on a public host. It receives offer.created, offer.accepted, offer.declined, and offer.countered, and you can pick which for each endpoint. An offer declined because another bid won carries reason another_bid_accepted. The body is JSON. x-upb-signature is the hex HMAC-SHA256 of the raw body, using the secret shown once when the endpoint is saved.</p>
      <p>Answer a webhook with any 2xx status. Anything else, or no answer within five seconds, counts as a failure, and the same body is sent again after 1 minute, 10 minutes, 1 hour, 6 hours and 24 hours, then no more. Every try carries x-upb-delivery, which stays the same across tries, and x-upb-attempt, which counts them, so you can drop a repeat. The Seller API page lists recent deliveries with their answers and can send any one again.</p>
      <p>Scheduled jobs are separate. A host can call GET /api/cron with Authorization: Bearer $CRON_SECRET, or run npm run jobs on a worker. That sends buy-box digests, task reminders, bid-deadline notices, closing-step reminders, the new owner’s sale-notice reminders, closed-auction notices, data-room destruction requests, webhook retries, and retention cleanup.</p>
    </PublicPage>
  );
}
