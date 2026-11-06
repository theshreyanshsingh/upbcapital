import { markImage } from "@/app/icons/mark";

// The browser icon, and the 192 and 512 sizes the web app manifest installs from. Served at /icon/32, /icon/192
// and /icon/512.
const SIZES = [32, 192, 512] as const;

export function generateImageMetadata() {
  return SIZES.map((size) => ({ id: String(size), size: { width: size, height: size }, contentType: "image/png" }));
}

export default function Icon({ id }: { id: string }) {
  const size = SIZES.find((value) => String(value) === String(id)) ?? 32;
  return markImage(size, "rounded");
}
