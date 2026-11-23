# Deploy UPB Capital

First production host is Vercel, connected to the private Origin repo `gt-tharma/upb-capital`, with MongoDB Atlas: the `upb_capital` database on the SynergyFund cluster. Do not run `npm run db:seed` against that database; the seed starts by dropping the database. The Vercel build builds the indexes and creates one admin. It never loads the demo desk.

## Checklist

1. In Atlas, on the SynergyFund cluster, add a database user whose only role is `readWrite` on `upb_capital`. Do not reuse SynergyFund's user. Under Network Access, allow Vercel to connect (Vercel functions have no fixed IP, so that is usually `0.0.0.0/0` with a strong password). Copy the connection string and put `/upb_capital` after the host.
2. In Vercel, import `gt-tharma/upb-capital` from Origin. Framework preset is Next.js. Leave the build command as `npm run build`.
3. Set the required variables below for **Production** and **Preview**. The build reads them. A preview build without them fails closed instead of migrating the wrong database.
4. Deploy from the Vercel dashboard. This repo does not deploy itself.
5. Open `https://<your-domain>/login` and sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
6. Hit `https://<your-domain>/api/health`. `db` should be `ok` and `storage` should be `s3` or `blob`.
7. In the fee schedule, replace the empty wire instructions and confirm the premium and commission.

`vercel.json` already schedules `GET /api/cron` at 13:00 UTC every day. Vercel sends `Authorization: Bearer $CRON_SECRET` when that variable exists.

## What the build does

`npm run build` runs `scripts/release.ts` only when `VERCEL=1` (or `UPB_RELEASE=1` on another host). Leave Vercel’s install command as the default. `tsx`, which runs that script, is a production dependency so the step still exists if dev dependencies are omitted. The script:

- Refuses to start unless the required variables below are present.
- Refuses a `DATABASE_URL` that is not `mongodb+srv://` or `mongodb://`, names no database, or names `synergifund`, `admin`, `local`, or `config`.
- Builds the indexes from `prisma/schema.prisma` (`lib/mongo-indexes.ts`). Optional unique fields get partial indexes, so empty values never collide. Running it again changes nothing.
- Runs the production bootstrap: one approved admin, the default fee-schedule row, and the Florida disclosure already in the source. No listings, buyers, or demo logins.

Changing `ADMIN_PASSWORD` later does not reset the password. The bootstrap writes it only when that email is absent. Change it at `/account/security` after the first deploy. The desk also requires a real admin to set up an authenticator on that page before anything else opens. Keep the recovery codes: there is one admin, so if the authenticator and the codes are both lost, only a database edit gets back in.

`prisma/seed.ts` throws if `NODE_ENV=production`, `VERCEL=1`, or `UPB_RELEASE=1`. Demo emails such as `iris@upbcapital.test` and `nora.vale@upbcapital.test` are rejected as `ADMIN_EMAIL`. The broker seat, its public profile, and its sample fees are demo data. They are not created by the production bootstrap. Broker compensation uses the fee schedule already in the database. There is no new environment variable for it. The payout note on a broker profile is a method only. The desk does not store account numbers.

## Required

| Variable | Where to get it |
| --- | --- |
| `DATABASE_URL` | Atlas → Connect → Drivers, with UPB's own user. `mongodb+srv://<user>:<password>@<cluster-host>/upb_capital?retryWrites=true&w=majority`. |
| `AUTH_SECRET` | `openssl rand -base64 32`. Signs the session cookie. The demo value in `.env.example` is rejected. |
| `NEXT_PUBLIC_APP_URL` | The public `https://` origin, including the Vercel domain until a custom domain is attached. Used in mail links and Stripe return URLs. |
| `ADMIN_EMAIL` | The one production admin. Not a `@upbcapital.test` address. |
| `ADMIN_PASSWORD` | At least 12 characters. Not `Desk1847!`. Applied only when the admin row is created. |
| `CRON_SECRET` | `openssl rand -base64 32`. Vercel Cron uses it as the bearer token for `/api/cron`. |
| Storage, one of the two blocks below | Files (NDAs, proof of funds, closing uploads) do not survive on Vercel’s disk. |

