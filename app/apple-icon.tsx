import { markImage } from "@/app/icons/mark";

// The home screen icon on iPhone and iPad. iOS rounds the corners itself, so the tile is full bleed.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return markImage(180, "square");
}
