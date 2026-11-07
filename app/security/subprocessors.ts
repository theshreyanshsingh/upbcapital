import { stripeConfigured } from "@/lib/billing";
import { aiMode } from "@/lib/desk-ai";
import { resolveMailTransport } from "@/lib/mail-config";
import { ofacMode } from "@/lib/ofac";
import { storageMode } from "@/lib/storage";
import { kycMode, signatureMode } from "@/lib/vendors";

export type Subprocessor = { category: string; inUse: boolean; name: string; detail: string };

type Env = Record<string, string | undefined>;

// The outside services the application sends data to, read from the configuration it runs with, the same way the
// desk's launch readiness reads it. Only which service is on is shown, never a key, a host or a bucket.
export function subprocessors(settings: { stripePriceId?: string | null }, env: Env = process.env): Subprocessor[] {
  const mail = resolveMailTransport(env);
  const storage = storageMode(env);
  const ofac = ofacMode(env);
  const signature = signatureMode();
  const kyc = kycMode();
  const attom = env.AVM_PROVIDER === "attom" && Boolean(env.ATTOM_API_KEY);
  const ai = aiMode(env) === "live";
  return [
    mail === "log"
      ? { category: "Email", inUse: false, name: "None", detail: "Mail is written to the server log here and not sent." }
      : { category: "Email", inUse: true, name: mail === "resend" ? "Resend" : "An SMTP mail relay", detail: "Delivers notices, codes and reset links. It receives the address and the message." },
    storage === "local"
      ? { category: "File storage", inUse: false, name: "None", detail: "Files stay on the application server's own disk." }
      : { category: "File storage", inUse: true, name: storage === "blob" ? "Vercel Blob" : env.S3_ENDPOINT ? "An S3-compatible bucket" : "Amazon S3", detail: "Holds loan files, data-room documents, signed papers and buyer files, in a private store." },
    stripeConfigured(settings.stripePriceId)
      ? { category: "Payments", inUse: true, name: "Stripe", detail: "Takes payment for Pro memberships. Trade money moves by wire, not through Stripe." }
      : { category: "Payments", inUse: false, name: "None", detail: "No card processor. Trade money moves by wire, recorded by the desk." },
    kyc === "mock"
      ? { category: "Identity", inUse: false, name: "None", detail: "The desk reviews identity and proof-of-funds files by hand." }
      : { category: "Identity", inUse: true, name: kyc === "persona" ? "Persona" : "Parallel Markets", detail: "Checks a buyer's identity or accreditation. It receives the buyer's name and email." },
    signature === "mock"
      ? { category: "E-signature", inUse: false, name: "None", detail: "NDAs and agreements are signed and stored in the app." }
      : { category: "E-signature", inUse: true, name: signature === "dropbox-sign" ? "Dropbox Sign" : "DocuSign", detail: "Collects signatures. It receives the document and the signer's name and email." },
    ofac === "mock"
      ? { category: "Sanctions list", inUse: false, name: "None", detail: "A short built-in list stands in. That is not real screening." }
      : ofac === "treasury"
        ? { category: "Sanctions list", inUse: true, name: "US Treasury SDN list", detail: "The list is downloaded and names are matched on UPB's servers. No names are sent out." }
        : { category: "Sanctions list", inUse: true, name: "A screening vendor", detail: "Receives the names screened: parties to a deal and named borrowers." },
    attom
      ? { category: "Property data", inUse: true, name: "ATTOM", detail: "Values a property from its address." }
      : { category: "Property data", inUse: false, name: "None", detail: "No property data service. Stand-in values are labelled as such." },
    ai
      ? { category: "AI", inUse: true, name: env.LLM_BASE_URL ? "A language model provider" : "OpenAI", detail: "Desk staff can ask it to draft short notes from text they paste in. Buyers and sellers never use it." }
      : { category: "AI", inUse: false, name: "None", detail: "The desk's note drafts are canned text. No model is called." },
  ];
}
