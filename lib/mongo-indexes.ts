import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";

export type IndexSpec = {
  collection: string;
  name: string;
  key: Record<string, 1>;
  unique?: true;
  partialFilterExpression?: Record<string, { $gt: string }>;
};

type Field = { name: string; column: string; type: string; optional: boolean };

const SCALARS = new Set(["String", "Int", "Float", "Boolean", "DateTime", "Json", "BigInt", "Bytes"]);

function listOf(raw: string) {
  return raw.split(",").map((part) => part.trim()).filter(Boolean);
}

// Prisma's `db push` builds a plain unique index, which MongoDB applies to documents missing the field.
// UPB has optional unique fields (a closing's desk bid, a user's referral code), so those become partial
// indexes over string values. Names follow Prisma's convention so the indexes read the same in Atlas.
export function planIndexes(schema: string): IndexSpec[] {
  const specs: IndexSpec[] = [];
  const enums = new Set([...schema.matchAll(/^enum (\w+) \{/gm)].map((match) => match[1]));
  for (const block of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const model = block[1];
    const lines = block[2].split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("//"));
    const collection = lines.map((line) => line.match(/^@@map\("([^"]+)"\)/)?.[1]).find(Boolean) ?? model;
    const fields = new Map<string, Field>();
    const relationKeys: string[][] = [];
    for (const line of lines) {
      if (line.startsWith("@@")) continue;
      const [name, rawType = ""] = line.split(/\s+/);
      const type = rawType.replace(/[?[\]]/g, "");
      const relation = line.match(/@relation\([^)]*fields:\s*\[([^\]]+)\]/);
      if (relation) relationKeys.push(listOf(relation[1]));
      if (!SCALARS.has(type) && !enums.has(type)) continue;
      const column = line.match(/@map\("([^"]+)"\)/)?.[1] ?? name;
      fields.set(name, { name, column, type, optional: rawType.endsWith("?") });
      if (/@unique\b/.test(line)) specs.push(uniqueSpec(model, collection, [fields.get(name)!]));
    }
    const columns = (names: string[]) => names.map((name) => {
      const field = fields.get(name);
      if (!field) throw new Error(`${model}.${name} is not a scalar field.`);
      return field;
    });
    for (const line of lines) {
      const unique = line.match(/^@@unique\(\[([^\]]+)\](?:.*map:\s*"([^"]+)")?/);
      if (unique) specs.push(uniqueSpec(model, collection, columns(listOf(unique[1])), unique[2]));
      const index = line.match(/^@@index\(\[([^\]]+)\](?:.*map:\s*"([^"]+)")?/);
      if (index) specs.push(plainSpec(model, collection, columns(listOf(index[1])), index[2]));
    }
    // Prisma emulates cascades on MongoDB by querying the foreign key, so every key needs an index.
    for (const keys of relationKeys) {
      if (columns(keys)[0].column === "_id") continue;
      const covered = specs.some((spec) => spec.collection === collection && keys.every((key, at) => Object.keys(spec.key)[at] === columns([key])[0].column));
      if (!covered) specs.push(plainSpec(model, collection, columns(keys)));
    }
  }
  return specs;
}

function uniqueSpec(model: string, collection: string, fields: Field[], name?: string): IndexSpec {
  const spec: IndexSpec = {
    collection,
    name: name ?? `${model}_${fields.map((field) => field.name).join("_")}_key`,
    key: Object.fromEntries(fields.map((field) => [field.column, 1])),
    unique: true,
  };
  const optional = fields.filter((field) => field.optional);
  if (optional.length) {
    const loose = optional.find((field) => field.type !== "String");
    if (loose) throw new Error(`${model}.${loose.name} is an optional ${loose.type} inside a unique index. Only optional strings are supported.`);
    spec.partialFilterExpression = Object.fromEntries(optional.map((field) => [field.column, { $gt: "" }]));
  }
  return spec;
}

function plainSpec(model: string, collection: string, fields: Field[], name?: string): IndexSpec {
  return {
    collection,
    name: name ?? `${model}_${fields.map((field) => field.name).join("_")}_idx`,
    key: Object.fromEntries(fields.map((field) => [field.column, 1])),
  };
}

type ExistingIndex = { name: string; key: Record<string, number>; unique?: boolean; partialFilterExpression?: unknown };

function sameIndex(existing: ExistingIndex, spec: IndexSpec) {
  return (
    JSON.stringify(existing.key) === JSON.stringify(spec.key) &&
    Boolean(existing.unique) === Boolean(spec.unique) &&
    JSON.stringify(existing.partialFilterExpression ?? null) === JSON.stringify(spec.partialFilterExpression ?? null)
  );
}

export async function syncIndexes(prisma: PrismaClient, schemaPath = path.join(process.cwd(), "prisma", "schema.prisma")) {
  const specs = planIndexes(await readFile(schemaPath, "utf8"));
  const collections = [...new Set(specs.map((spec) => spec.collection))];
  const present = (await prisma.$runCommandRaw({ listCollections: 1, nameOnly: true })) as { cursor?: { firstBatch?: { name: string }[] } };
  const names = new Set((present.cursor?.firstBatch ?? []).map((item) => item.name));
  let created = 0;
  for (const collection of collections) {
    // A collection that does not exist yet has no indexes; createIndexes below creates it.
    const listed = names.has(collection)
      ? ((await prisma.$runCommandRaw({ listIndexes: collection })) as { cursor?: { firstBatch?: ExistingIndex[] } })
      : null;
    const existing = listed?.cursor?.firstBatch ?? [];
    for (const spec of specs.filter((item) => item.collection === collection)) {
      const found = existing.find((index) => index.name === spec.name);
      if (found && sameIndex(found, spec)) continue;
      if (found) await prisma.$runCommandRaw({ dropIndexes: collection, index: spec.name });
      const index = { name: spec.name, key: spec.key, ...(spec.unique ? { unique: true } : {}), ...(spec.partialFilterExpression ? { partialFilterExpression: spec.partialFilterExpression } : {}) };
      await prisma.$runCommandRaw({ createIndexes: collection, indexes: [index] });
      created += 1;
    }
  }
  return { indexes: specs.length, created };
}