### Storage option A — Cloudflare R2

Create an R2 bucket and an API token with object read and write. Then set:

| Variable | Where to get it |
| --- | --- |
| `S3_BUCKET` | The R2 bucket name. |
| `S3_ACCESS_KEY_ID` | R2 → Manage API tokens → the token’s access key id. |
| `S3_SECRET_ACCESS_KEY` | The same token’s secret. Shown once. |
| `S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` from the R2 bucket’s S3 API page. |
| `S3_REGION` | `auto` |

If these three credentials are set, they win over Vercel Blob.

### Storage option B — Vercel Blob

Create a **private** Blob store in the Vercel dashboard and connect it to this project. Vercel adds `BLOB_READ_WRITE_TOKEN`. The app uploads and reads with `access: "private"`, so a public store will reject the calls. On Vercel the SDK can also use OIDC when `BLOB_STORE_ID` is present. Keys are the same paths the desk already stores. They are not given a random suffix, and a rewrite of the same key overwrites.

`S3_REGION` is optional for AWS S3 (`us-east-1` if omitted) and required as `auto` for R2 only in the sense that R2 expects that value. Leave `S3_ENDPOINT` empty for AWS S3. In a bucket shared with another app, set `S3_PREFIX` (for example `upb-capital`) so UPB's files sit under that folder.

## Optional

| Variable | Where to get it | If unset |
| --- | --- | --- |
| `ADMIN_NAME` | Any display name. | The admin is named “Desk admin”. |
| `DEMO_DESK` | `1` only on a private demo server nobody else can reach. It lets the seeded demo seats sign in, and the sign-in page list them with their public password, on an origin that isn't local. Ignored by a release build. Never set it on a public site. | The demo seats work only when `NEXT_PUBLIC_APP_URL` is unset, `localhost`, `127.0.0.1`, `[::1]`, `*.localhost` or `*.test`. On any other origin their sign-in is refused and their sessions, API keys, MCP connector, calendar links and guest links stop working. |
| `DESK_EMAIL` | A shared desk inbox. Gets desk alerts alongside every approved admin and is shown in the public footer. Not a `@upbcapital.test` address. | Desk alerts go to approved admins only. The footer shows no address. |
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys. | Pro checkout stays simulated. No card is charged. |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Webhooks → endpoint `https://<domain>/api/billing/webhook`. | The webhook route answers 400 and processes nothing, so memberships do not update after checkout. |
| `STRIPE_PRO_PRICE_ID` | Stripe → Products, only if you do not save the price from the fee schedule. | The fee schedule creates the Price when the secret key is set. |
| `RESEND_API_KEY` | Resend → API keys. | |
| `EMAIL_FROM` | A sender address on the Resend (or SMTP) domain. | Without Resend or SMTP, mail is written to the log and the in-app notice list. |
| `SMTP_HOST` | Your SMTP host. | Used only when Resend is not set. |
| `SMTP_PORT` | Usually `587`. | Defaults to 587. |
| `SMTP_USER` | SMTP username. | |
| `SMTP_PASSWORD` | SMTP password. | |
| `ESCROW_PROVIDER` | Leave `manual` until a provider is registered in `lib/escrow.ts`. | Wire instructions on the closing. |
| `AVM_PROVIDER` | `mock` or `attom`. | `mock` pins a city. |
| `ATTOM_API_KEY` | ATTOM → API key. | Mock value estimate. |
| `RATE_LIMIT_STORE` | `database` (default), `redis`, or `memory`. | The database. Use that on Vercel. `memory` is per instance. |
| `ALLOW_HTTP_SESSIONS` | `1` only on an internal server reached over plain http, such as pm2 on port 3009 with no proxy. A release build refuses it. | Session cookies are https-only in production, so sign-in fails over plain http. |
| `REDIS_URL` | Redis provider, only if `RATE_LIMIT_STORE=redis`. | Ignored. |
| `DROPBOX_SIGN_API_KEY` | Dropbox Sign → API. | Signatures stay in the app. |
| `DROPBOX_SIGN_TEST_MODE` | `1` or `0`. | Test mode when the key is set and this is blank or `1`. |
| `DOCUSIGN_ACCESS_TOKEN` | DocuSign OAuth token. | |
| `DOCUSIGN_ACCOUNT_ID` | DocuSign account id. | |
| `DOCUSIGN_BASE_URL` | Defaults to the DocuSign demo REST host. | |
| `PERSONA_API_KEY` | Persona → API keys. | Buyer file stays the desk form. |
| `PERSONA_TEMPLATE_ID` | Persona inquiry template. | |
| `PARALLEL_API_KEY` | Parallel Markets. | |
| `KYC_WEBHOOK_SECRET` | A secret you choose. Persona or Parallel posts to `/api/kyc/webhook` with header `x-kyc-secret`. | The webhook rejects calls. |
| `OFAC_SDN_URL` | Treasury's free SDN list: `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV`. Required in a release build unless a vendor is set. | A seven-name stand-in that is not real screening. |
| `OFAC_API_KEY` | A paid sanctions vendor, instead of the Treasury list. | |
| `OFAC_API_URL` | A URL that returns JSON names, a name column, or an OpenSanctions-style body. | |
| `LLM_API_KEY` or `OPENAI_API_KEY` | OpenAI or a compatible host. | The desk assistant writes a local sketch. |
| `LLM_BASE_URL` | Defaults to `https://api.openai.com/v1`. | |
| `LLM_MODEL` | Defaults to `gpt-4o-mini`. | |

