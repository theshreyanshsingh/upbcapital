import { extensionOf, safeBasename } from "@/lib/storage";

const PDF = (bytes: Buffer) => bytes.subarray(0, 5).toString("utf8").startsWith("%PDF");
const PNG = (bytes: Buffer) => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
const JPEG = (bytes: Buffer) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

const MAGIC: Record<string, (bytes: Buffer) => boolean> = {
  pdf: PDF,
  png: PNG,
  jpg: JPEG,
  jpeg: JPEG,
};

export function attachmentName(name: string) {
  return safeBasename(name).replace(/["\r\n]/g, "");
}

export function uploadProblem(name: string, size: number, bytes: Buffer, maxBytes = 15 * 1024 * 1024) {
  if (size <= 0 || bytes.length === 0) return "Choose a file.";
  if (size > maxBytes || bytes.length > maxBytes) return "That file is over the size limit.";
  const ext = extensionOf(name);
  if (!ext) return "That file type is not accepted.";
  const check = MAGIC[ext];
  if (check && !check(bytes)) return "The file contents do not match its type.";
  return null;
}
