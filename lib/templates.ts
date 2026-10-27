import { DEFAULT_TEMPLATES, TEMPLATE_KEYS, type TemplateKey } from "@/lib/closing-docs";
import { prisma } from "@/lib/prisma";

export async function loadTemplate(key: TemplateKey) {
  const row = await prisma.documentTemplate.findUnique({ where: { key } });
  if (row) return row;
  const fallback = DEFAULT_TEMPLATES[key];
  return prisma.documentTemplate.create({ data: { key, title: fallback.title, body: fallback.body } });
}

export async function loadTemplates() {
  return Promise.all(TEMPLATE_KEYS.map((key) => loadTemplate(key)));
}

export function isTemplateKey(value: string): value is TemplateKey {
  return (TEMPLATE_KEYS as readonly string[]).includes(value);
}
