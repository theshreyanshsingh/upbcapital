/** Public OFAC SDN primary names, plus the desk’s planted test strings. */
export const SDN_NAMES = [
  "blocked test",
  "ofac sample",
  "AEROCARIBBEAN AIRLINES",
  "BANCO NACIONAL DE CUBA",
  "HANSA INDIA",
  "CUBANACAN GROUP",
  "COMERCIALIZADORA DE METALES",
];

export function normalizeName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein(left: string, right: string) {
  const a = left;
  const b = right;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = i - 1;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + cost);
      previous = current;
    }
  }
  return row[b.length];
}

export function nameSimilarity(left: string, right: string) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 8 && (a.includes(b) || b.includes(a))) return 0.96;
  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length);
}

export function fuzzyHit(name: string, list: string[], threshold = 0.82) {
  const cleaned = normalizeName(name);
  if (cleaned.length < 3) return null;
  let best: { entry: string; score: number } | null = null;
  for (const entry of list) {
    const score = nameSimilarity(cleaned, entry);
    if (!best || score > best.score) best = { entry, score };
  }
  if (!best || best.score < threshold) return null;
  return best;
}

export function parseSanctionNames(payload: string) {
  const trimmed = payload.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const json = JSON.parse(trimmed) as unknown;
    return namesFromJson(json);
  }
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
  const header = lines[0]?.toLowerCase() ?? "";
  const cells = (line: string) => line.split(",").map((cell) => cell.replace(/^"|"$/g, "").trim());
  if (header.includes("name") || header.includes("sdn")) {
    const headers = cells(lines[0]).map((cell) => cell.toLowerCase());
    const index = headers.findIndex((cell) => cell === "name" || cell === "sdn_name" || cell.includes("name"));
    return lines.slice(1).map((line) => cells(line)[Math.max(index, 0)]).filter(Boolean);
  }
  return lines.map((line) => cells(line)[0]).filter((name) => name.length > 2);
}

function namesFromJson(json: unknown): string[] {
  if (Array.isArray(json)) {
    return json.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (item && typeof item === "object") return namesFromJson(item);
      return [];
    });
  }
  if (!json || typeof json !== "object") return [];
  const record = json as Record<string, unknown>;
  const found: string[] = [];
  for (const key of ["name", "caption", "sdn_name"]) {
    if (typeof record[key] === "string") found.push(record[key]);
  }
  const properties = record.properties;
  if (properties && typeof properties === "object") {
    const names = (properties as Record<string, unknown>).name;
    if (Array.isArray(names)) found.push(...names.filter((item): item is string => typeof item === "string"));
  }
  for (const key of ["results", "entities", "matches", "data"]) {
    if (record[key]) found.push(...namesFromJson(record[key]));
  }
  return found;
}
