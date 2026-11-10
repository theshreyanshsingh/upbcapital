import { modelReadingAllowed, readingModeOf } from "@/lib/ai-reading";
import { pushReady } from "@/lib/push";
import { stripeConfigured } from "@/lib/billing";
import { aiMode } from "@/lib/desk-ai";
import { isReleaseBuild } from "@/lib/deploy";
import { deskFiledWaiting } from "@/lib/desk-intake";
import { emailConfirmationRequired } from "@/lib/email-confirm";
import { deliverable, resolveMailTransport } from "@/lib/mail-config";
import { aliasUrl, ofacMode } from "@/lib/ofac";
import { participationsOpen } from "@/lib/participation";
import { prisma } from "@/lib/prisma";
import { ownAccounts } from "@/lib/seats";
import { limitStore } from "@/lib/rate-limit";
import { brokerListingsWithoutMandate, sellerIdentityRequired } from "@/lib/seller-identity";
import { storageMode } from "@/lib/storage";
import { kycMode, signatureMode } from "@/lib/vendors";

export type ReadinessState = "live" | "standin" | "off";
export type ReadinessItem = { label: string; state: ReadinessState; detail: string };

// What runs for real and what runs on a stand-in, read from the environment the server is running with.
// Stand-ins are fine for the demo desk; each one is a decision to make before real users arrive.
export async function launchReadiness(settings: { stripePriceId?: string | null; requireTwoStep?: boolean | null; requireSellerIdentity?: boolean | null; requireEmailConfirmation?: boolean | null; aiReading?: string | null }, env: Record<string, string | undefined> = process.env) {
  const release = isReleaseBuild(env);
  // Seats are people on a firm's account, not accounts of their own (lib/seats.ts).
  const users = await prisma.user.findMany({ where: ownAccounts(), select: { email: true } });
  const demo = users.filter((user) => !deliverable(user.email)).length;
  const unmandated = await brokerListingsWithoutMandate();
  const deskFiled = await deskFiledWaiting();
  const mail = resolveMailTransport(env);
  const storage = storageMode(env);
  const ofac = ofacMode(env);
  const signature = signatureMode();
  const kyc = kycMode();
  const avm = env.AVM_PROVIDER || "mock";
  // ATTOM is the one live provider, and without its key every value falls back to the stand-in (lib/enrichment.ts).
  const avmLive = avm === "attom" && Boolean(env.ATTOM_API_KEY);
  const avmStandin = release ? "Stand-in values are hidden from buyers." : "A stand-in: the seller's figure nudged a few percent, labelled mock.";
  const reading = readingModeOf(settings.aiReading);
  const model = modelReadingAllowed(env);
  const noModel = env.AI_READING_MODEL === "1" ? "AI_READING_MODEL is set but LLM_API_KEY isn't" : "set AI_READING_MODEL=1 and LLM_API_KEY on an account UPB owns, with a data-processing agreement";
  const items: ReadinessItem[] = [
    release
      ? { label: "Release mode", state: "live", detail: "UPB_RELEASE is set. Builds refuse stand-ins for the database, sign-in, cron, storage, and the sanctions list." }
      : { label: "Release mode", state: "standin", detail: "Demo mode. Set UPB_RELEASE=1 for launch: it closes the simulated checkout, ends Pro at its period end, and hides stand-in property values." },
    participationsOpen(env)
      ? { label: "Participations", state: "live", detail: "Open: UPB_PARTICIPATIONS is set. Counsel's sign-off should be on file." }
      : { label: "Participations", state: "off", detail: "Tranche groups, desk capital allocations, desk slices and partial relists wait on counsel. Set UPB_PARTICIPATIONS=1 once counsel signs off." },
    mail === "log"
      ? { label: "Email", state: "standin", detail: "Mail goes to the server log. Set RESEND_API_KEY or SMTP, and EMAIL_FROM on a verified domain." }
      : { label: "Email", state: "live", detail: `Delivered through ${mail}.` },
    storage === "local"
      ? { label: "File storage", state: "standin", detail: "Files sit on this server's disk. Set an S3 bucket UPB owns." }
      : { label: "File storage", state: "live", detail: `Files go to ${storage}.` },
    ofac === "mock"
      ? { label: "Sanctions list", state: "standin", detail: "Only the local stand-in list is used: a few names, not real screening. Set OFAC_SDN_URL to Treasury's SDN.CSV or a screening vendor." }
      : ofac === "treasury" && !aliasUrl(env.OFAC_SDN_URL ?? "")
        ? { label: "Sanctions list", state: "standin", detail: "OFAC_SDN_URL doesn't end in SDN.CSV, so the alias file can't load and only the local stand-in list is used. Point it at Treasury's SDN.CSV." }
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
    avmLive
      ? { label: "Property values", state: "live", detail: "From ATTOM." }
      : avm === "attom"
        ? { label: "Property values", state: "standin", detail: `ATTOM_API_KEY isn't set, so every value falls back to the stand-in. ${avmStandin}` }
        : avm === "mock"
          ? { label: "Property values", state: "standin", detail: `${avmStandin} Set AVM_PROVIDER=attom and ATTOM_API_KEY.` }
          : { label: "Property values", state: "standin", detail: `UPB calls no provider named ${avm}, so every value falls back to the stand-in. ${avmStandin} Set AVM_PROVIDER=attom and ATTOM_API_KEY.` },
    { label: "Escrow", state: "standin", detail: `${env.ESCROW_PROVIDER || "Manual"} wires. The desk records deposits, funds, and proceeds. A title or escrow agent should hold the money.` },
    pushReady(env)
      ? { label: "Push notices", state: "live", detail: "Installed apps can receive notices on the lock screen. Payloads carry no names, amounts or codes." }
      : { label: "Push notices", state: "off", detail: "Push notices are off. Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (npx web-push generate-vapid-keys)." },
    aiMode(env) === "live"
      ? { label: "Desk assistant", state: "live", detail: "A live model drafts desk notes." }
      : { label: "Desk assistant", state: "standin", detail: "Canned sketches. Set LLM_API_KEY on an account UPB owns." },
    // The reader's mode is the desk's setting; whether it reads through a model is the server's (lib/ai-reading.ts).
    reading === "OFF"
      ? { label: "Document reader", state: "off", detail: model ? "Off: new files aren't read. The model is configured, so turning it on sends loan files to the model provider." : "Off: new files aren't read. Turned on, it reads text files only until the model is configured." }
      : model
        ? reading === "ON"
          ? { label: "Document reader", state: "live", detail: "On, through the model: loan files go to the model provider, a difference it reads goes to the seller, and sellers see its drafted answers. A field is verified only once the desk confirms it." }
          : { label: "Document reader", state: "standin", detail: "Shadow, through the model: loan files go to the model provider, and only the desk sees what it reads. Turn it on once it passes its test." }
        : { label: "Document reader", state: "standin", detail: `${reading === "ON" ? "On, with the offline rules: differences go to the seller." : "Shadow, with the offline rules: only the desk sees what it reads."} PDFs are skipped until the model is configured: ${noModel}.` },
    limitStore() === "memory"
      ? { label: "Rate limits", state: "standin", detail: "Counted per process. Use the database or Redis store when more than one server runs." }
      : { label: "Rate limits", state: "live", detail: `Shared through the ${limitStore()} store.` },
    settings.requireTwoStep !== false
      ? { label: "Two-step sign-in", state: "live", detail: "Required for every approved account that can see borrower data." }
      : { label: "Two-step sign-in", state: "off", detail: "Only admins must enroll. Turn it on below before real users." },
    sellerIdentityRequired(settings, env)
      ? { label: "Seller identity", state: "live", detail: "A seller's identity and signing authority are approved before the desk approves their listing." }
      : { label: "Seller identity", state: release ? "off" : "standin", detail: "Listings can be approved before the desk has checked who is selling. Turn the gate on below before real sellers." },
    emailConfirmationRequired(settings, env)
      ? { label: "Email confirmation", state: "live", detail: "An account confirms it owns its email before it bids, lists, signs or messages." }
      : { label: "Email confirmation", state: release ? "off" : "standin", detail: "Accounts can bid and list before proving they own their email. Turn the gate on below before real users." },
    unmandated > 0
      ? { label: "Broker mandates", state: "off", detail: `${unmandated} broker-filed listing${unmandated === 1 ? " is" : "s are"} in review with no mandate from the note holder. With the seller identity gate on, the desk can't approve ${unmandated === 1 ? "it" : "them"} until the broker adds one.` }
      : { label: "Broker mandates", state: "live", detail: "Every broker-filed listing in review has the note holder's mandate on file." },
    // The gate is always on, so this reads live either way and says how many desk-filed tapes wait on a seller.
    { label: "Desk-filed tapes", state: "live", detail: deskFiled > 0 ? `${deskFiled} listing${deskFiled === 1 ? "" : "s"} the desk filed for a seller wait${deskFiled === 1 ? "s" : ""} for the seller to confirm the tape. None can be approved before then.` : "A tape the desk files for a seller can't be approved until the seller confirms it is theirs and correct." },
    demo > 0
      ? { label: "Demo accounts", state: "standin", detail: `${demo} account${demo === 1 ? "" : "s"} on undeliverable addresses, including the public demo seats. Remove them before real users.` }
      : { label: "Demo accounts", state: "live", detail: "None left." },
  ];
  return { release, items, ready: items.every((item) => item.state === "live") };
}