## A server under pm2 (the EC2 host)

The checkout runs as two pm2 processes: `upb-capital` (`next start` on port 3009) and `upb-jobs` (the daily jobs on a 13:00 UTC cron). README.md has the commands that start them the first time. To deploy, from the checkout:

```bash
cd /root/upbcapital && bash scripts/deploy.sh
```

`scripts/deploy.sh`:

1. Runs `git pull --ff-only`. Already up to date is fine. If the pull can't fast-forward, it stops and changes nothing.
2. Runs `npm ci`, but only when `package-lock.json` changed since its last install there, or `node_modules` is missing. `--install` forces it. npm ci empties `node_modules` under the running server, so it isn't repeated for nothing.
3. Runs `npm run db:indexes`.
4. Builds into `.next-build` with `UPB_BUILD_DIR=.next-build npm run build`. The live site keeps serving `.next` throughout, so a failed build leaves it exactly as it was. That build type-checks with `tsconfig.deploy.json`, which reads `.next-build`'s route types and not the live build's.
5. Moves `.next` to `.next-old` and `.next-build` to `.next`, then restarts the web process straight away. The web process is the pm2 process started from the checkout that runs `next start`, else the one named `upb-capital`. If there is none, it starts `upb-capital` on `PORT` (default 3009).
6. Waits up to two minutes for `http://127.0.0.1:<port>/` to answer 200. Then it fetches every `/_next/static` file the home page names. If either check fails, it prints the process's pm2 logs and the command that puts `.next-old` back, and exits with an error.

Never run `npm run build` in place while the server runs. `next build` empties `.next` first, and a server that isn't restarted keeps the old build's file list in memory. Its pages then name CSS and scripts that answer 400.

`upb-jobs` is not restarted. pm2 starts it on its cron, and it runs `scripts/jobs.ts` from source through tsx, so its next run uses the new code. A restart would run every daily job immediately.

Behind Cloudflare, middleware sends a visitor who reached Cloudflare over plain http to the same address over https (308), using Cloudflare's `cf-visitor` header. It doesn't read `X-Forwarded-Proto`, which a proxy in between may set to http on every request. Any `www.` host goes to the bare host over https. Requests without `cf-visitor`, such as local ones or the deploy check, are left alone. For `www.` to work, add a proxied DNS record for `www` in Cloudflare.

## Still outside this repo

- The Atlas user and network rule, the Vercel project, and the env values themselves. Nothing here calls `vercel deploy`.
- A custom domain and its DNS, if you do not want the `*.vercel.app` host.
- Resend or SMTP, if mail should leave the log.
- Stripe, if Pro should charge a card.
- The browser tape wizard keeps the upload in the database for 24 hours so any Vercel instance can finish the later steps. `/api/cron` deletes drafts older than that. `POST /api/v1/tapes` still sends the CSV in one request.
