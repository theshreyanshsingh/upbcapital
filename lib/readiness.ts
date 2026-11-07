import { pushReady } from "@/lib/push";
import { stripeConfigured } from "@/lib/billing";
import { aiMode } from "@/lib/desk-ai";
import { isReleaseBuild } from "@/lib/deploy";
import { deliverable, resolveMailTransport } from "@/lib/mail-config";
import { ofacMode } from "@/lib/ofac";
import { participationsOpen } from "@/lib/participation";
import { prisma } from "@/lib/prisma";
import { limitStore } from "@/lib/rate-limit";
import { brokerListingsWithoutMandate, sellerIdentityRequired } from "@/lib/seller-identity";
import { storageMode } from "@/lib/storage";
import { kycMode, signatureMode } from "@/lib/vendors";

export type ReadinessState = "live" | "standin" | "off";
export type ReadinessItem = { label: string; state: ReadinessState; detail: string };

// What runs for real and what runs on a stand-in, read from the environment the server is running with.
// Stand-ins are fine for the demo desk; each one is a decision to make before real users arrive.
export async function launchReadiness(settings: { stripePriceId?: string | null; requireTwoStep?: boolean | null; requireSellerIdentity?: boolean | null }, env: Record<string, string | undefined> = process.env) {
  const release = isReleaseBuild(env);
  const users = await prisma.user.findMany({ select: { email: true } });
  const demo = users.filter((user) => !deliverable(user.email)).length;
  const unmandated = await brokerListingsWithoutMandate();
  const mail = resolveMailTransport(env);
  const storage = storageMode(env);
  const ofac = ofacMode(env);
  const signature = signatureMode();
  const kyc = kycMode();
  const avm = env.AVM_PROVIDER || "mock";
  const items: ReadinessItem[] = [
    release
      ? { label: "Release mode", state: "live", detail: "UPB_RELEASE is set. Builds refuse stand-ins for the database, sign-in, cron, storage, and the sanctions list." }
      : { label: "Release mode", state: "standin", detail: "Demo mode. Set UPB_RELEASE=1 for launch: it closes the simulated checkout, ends Pro at its period end, and hides stand-in property values." },
    participationsOpen(env)
      ? { label: "Participations", state: "live", detail: "UPB_PARTICIPATIONS is set, so desk slices and partial positions can be listed." }
      : { label: "Participations", state: "off", detail: "Slices and partial positions can't be listed until counsel rules. Set UPB_PARTICIPATIONS=1 once it does." },
    mail === "log"
      ? { label: "Email", state: "standin", detail: "Mail goes to the server log. Set RESEND_API_KEY or SMTP, and EMAIL_FROM on a verified domain." }
      : { label: "Email", state: "live", detail: `Delivered through ${mail}.` },
    storage === "local"
      ? { label: "File storage", state: "standin", detail: "Files sit on this server's disk. Set an S3 bucket UPB owns." }
      : { label: "File storage", state: "live", detail: `Files go to ${storage}.` },
    ofac === "mock"
      ? { label: "Sanctions list", state: "standin", detail: "A short local list. Set OFAC_SDN_URL to Treasury's SDN file or a screening vendor." }
      : { label: "Sanctions list", state: "live", detail: ofac === "treasury" ? "Treasury's SDN and alternate-name files." : "A screening vendor." },
    stripeConfigured(settings.stripePriceId)
      ? { label: "Pro payments", state: "live", detail: "Stripe checkout." }
      : release
        ? { label: "Pro payments", state: "off", detail: "Checkout is closed until STRIPE_SECRET_KEY and a Pro price are set." }
        : { label: "Pro payments", state: "standin", detail: "Simulated checkout, written to the ledger as mock charges." },
    signature === "mock"
      ? { label: "E-signature", state: "standin", detail: "Signatures are stored here only. Set Dropbox Sign or DocuSign keys." }
      : { label: "E-signature", state: "live", detail: `Sent through ${signature}.` },
    kyc === "mock"
      ? { label: "Identity checks", state: "standin", detail: "The desk reviews uploaded files by hand. Persona or Parallel Markets can run them." }
      : { label: "Identity checks", state: "live", detail: `Run by ${kyc}.` },
    avm === "mock"
      ? { label: "Property values", state: "standin", detail: release ? "Stand-in values are hidden from buyers. Set AVM_PROVIDER and its key." : "A stand-in: the seller's figure nudged a few percent, labelled mock. Set AVM_PROVIDER and its key." }
      : { label: "Property values", state: "live", detail: `From ${avm}.` },
    { label: "Escrow", state: "standin", detail: `${env.ESCROW_PROVIDER || "Manual"} wires. The desk records deposits, funds, and proceeds. A title or escrow agent should hold the money.` },
    pushReady(env)
      ? { label: "Push notices", state: "live", detail: "Installed apps can receive notices on the lock screen. Payloads carry no names, amounts or codes." }
      : { label: "Push notices", state: "off", detail: "Push notices are off. Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (npx web-push generate-vapid-keys)." },
    aiMode(env) === "live"
      ? { label: "Desk assistant", state: "live", detail: "A live model drafts desk notes." }
      : { label: "Desk assistant", state: "standin", detail: "Canned sketches. Set LLM_API_KEY on an account UPB owns." },
    limitStore() === "memory"
      ? { label: "Rate limits", state: "standin", detail: "Counted per process. Use the database or Redis store when more than one server runs." }
      : { label: "Rate limits", state: "live", detail: `Shared through the ${limitStore()} store.` },
    settings.requireTwoStep !== false
      ? { label: "Two-step sign-in", state: "live", detail: "Required for every approved account that can see borrower data." }
      : { label: "Two-step sign-in", state: "off", detail: "Only admins must enroll. Turn it on below before real users." },
    sellerIdentityRequired(settings, env)
      ? { label: "Seller identity", state: "live", detail: "A seller's identity and signing authority are approved before the desk approves their listing." }
      : { label: "Seller identity", state: release ? "off" : "standin", detail: "Listings can be approved before the desk has checked who is selling. Turn the gate on below before real sellers." },
    unmandated > 0
      ? { label: "Broker mandates", state: "off", detail: `${unmandated} broker-filed listing${unmandated === 1 ? " is" : "s are"} in review with no mandate from the note holder. With the seller identity gate on, the desk can't approve ${unmandated === 1 ? "it" : "them"} until the broker adds one.` }
      : { label: "Broker mandates", state: "live", detail: "Every broker-filed listing in review has the note holder's mandate on file." },
    demo > 0
      ? { label: "Demo accounts", state: "standin", detail: `${demo} account${demo === 1 ? "" : "s"} on undeliverable addresses, including the public demo seats. Remove them before real users.` }
      : { label: "Demo accounts", state: "live", detail: "None left." },
  ];
  return { release, items, ready: items.every((item) => item.state === "live") };
}
