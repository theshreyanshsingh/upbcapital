import { isIP } from "node:net";
import { modelReadingAllowed, readingModeOf } from "@/lib/ai-reading";
import { stripeConfigured } from "@/lib/billing";
import { aiMode, llmConfig } from "@/lib/desk-ai";
import { resolveMailTransport } from "@/lib/mail-config";
import { aliasUrl, ofacMode } from "@/lib/ofac";
import { storageMode } from "@/lib/storage";
import { kycMode, signatureMode } from "@/lib/vendors";

export type Subprocessor = { category: string; inUse: boolean; name: string; detail: string };

type Env = Record<string, string | undefined>;

const RECORDS = "Holds the platform's records: accounts, listings, loan tapes with borrowers' names, bids, closings and the audit log.";

const MODEL_HOSTS: Record<string, string> = {
  "api.openai.com": "OpenAI",
  "openrouter.ai": "OpenRouter",
  "api.anthropic.com": "Anthropic",
  "api.mistral.ai": "Mistral",
  "api.groq.com": "Groq",
  "api.together.xyz": "Together AI",
  "generativelanguage.googleapis.com": "Google",
};

// The model provider, named from the host of LLM_BASE_URL. A host the list doesn't know is shown as it is; a private
// or numeric address stays off a public page.
function modelProvider(env: Env) {
  let host: string;
  try {
    host = new URL(llmConfig(env).base).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return "A language model provider";
  }
  if (MODEL_HOSTS[host]) return MODEL_HOSTS[host];
  if (host.endsWith(".openai.azure.com")) return "Microsoft Azure OpenAI";
  if (!host || isIP(host) || host === "localhost" || /\.(localhost|local|internal)$/.test(host)) return "A model server at a private or numeric address";
  return `The model provider at ${host}`;
}

// Which kind of MongoDB the database URL points at. Only the hosts are looked at, after the credentials, and none is
// shown.
function databaseKind(url: string | undefined) {
  const match = /^mongodb(?:\+srv)?:\/\/(.*)$/i.exec(url?.trim() ?? "");
  if (!match) return "unknown";
  const authority = match[1].split("?")[0];
  const hosts = authority
    .slice(authority.lastIndexOf("@") + 1)
    .split("/")[0]
    .split(",")
    .map((host) => host.trim().toLowerCase().replace(/^\[([^\]]*)\](:\d+)?$/, "$1").replace(/:\d+$/, ""))
    .filter(Boolean);
  if (!hosts.length) return "unknown";
  if (hosts.every((host) => host.endsWith(".mongodb.net"))) return "atlas";
  if (hosts.every((host) => host === "localhost" || host === "127.0.0.1" || host === "::1")) return "local";
  return "unknown";
}

// The outside services the application sends data to, read from the configuration it runs with, the same way the
// desk's launch readiness reads it. Which service is on is shown, and for the AI provider its public host name; never
// a key, a password, a database address or a bucket.
export function subprocessors(settings: { stripePriceId?: string | null; aiReading?: string | null }, env: Env = process.env): Subprocessor[] {
  const mail = resolveMailTransport(env);
  const storage = storageMode(env);
  const ofac = ofacMode(env);
  const signature = signatureMode();
  const kyc = kycMode();
  const attom = env.AVM_PROVIDER === "attom" && Boolean(env.ATTOM_API_KEY);
  const ai = aiMode(env) === "live";
  const host = env.VERCEL ? "Vercel" : (env.HOSTING_PROVIDER ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const database = databaseKind(env.DATABASE_URL);
  // An SDN address that doesn't name SDN.CSV can't load its aliases, so screening runs on the built-in list.
  const realList = ofac === "configured" || (ofac === "treasury" && Boolean(aliasUrl(env.OFAC_SDN_URL ?? "")));
  // Loan files go to the model only with AI_READING_MODEL=1 and a key, and only while the desk has the reader on.
  const reading = readingModeOf(settings.aiReading);
  const modelConfigured = modelReadingAllowed(env);
  const modelReads = modelConfigured && reading !== "OFF";
  const provider = ai ? modelProvider(env) : "None";
  return [
    host
      ? { category: "Hosting", inUse: true, name: host, detail: "Runs the application's servers, so every page, upload and record passes through it." }
      : { category: "Hosting", inUse: true, name: "Not named", detail: "The servers run with a host this site's configuration doesn't name yet (HOSTING_PROVIDER)." },
    database === "atlas"
      ? { category: "Database", inUse: true, name: "MongoDB Atlas", detail: RECORDS }
      : database === "local"
        ? { category: "Database", inUse: false, name: "None", detail: `The database runs on the application's own server. ${RECORDS}` }
        : { category: "Database", inUse: true, name: "A MongoDB server", detail: `${RECORDS} The configuration doesn't name who runs it.` },
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
    !realList
      ? { category: "Sanctions list", inUse: false, name: "None", detail: "A short built-in list stands in. That is not real screening." }
      : ofac === "treasury"
        ? { category: "Sanctions list", inUse: true, name: "US Treasury SDN list", detail: "The list is downloaded and names are matched on UPB's servers. No names are sent out." }
        : { category: "Sanctions list", inUse: true, name: "A screening vendor", detail: "Receives the names screened: parties to a deal and named borrowers." },
    attom
      ? { category: "Property data", inUse: true, name: "ATTOM", detail: "Values a property from its address." }
      : { category: "Property data", inUse: false, name: "None", detail: "No property data service. Stand-in values are labelled as such." },
    !ai
      ? { category: "AI", inUse: false, name: "None", detail: "No model is called, so no loan file leaves UPB for an AI provider. The desk's note drafts are canned text." }
      : !modelReads
        ? {
            category: "AI",
            inUse: true,
            name: provider,
            detail: `Desk staff can ask it to draft short notes from text they paste in. Buyers and sellers never use it, and no loan file leaves UPB for it: ${modelConfigured ? "the document reader is off" : "the document reader runs without a model"}.`,
          }
        : {
            category: "AI",
            inUse: true,
            name: provider,
            detail: [
              "The document reader sends it loan files and data-room documents, such as notes, mortgages, pay histories and title reports, which carry borrowers' names and addresses. It reads the loan facts in them and drafts answers to bidders' questions.",
              reading === "ON"
                ? "A difference it reads opens a question the seller answers, and sellers and brokers see its drafted answers to check before they publish. A field counts as verified only once the desk confirms the reading."
                : "What it reads and drafts goes only to the desk, marked as not confirmed.",
              "Desk staff can also ask it to draft short notes from text they paste in.",
            ].join(" "),
          },
  ];
}
