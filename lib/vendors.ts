export type SignatureJob = {
  title: string;
  signerName: string;
  signerEmail: string;
  pdf: Buffer;
  kind: "nda" | "psa";
};

export type SignatureResult = { provider: string; id: string; status: string; url: string };

export async function sendForSignature(job: SignatureJob): Promise<SignatureResult> {
  const dropbox = process.env.DROPBOX_SIGN_API_KEY;
  if (dropbox) {
    try {
      return await dropboxSign(dropbox, job);
    } catch {
      return mockSignature(job, "dropbox-sign-failed");
    }
  }
  const token = process.env.DOCUSIGN_ACCESS_TOKEN;
  const account = process.env.DOCUSIGN_ACCOUNT_ID;
  if (token && account) {
    try {
      return await docusign(token, account, job);
    } catch {
      return mockSignature(job, "docusign-failed");
    }
  }
  return mockSignature(job, "signed_in_app");
}

function mockSignature(job: SignatureJob, status: string): SignatureResult {
  return { provider: "mock", id: `local-${job.kind}`, status, url: "" };
}

async function dropboxSign(apiKey: string, job: SignatureJob): Promise<SignatureResult> {
  const form = new FormData();
  form.set("test_mode", process.env.DROPBOX_SIGN_TEST_MODE === "0" ? "0" : "1");
  form.set("title", job.title.slice(0, 180));
  form.set("subject", job.title.slice(0, 180));
  form.set("message", "UPB Capital sent this for signature.");
  form.set("signers[0][email_address]", job.signerEmail);
  form.set("signers[0][name]", job.signerName);
  form.set("file[0]", new Blob([new Uint8Array(job.pdf)], { type: "application/pdf" }), `${job.kind}.pdf`);
  const response = await fetch("https://api.hellosign.com/v3/signature_request/send", {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` },
    body: form,
  });
  if (!response.ok) throw new Error("Dropbox Sign rejected the file");
  const payload = (await response.json()) as { signature_request?: { signature_request_id?: string } };
  return {
    provider: "dropbox-sign",
    id: payload.signature_request?.signature_request_id || "sent",
    status: "sent",
    url: "",
  };
}

async function docusign(token: string, accountId: string, job: SignatureJob): Promise<SignatureResult> {
  const base = process.env.DOCUSIGN_BASE_URL || "https://demo.docusign.net/restapi";
  const response = await fetch(`${base}/v2.1/accounts/${accountId}/envelopes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      emailSubject: job.title.slice(0, 100),
      status: "sent",
      documents: [{ documentBase64: job.pdf.toString("base64"), name: job.title.slice(0, 80), fileExtension: "pdf", documentId: "1" }],
      recipients: { signers: [{ email: job.signerEmail, name: job.signerName, recipientId: "1" }] },
    }),
  });
  if (!response.ok) throw new Error("DocuSign rejected the envelope");
  const payload = (await response.json()) as { envelopeId?: string };
  return { provider: "docusign", id: payload.envelopeId || "sent", status: "sent", url: "" };
}

export function signatureMode() {
  if (process.env.DROPBOX_SIGN_API_KEY) return "dropbox-sign";
  if (process.env.DOCUSIGN_ACCESS_TOKEN && process.env.DOCUSIGN_ACCOUNT_ID) return "docusign";
  return "mock";
}

export type KycStart = { provider: string; url: string; reference: string };

export async function startKyc(input: { userId: string; email: string; name: string }): Promise<KycStart> {
  if (process.env.PERSONA_API_KEY && process.env.PERSONA_TEMPLATE_ID) {
    const response = await fetch("https://withpersona.com/api/v1/inquiries", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PERSONA_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        data: { attributes: { "inquiry-template-id": process.env.PERSONA_TEMPLATE_ID, "reference-id": input.userId } },
      }),
    });
    if (!response.ok) throw new Error("Persona did not open an inquiry");
    const payload = (await response.json()) as { data?: { id?: string } };
    const reference = payload.data?.id || "";
    return { provider: "persona", reference, url: reference ? `https://inquiry.withpersona.com/verify?inquiry-id=${reference}` : "" };
  }
  if (process.env.PARALLEL_API_KEY) {
    const response = await fetch("https://api.parallelmarkets.com/v1/partner/accreditations", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.PARALLEL_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reference_id: input.userId, email: input.email, name: input.name }),
    });
    if (!response.ok) throw new Error("Parallel Markets did not open a case");
    const payload = (await response.json()) as { id?: string; url?: string };
    return { provider: "parallel", reference: payload.id || input.userId, url: payload.url || "" };
  }
  return { provider: "mock", reference: "", url: "" };
}

export function kycMode() {
  if (process.env.PERSONA_API_KEY && process.env.PERSONA_TEMPLATE_ID) return "persona";
  if (process.env.PARALLEL_API_KEY) return "parallel";
  return "mock";
}

export function parseKycWebhook(body: unknown): { reference: string; userId: string; status: "APPROVED" | "REJECTED" | "SUBMITTED" } | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (typeof record.reference === "string" && typeof record.status === "string") {
    return { reference: record.reference, userId: String(record.userId || ""), status: mapStatus(record.status) };
  }
  const data = record.data as { attributes?: { payload?: { data?: { id?: string; attributes?: Record<string, unknown> } } } } | undefined;
  const inquiry = data?.attributes?.payload?.data;
  const attributes = inquiry?.attributes;
  if (!inquiry?.id || !attributes) return null;
  return {
    reference: inquiry.id,
    userId: String(attributes["reference-id"] || ""),
    status: mapStatus(String(attributes.status || "")),
  };
}

function mapStatus(status: string): "APPROVED" | "REJECTED" | "SUBMITTED" {
  const value = status.toLowerCase();
  if (["approved", "completed", "passed"].includes(value)) return "APPROVED";
  if (["declined", "failed", "rejected", "expired"].includes(value)) return "REJECTED";
  return "SUBMITTED";
}
