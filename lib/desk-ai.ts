export type DeskTask = "summarize" | "tape" | "describe";

export function aiMode(env: Record<string, string | undefined> = process.env) {
  return env.LLM_API_KEY || env.OPENAI_API_KEY ? "live" : "mock";
}

export function mockDeskAnswer(task: DeskTask, payload: string) {
  if (task === "summarize") {
    try {
      const data = JSON.parse(payload) as { loans?: { state?: string; upb?: number; paymentStatus?: string; rate?: number }[] };
      const loans = data.loans ?? [];
      if (loans.length) {
        const upb = loans.reduce((sum, loan) => sum + (loan.upb || 0), 0);
        const states = [...new Set(loans.map((loan) => loan.state).filter(Boolean))];
        const npl = loans.filter((loan) => loan.paymentStatus === "NON_PERFORMING").length;
        return `${loans.length} loans, ${Math.round(upb).toLocaleString("en-US")} of unpaid principal, across ${states.join(", ") || "unstated states"}. ${npl} are non-performing. This is a desk sketch from the rows, not a credit memo.`;
      }
    } catch {
      // Fall through to the prose sketch.
    }
  }
  if (task === "tape") {
    const lines = payload.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 8);
    return lines.length
      ? `The tape needs a look before it is filed. ${lines.join(" ")}`
      : "No data issues were flagged in the rows that were checked.";
  }
  const compact = payload.replace(/\s+/g, " ").trim().slice(0, 420);
  return compact
    ? `${compact} Offered on the UPB Capital desk. Figures are as stated by the seller and still subject to the file.`
    : "A note offered on the desk. Add the city, lien, and unpaid principal before this draft is useful.";
}

// One OpenAI-compatible provider for the whole desk. OpenRouter takes the same requests at its own base URL.
export function llmConfig(env: Record<string, string | undefined> = process.env) {
  return {
    key: env.LLM_API_KEY || env.OPENAI_API_KEY || "",
    base: (env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
    model: env.LLM_MODEL || "gpt-4o-mini",
  };
}

// A file the model reads with the prompt. A PDF goes as a base64 `file` part in the chat format, which OpenAI and
// OpenRouter both accept, so the model sees the pages and not a lossy text copy.
export type ModelFile = { name: string; mime: string; bytes: Buffer };

export type ModelJson = { ok: true; json: unknown; model: string } | { ok: false; error: string; model: string };

// Models sometimes wrap JSON in a code fence even when asked not to.
export function parseModelJson(text: string): unknown {
  const body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(body);
}

// Asks for one JSON object. Never throws: a missing key, an error status, a timeout or bad JSON come back as words,
// so a caller can mark its work failed and the desk can try again.
export async function modelJson(
  input: { system: string; prompt: string; file?: ModelFile; timeoutMs?: number },
  env: Record<string, string | undefined> = process.env,
): Promise<ModelJson> {
  const { key, base, model } = llmConfig(env);
  if (!key) return { ok: false, error: "No model key is set.", model };
  const content = input.file
    ? [
        { type: "text", text: input.prompt },
        { type: "file", file: { filename: input.file.name, file_data: `data:${input.file.mime};base64,${input.file.bytes.toString("base64")}` } },
      ]
    : input.prompt;
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: input.system },
          { role: "user", content },
        ],
      }),
      signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
    });
    if (!response.ok) return { ok: false, error: `The model answered with status ${response.status}.`, model };
    const json = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
    const raw = json.choices?.[0]?.message?.content;
    // Some providers return the message as a list of parts.
    const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("") : "";
    if (!text.trim()) return { ok: false, error: "The model sent an empty answer.", model };
    try {
      return { ok: true, json: parseModelJson(text), model };
    } catch {
      return { ok: false, error: "The model's answer wasn't JSON.", model };
    }
  } catch {
    return { ok: false, error: "The model didn't answer in time.", model };
  }
}

export async function deskAssist(task: DeskTask, payload: string) {
  const { key, base, model } = llmConfig();
  if (!key) return { provider: "mock" as const, text: mockDeskAnswer(task, payload) };
  const system = "You write short, plain notes for a mortgage-note trading desk. No hype. Do not invent figures that are not in the prompt. Two or three sentences.";
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: `${task}\n\n${payload.slice(0, 12000)}` },
        ],
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return { provider: "mock" as const, text: mockDeskAnswer(task, payload) };
    const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) return { provider: "mock" as const, text: mockDeskAnswer(task, payload) };
    return { provider: "live" as const, text };
  } catch {
    return { provider: "mock" as const, text: mockDeskAnswer(task, payload) };
  }
}
