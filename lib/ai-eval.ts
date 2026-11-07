import fs from "node:fs/promises";
import path from "node:path";
import { activeReader, isReadField, READING_MODES, readLabel, sameRead, type Reader, type ReadingMode } from "@/lib/ai-reading";
import { audit } from "@/lib/audit";
import type { Outcome } from "@/lib/loan-file";
import { prisma } from "@/lib/prisma";
import { clearSettingsCache } from "@/lib/settings";
import { extensionOf, mimeFor } from "@/lib/storage";

// The reader's accuracy test. It reads the labelled files in tests/fixtures/ai-reading, scores each field against
// expected.json, and records the run. The reader goes ON only at 95% or better for the source that is running,
// the bar SitusAMC sets before it releases a reader for secondary-market review.

export const ACCURACY_FLOOR = 0.95;
export const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "ai-reading");

export type EvalLine = { file: string; field: string; expected: string | null; found: string[]; correct: boolean };
export type EvalResult = { source: string; fields: number; correct: number; accuracy: number; lines: EvalLine[] };

type Expected = { files: Record<string, Record<string, string>> };

// A field counts as right when the reader found it, every value it read agrees with the label, and nothing else.
// A field the file doesn't state but the reader read anyway counts against it, so inventing a value costs accuracy.
export async function evaluateReader(reader: Reader, dir = FIXTURE_DIR): Promise<EvalResult> {
  const expected = JSON.parse(await fs.readFile(path.join(dir, "expected.json"), "utf8")) as Expected;
  const lines: EvalLine[] = [];
  for (const [file, fields] of Object.entries(expected.files)) {
    const bytes = await fs.readFile(path.join(dir, file));
    const outcome = await reader.read({ name: file, mime: mimeFor(extensionOf(file) ?? "", "application/octet-stream"), bytes });
    const read = new Map<string, string[]>();
    for (const finding of outcome.findings) read.set(finding.field, [...(read.get(finding.field) ?? []), finding.value]);
    for (const [field, value] of Object.entries(fields)) {
      if (!isReadField(field)) continue;
      const found = read.get(field) ?? [];
      lines.push({ file, field, expected: value, found, correct: found.length > 0 && found.every((item) => sameRead(field, item, value)) });
    }
    for (const [field, found] of read) {
      if (!(field in fields)) lines.push({ file, field, expected: null, found, correct: false });
    }
  }
  const correct = lines.filter((line) => line.correct).length;
  return { source: reader.source, fields: lines.length, correct, accuracy: lines.length ? correct / lines.length : 0, lines };
}

// Runs the test and records it. Only the misses are kept in the row's detail, since those are what the desk reads.
export async function runEval(options: { reader?: Reader; dir?: string } = {}) {
  const result = await evaluateReader(options.reader ?? activeReader(), options.dir);
  const misses = result.lines.filter((line) => !line.correct).slice(0, 60);
  const run = await prisma.aiEvalRun.create({
    data: { source: result.source, fields: result.fields, correct: result.correct, accuracy: result.accuracy, detail: JSON.stringify(misses) },
  });
  return { run, result };
}

export function percent(accuracy: number) {
  return `${(Math.round(accuracy * 1000) / 10).toFixed(1)}%`;
}

// The script's printout: each miss, then the score against the bar.
export function formatEval(result: EvalResult) {
  const out = [`Document reader accuracy test · ${result.source}`];
  for (const line of result.lines.filter((row) => !row.correct)) {
    const found = line.found.length ? line.found.join(" or ") : "nothing";
    out.push(`  miss  ${line.file}  ${readLabel(line.field)}: expected ${line.expected ?? "nothing (the file doesn't state it)"}, read ${found}`);
  }
  out.push(`Field-level accuracy: ${result.correct} of ${result.fields} (${percent(result.accuracy)}). The reader needs ${percent(ACCURACY_FLOOR)} to go on.`);
  return out.join("\n");
}

export function latestEval(source: string) {
  return prisma.aiEvalRun.findFirst({ where: { source }, orderBy: { createdAt: "desc" } });
}

// Why the reader can't go ON yet, or null when its latest test for this source clears the bar.
export function onBlock(run: { accuracy: number; correct: number; fields: number } | null) {
  if (!run) return "The reader hasn't been tested yet. Run npm run ai:eval on the server, then turn it on.";
  if (run.accuracy < ACCURACY_FLOOR) return `The last test scored ${percent(run.accuracy)}, under the ${percent(ACCURACY_FLOOR)} the reader needs to go on.`;
  return null;
}

// The desk's switch. ON waits on the latest test of the reader that is actually running: a model's score doesn't
// carry to the rules reader, or the other way.
export async function setReadingMode(actorId: string, raw: unknown, options: { source?: string } = {}): Promise<Outcome<ReadingMode>> {
  const mode = String(raw ?? "") as ReadingMode;
  if (!(READING_MODES as readonly string[]).includes(mode)) return { ok: false, error: "Pick how the reader runs." };
  const source = options.source ?? activeReader().source;
  const run = await latestEval(source);
  if (mode === "ON") {
    const block = onBlock(run);
    if (block) return { ok: false, error: block };
  }
  await prisma.platformSettings.upsert({ where: { id: "default" }, update: { aiReading: mode }, create: { id: "default", aiReading: mode } });
  clearSettingsCache();
  await audit(actorId, "AI_READING_MODE", "settings", "default", `${mode} · ${source}${run ? ` · last test ${percent(run.accuracy)}` : ""}`);
  return { ok: true, value: mode };
}
