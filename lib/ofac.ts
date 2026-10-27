import { SDN_NAMES, fuzzyHit, parseSanctionNames } from "@/lib/sdn";

export type Screen = { provider: "local" | "live"; result: "CLEAR" | "REVIEW"; detail: string; matched?: string };

export function screenOfac(name: string, names: string[] = SDN_NAMES, provider: Screen["provider"] = "local"): Screen {
  const cleaned = name.trim();
  if (!cleaned) return { provider, result: "CLEAR", detail: "No name to screen." };
  const hit = fuzzyHit(cleaned, names);
  if (!hit) return { provider, result: "CLEAR", detail: "No fuzzy match on the local SDN list." };
  return {
    provider,
    result: "REVIEW",
    matched: hit.entry,
    detail: `Matched “${hit.entry}” at ${Math.round(hit.score * 100)}% on the ${provider === "live" ? "parsed vendor" : "local SDN"} list. A person has to clear it.`,
  };
}

export async function screenParty(name: string, env: Record<string, string | undefined> = process.env): Promise<Screen> {
  const url = env.OFAC_API_URL;
  const key = env.OFAC_API_KEY;
  if (!url || !key) return screenOfac(name);
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json, text/csv, text/plain" },
      signal: AbortSignal.timeout(8000),
    });
    const body = await response.text();
    if (!response.ok) {
      const local = screenOfac(name);
      return { ...local, detail: `${local.detail} The vendor returned ${response.status}, so this used the local list.` };
    }
    const remote = parseSanctionNames(body);
    if (!remote.length) {
      const local = screenOfac(name);
      return { ...local, detail: `${local.detail} The vendor body had no names to parse.` };
    }
    return screenOfac(name, [...SDN_NAMES, ...remote], "live");
  } catch {
    const local = screenOfac(name);
    return { ...local, detail: `${local.detail} The vendor list could not be read.` };
  }
}
