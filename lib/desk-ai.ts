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

export async function deskAssist(task: DeskTask, payload: string) {
  const key = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) return { provider: "mock" as const, text: mockDeskAnswer(task, payload) };
  const base = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.LLM_MODEL || "gpt-4o-mini";
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
