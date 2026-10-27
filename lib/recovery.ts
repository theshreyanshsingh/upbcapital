import { createHash, randomBytes } from "crypto";

export function newRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(4).toString("hex").toUpperCase();
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}

export function hashRecoveryCode(code: string) {
  const normalized = code.replace(/[\s-]/g, "").toUpperCase();
  return createHash("sha256").update(normalized).digest("hex");
}

export function packHashes(codes: string[]) {
  return codes.map(hashRecoveryCode).join(",");
}

export function unpackHashes(packed: string) {
  return packed.split(",").map((item) => item.trim()).filter(Boolean);
}

export function takeRecoveryCode(packed: string, code: string) {
  const hashes = unpackHashes(packed);
  const hash = hashRecoveryCode(code);
  const index = hashes.indexOf(hash);
  if (index < 0) return null;
  hashes.splice(index, 1);
  return hashes.join(",");
}
