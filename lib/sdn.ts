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

export type SanctionEntry = { entry: string; norm: string; sorted: string; padded: string; letters: Uint8Array };

// OFAC lists people as "HERNANDEZ, Jose", so names also compare with their words in order.
function sortTokens(norm: string) {
  return norm.split(" ").sort().join(" ");
}

function letterCounts(norm: string) {
  const counts = new Uint8Array(36);
  for (let at = 0; at < norm.length; at += 1) {
    const code = norm.charCodeAt(at);
    if (code >= 97 && code <= 122) counts[code - 97] += 1;
    else if (code >= 48 && code <= 57) counts[code - 22] += 1;
  }
  return counts;
}

export function indexNames(list: string[]): SanctionEntry[] {
  return list.flatMap((entry) => {
    const norm = normalizeName(entry);
    return norm ? [{ entry, norm, sorted: sortTokens(norm), padded: ` ${norm} `, letters: letterCounts(norm) }] : [];
  });
}

type Candidate = { norm: string; sorted: string; padded: string; tokens: string[]; letters: Uint8Array };

function similarity(name: Candidate, item: SanctionEntry, threshold: number) {
  if (name.norm === item.norm || name.sorted === item.sorted) return 1;
  // Every word of one name inside the other, in any order: "Nicolas Maduro" and "MADURO MOROS, Nicolas".
  // The length floor keeps short list entries such as "CIMEX" from matching anyone who merely contains them.
  // Two-thirds coverage keeps a common pair from matching any long name that happens to hold both words.
  if (Math.min(name.norm.length, item.norm.length) >= 8) {
    const itemTokens = item.norm.split(" ");
    const covers = (shorter: string[], longer: string[], padded: string) =>
      shorter.length <= longer.length && (shorter.length === 1 || shorter.length / longer.length >= 2 / 3) && shorter.every((token) => padded.includes(` ${token} `));
    if (covers(name.tokens, itemTokens, item.padded) || covers(itemTokens, name.tokens, name.padded)) return 0.96;
  }
  const longest = Math.max(name.norm.length, item.norm.length);
  const allowed = (1 - threshold) * longest;
  // Both checks bound the edit distance from below, so most of a long list never pays for computing it.
  if (Math.abs(name.norm.length - item.norm.length) > allowed) return 0;
  let gap = 0;
  for (let at = 0; at < 36; at += 1) gap += Math.abs(name.letters[at] - item.letters[at]);
  if (gap / 2 > allowed) return 0;
  const ratio = (left: string, right: string) => 1 - levenshtein(left, right) / longest;
  return Math.max(ratio(name.norm, item.norm), ratio(name.sorted, item.sorted));
}

export function bestHit(name: string, index: SanctionEntry[], threshold = 0.82) {
  const norm = normalizeName(name);
  if (norm.length < 3) return null;
  const candidate: Candidate = { norm, sorted: sortTokens(norm), padded: ` ${norm} `, tokens: norm.split(" "), letters: letterCounts(norm) };
  let best: { entry: string; score: number } | null = null;
  for (const item of index) {
    const score = similarity(candidate, item, threshold);
    if (!best || score > best.score) best = { entry: item.entry, score };
  }
  if (!best || best.score < threshold) return null;
  return best;
}

export function fuzzyHit(name: string, list: string[], threshold = 0.82) {
  return bestHit(name, indexNames(list), threshold);
}

function csvCells(line: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (char === '"') {
      if (quoted && line[at + 1] === '"') {
        current += '"';
        at += 1;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
    } else current += char;
  }
  cells.push(current.trim());
  return cells;
}

// OFAC's SDN.CSV has no header: id, name, type, program. ALT.CSV adds aliases: id, alias id, kind, alias.
// Vessels and aircraft are skipped. They are not parties to a note, and their short names match real people.
export function parseTreasuryLists(sdnCsv: string, altCsv = "") {
  const names: string[] = [];
  const skipped = new Set<string>();
  for (const line of sdnCsv.split(/\r?\n/)) {
    const [id, name, type] = csvCells(line);
    if (!id || !name || name === "-0-") continue;
    if (type === "vessel" || type === "aircraft") {
      skipped.add(id);
      continue;
    }
    names.push(name);
  }
  for (const line of altCsv.split(/\r?\n/)) {
    const [id, , , alias] = csvCells(line);
    if (id && alias && alias !== "-0-" && !skipped.has(id)) names.push(alias);
  }
  return names;
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
